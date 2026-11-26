import {
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { toDisplayAscii, type Screen } from '@answered/protocol'

const MAIN = { id: 1, name: 'main' } as const

/** Writes over BLE are slow; coalesce bursts of updates (the ASR template uses 120 ms). */
const DEBOUNCE_MS = 120

/**
 * Phase 0 display: one full-screen text container that captures input.
 * Phase 5 adds the list container for the queue and decides between
 * textContainerUpgrade (same layout) and rebuildPageContainer (layout change).
 */
export class Display {
  private pending?: string
  private shown?: string
  private timer?: ReturnType<typeof setTimeout>
  private writing = false

  constructor(private readonly bridge: EvenAppBridge) {}

  async init(initial: string): Promise<boolean> {
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: [
          new TextContainerProperty({
            xPosition: 0,
            yPosition: 0,
            width: 576,
            height: 288,
            borderWidth: 0,
            borderColor: 5,
            paddingLength: 8,
            containerID: MAIN.id,
            containerName: MAIN.name,
            content: toDisplayAscii(initial),
            isEventCapture: 1,
          }),
        ],
      }),
    )
    this.shown = initial
    return result === 0
  }

  setText(text: string): void {
    this.pending = toDisplayAscii(text)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.flush(), DEBOUNCE_MS)
  }

  render(screen: Screen): void {
    this.setText(screenToText(screen))
  }

  private async flush(): Promise<void> {
    // One write in flight at a time; a newer pending text wins.
    if (this.writing || this.pending === undefined) return
    const content = this.pending
    this.pending = undefined
    if (content === this.shown) return
    this.writing = true
    try {
      await this.bridge.textContainerUpgrade(
        new TextContainerUpgrade({ containerID: MAIN.id, containerName: MAIN.name, content }),
      )
      this.shown = content
    } finally {
      this.writing = false
      if (this.pending !== undefined) void this.flush()
    }
  }
}

/** Plain-text rendering of every screen; enough for phase 0, replaced view by view in phase 5. */
export function screenToText(s: Screen): string {
  switch (s.view) {
    case 'status':
      return [s.title, '', ...s.lines].join('\n')
    case 'pair':
      return `ANSWERED\n\nPair code ${s.code}\nOpen ${s.url}`
    case 'lobby':
      return `Group: ${s.group}\n${s.waiting} questions waiting\n\nDouble-press to go live`
    case 'queue':
      return [
        `LIVE ${s.clock} | ${s.open} open`,
        ...(s.items.length
          ? s.items.slice(0, 5).map((i) => `${i.n} | ${i.title}`)
          : ['', s.group ? `Listening in ${s.group}` : 'Listening', 'Waiting for questions...']),
      ].join('\n')
    case 'taking':
      return `TAKING | ${s.n} asked\n${s.title}\n\n> listening...`
    case 'sending':
      return `Sending to ${s.n} in ${s.seconds}s\n${s.summary}\n\nPress: send now | Swipe: cancel`
    case 'answered':
      return `[OK] Sent to ${s.n}\n${s.summary}`
    case 'still_open':
      return 'Still open\nSay more, or swipe to skip'
    case 'ended':
      return `Session ended\n${s.answered} answered | ${s.open} still open`
  }
}
