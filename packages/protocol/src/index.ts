// Messages exchanged over WS /ws/glasses.
//
// The server owns all state. The glasses send raw PCM audio as binary frames
// and gestures as JSON; the server answers with the screen to show.

/** Gestures the glasses forward. The server decides what each means on the current screen. */
export type Gesture = 'press' | 'double' | 'next' | 'prev' | 'long'

/** Where a gesture came from (SDK `EventSourceType`). */
export type InputSource = 'right' | 'left' | 'ring' | 'unknown'

// ---- glasses -> server (JSON text frames; audio goes as binary frames) ----

export type ClientMessage =
  | { t: 'hello'; app: string; version: string; mic: MicSource }
  | { t: 'input'; g: Gesture; src?: InputSource; idx?: number }
  | { t: 'resume' }

export type MicSource = 'glasses' | 'phone'

// ---- server -> glasses ----

export interface QueueItem {
  id: string
  /** Number of people who asked. */
  n: number
  title: string
}

export type Screen =
  | { view: 'status'; title: string; lines: string[] }
  | { view: 'pair'; code: string; url: string }
  | { view: 'lobby'; group: string; waiting: number }
  | { view: 'queue'; clock: string; open: number; items: QueueItem[]; group?: string }
  | { view: 'taking'; id: string; n: number; title: string }
  | { view: 'sending'; n: number; summary: string; seconds: number }
  | { view: 'answered'; n: number; summary: string }
  | { view: 'still_open' }
  | { view: 'ended'; answered: number; open: number }

export type ServerMessage =
  | ({ t: 'screen' } & Screen)
  | { t: 'audio'; on: boolean; source?: MicSource }
  | { t: 'exit' }

export type View = Screen['view']

/** PCM format of every binary audio frame: s16le, 16 kHz, mono. */
export const AUDIO_FORMAT = { encoding: 'linear16', sampleRate: 16000, channels: 1 } as const

/** Glasses display limits that the server must respect when building screens. */
export const DISPLAY = {
  width: 576,
  height: 288,
  /** Max characters per list item. */
  listItemChars: 64,
  /** Max list items. */
  listItems: 20,
} as const

export function parseClientMessage(raw: string): ClientMessage | null {
  let msg: unknown
  try {
    msg = JSON.parse(raw)
  } catch {
    return null
  }
  if (!msg || typeof msg !== 'object' || !('t' in msg)) return null
  const m = msg as Record<string, unknown>
  switch (m.t) {
    case 'hello':
      return typeof m.app === 'string' && typeof m.version === 'string' && (m.mic === 'glasses' || m.mic === 'phone')
        ? { t: 'hello', app: m.app, version: m.version, mic: m.mic }
        : null
    case 'input': {
      const gestures: Gesture[] = ['press', 'double', 'next', 'prev', 'long']
      if (!gestures.includes(m.g as Gesture)) return null
      const sources: InputSource[] = ['right', 'left', 'ring', 'unknown']
      return {
        t: 'input',
        g: m.g as Gesture,
        ...(sources.includes(m.src as InputSource) ? { src: m.src as InputSource } : {}),
        ...(Number.isInteger(m.idx) ? { idx: m.idx as number } : {}),
      }
    }
    case 'resume':
      return { t: 'resume' }
    default:
      return null
  }
}

/**
 * The display's single font drops unsupported characters silently, so screens
 * use plain ASCII. This replaces common typographic characters and strips the rest.
 */
export function toDisplayAscii(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/…/g, '...')
    .normalize('NFKD')
    .replace(/[^\x20-\x7E\n]/g, '')
}
