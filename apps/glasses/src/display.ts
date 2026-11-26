import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  formatEvenHubPageContainerValidationError,
  validateEvenHubPageContainer,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { toDisplayAscii, type Screen } from '@answered/protocol'

const W = 576
const H = 288
const HEADER_H = 40
const TEXT = { id: 1, name: 'main' } as const
const HEADER = { id: 1, name: 'header' } as const
const LIST = { id: 2, name: 'queue' } as const

/** Writes over BLE are slow; coalesce bursts of text updates (the ASR template uses 120 ms). */
const DEBOUNCE_MS = 120

export type Layout = 'text' | 'list'

/**
 * Two layouts on the 576x288 display:
 *  - text: one full-screen text container that captures input (every screen except a non-empty queue);
 *  - list: a header line plus the native list for the queue, so the ring scrolls it on the glasses.
 * A list's items can only change with a full page rebuild (which flickers), so the server sends a
 * new queue at most every 5 s; the header and text screens update in place.
 */
export class Display {
  layout: Layout = 'text'
  private shownText?: string
  private shownHeader?: string
  private shownItems?: string
  private pendingText?: string
  private timer?: ReturnType<typeof setTimeout>
  /** All bridge writes run one at a time, in order. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly bridge: EvenAppBridge) {}

  async init(initial: string): Promise<boolean> {
    const content = toDisplayAscii(initial)
    const page = new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [textContainer(content)] })
    const result = await this.bridge.createStartUpPageContainer(page)
    this.shownText = content
    return result === 0
  }

  /** Plain text on the text layout (status messages from the app itself). */
  setText(text: string): void {
    this.pendingText = toDisplayAscii(text)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.enqueue(() => this.flushText()), DEBOUNCE_MS)
  }

  render(screen: Screen): void {
    if (screen.view === 'queue' && screen.items.length) {
      const header = toDisplayAscii(`LIVE ${screen.clock} | ${screen.open} open | press = take`)
      const items = screen.items.slice(0, 20).map((i) => toDisplayAscii(`${i.n} | ${i.title}`).slice(0, 64))
      clearTimeout(this.timer)
      this.pendingText = undefined
      this.enqueue(() => this.showList(header, items))
      return
    }
    this.setText(screenToText(screen))
  }

  private enqueue(job: () => Promise<unknown>): void {
    this.chain = this.chain.then(job).catch((err) => console.warn('display update failed', err))
  }

  private async flushText(): Promise<void> {
    const content = this.pendingText
    this.pendingText = undefined
    if (content === undefined) return
    if (this.layout !== 'text') {
      await this.rebuild(new RebuildPageContainer({ containerTotalNum: 1, textObject: [textContainer(content)] }))
      this.layout = 'text'
      this.shownItems = this.shownHeader = undefined
    } else if (content !== this.shownText) {
      await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: TEXT.id, containerName: TEXT.name, content }))
    }
    this.shownText = content
  }

  private async showList(header: string, items: string[]): Promise<void> {
    const signature = items.join('\n')
    if (this.layout === 'list' && signature === this.shownItems) {
      // Same questions: only the header (clock, open count) changes, in place and without flicker.
      if (header !== this.shownHeader) {
        await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: HEADER.id, containerName: HEADER.name, content: header }))
        this.shownHeader = header
      }
      return
    }
    await this.rebuild(
      new RebuildPageContainer({
        containerTotalNum: 2,
        textObject: [
          new TextContainerProperty({
            xPosition: 0, yPosition: 0, width: W, height: HEADER_H,
            borderWidth: 0, borderColor: 5, paddingLength: 6,
            containerID: HEADER.id, containerName: HEADER.name, content: header, isEventCapture: 0,
          }),
        ],
        listObject: [
          new ListContainerProperty({
            xPosition: 0, yPosition: HEADER_H, width: W, height: H - HEADER_H,
            borderWidth: 0, borderColor: 5, paddingLength: 4,
            containerID: LIST.id, containerName: LIST.name, isEventCapture: 1,
            itemContainer: new ListItemContainerProperty({ itemCount: items.length, itemWidth: W - 8, isItemSelectBorderEn: 1, itemName: items }),
          }),
        ],
      }),
    )
    this.layout = 'list'
    this.shownItems = signature
    this.shownHeader = header
    this.shownText = undefined
  }

  private async rebuild(page: RebuildPageContainer): Promise<void> {
    const check = validateEvenHubPageContainer(page)
    if (!check.valid) console.warn('invalid page', formatEvenHubPageContainerValidationError(check))
    await this.bridge.rebuildPageContainer(page)
  }
}

function textContainer(content: string): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: 0, yPosition: 0, width: W, height: H,
    borderWidth: 0, borderColor: 5, paddingLength: 8,
    containerID: TEXT.id, containerName: TEXT.name, content, isEventCapture: 1,
  })
}

/** Text for every screen except a non-empty queue (which uses the list layout). */
export function screenToText(s: Screen): string {
  switch (s.view) {
    case 'status':
      return [s.title, '', ...s.lines].join('\n')
    case 'pair':
      return ['ANSWERED', '', `Pair code  ${s.code}`, '', 'In your Telegram group, an admin sends:', `/pair ${s.code}`].join('\n')
    case 'lobby':
      return ['ANSWERED', `Group: ${s.group}`, '', 'Press: go live', 'Long press: unpair  |  Double: exit'].join('\n')
    case 'queue':
      if (!s.items.length) return [`LIVE ${s.clock} | 0 open`, '', s.group ? `Listening in ${s.group}` : 'Listening', 'Waiting for questions...', '', 'Double: end session'].join('\n')
      return [`LIVE ${s.clock} | ${s.open} open`, ...s.items.slice(0, 5).map((i, k) => `${k === (s.selected ?? 0) ? '>' : ' '}${i.n} | ${i.title}`)].join('\n')
    case 'taking':
      return [`TAKING | ${s.n} asked`, s.title, '', '> listening...', '', 'Press: answered | Swipe: skip | Double: back'].join('\n')
    case 'sending':
      return [`Sending to ${s.n} in ${s.seconds}s`, s.summary, '', 'Press: send now | Swipe: cancel'].join('\n')
    case 'answered':
      return [`[OK] Sent to ${s.n}`, s.summary].join('\n')
    case 'still_open':
      return ['Still open', 'Say more, press if answered,', 'or swipe to skip'].join('\n')
    case 'confirm_end':
      return ['End the session?', `${s.open} questions still open`, '', 'Double: end and post the recap', 'Press: keep going'].join('\n')
    case 'ended':
      return ['Session ended', `${s.answered} answered | ${s.open} still open`, '', 'Press to continue'].join('\n')
  }
}
