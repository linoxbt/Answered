import { EventSourceType, OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { Gesture, InputSource } from '@answered/protocol'

export type InputAction =
  | { kind: 'gesture'; g: Gesture; src?: InputSource; idx?: number }
  | { kind: 'foreground' }
  | { kind: 'exit' }

/**
 * Reads the event type out of one envelope.
 *
 * CLICK_EVENT is 0 and protobuf omits zero values on the wire, so a tap arrives
 * with `eventType` undefined. The default must be applied *inside* the envelope
 * check (as in the official template); otherwise audio frames, which carry no
 * input envelope at all, would read as taps.
 */
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

function sourceOf(raw: EventSourceType | undefined): InputSource | undefined {
  switch (raw) {
    case EventSourceType.TOUCH_EVENT_FROM_GLASSES_R:
      return 'right'
    case EventSourceType.TOUCH_EVENT_FROM_GLASSES_L:
      return 'left'
    case EventSourceType.TOUCH_EVENT_FROM_RING:
      return 'ring'
    default:
      return undefined
  }
}

/** Turns one SDK event into what Answered cares about, or null to ignore it. */
export function toInputAction(event: EvenHubEvent): InputAction | null {
  const sys = eventTypeOf(event.sysEvent)
  const text = eventTypeOf(event.textEvent)
  const list = eventTypeOf(event.listEvent)
  const types = [sys, text, list]
  const has = (t: OsEventTypeList) => types.includes(t)

  const src = sourceOf(event.sysEvent?.eventSource)
  const idx = event.listEvent?.currentSelectItemIndex
  const gesture = (g: Gesture): InputAction => ({
    kind: 'gesture',
    g,
    ...(src ? { src } : {}),
    ...(typeof idx === 'number' ? { idx } : {}),
  })

  if (sys === OsEventTypeList.FOREGROUND_ENTER_EVENT) return { kind: 'foreground' }
  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) return { kind: 'exit' }
  // Order matters: check double before single.
  if (has(OsEventTypeList.DOUBLE_CLICK_EVENT)) return gesture('double')
  if (has(OsEventTypeList.LONG_PRESS_EVENT)) return gesture('long')
  if (has(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return gesture('next')
  if (has(OsEventTypeList.SCROLL_TOP_EVENT)) return gesture('prev')
  if (has(OsEventTypeList.CLICK_EVENT)) return gesture('press')
  return null
}
