import type { RecapItem } from './pipeline/clusters.js'
import { sessionClock } from './pipeline/index.js'
import type { Session } from './sessions.js'
import { escapeHtml, messageLink } from './answers/writer.js'

/** Telegram's message limit is 4096 characters; long recaps are cut with a "+N more" line. */
const TELEGRAM_LIMIT = 4000
const MAX_ANSWERED = 25
const MAX_OPEN = 15

function asked(item: RecapItem): string {
  const n = Math.max(item.asks, item.askers)
  return n > 1 ? ` (${n} asked)` : ''
}

function duration(session: Session): string {
  if (session.startedAt == null || session.endedAt == null) return ''
  return sessionClock(session.startedAt, session.endedAt)
}

/**
 * The pinned recap: every answered question with its one-line answer, time and a link to the
 * reply, then everything still open, so nothing is hidden. A template, not a model: it cannot
 * invent anything.
 */
export function recapMessage(session: Session, items: RecapItem[], pageUrl?: string): string {
  const answered = items.filter((i) => i.status === 'answered').sort((a, b) => (a.offsetS ?? 0) - (b.offsetS ?? 0))
  const open = items.filter((i) => i.status !== 'answered').sort((a, b) => b.asks - a.asks)
  const lines: string[] = [
    `<b>Q&amp;A recap: ${escapeHtml(session.chatTitle)}</b>`,
    `${answered.length} of ${items.length} questions answered${duration(session) ? ` in ${duration(session)}` : ''}.`,
  ]

  if (answered.length) {
    lines.push('')
    answered.slice(0, MAX_ANSWERED).forEach((item, i) => {
      const at = sessionClock(0, (item.offsetS ?? 0) * 1000)
      const link = item.replyMessageId ? messageLink(session, item.replyMessageId) : undefined
      const when = link ? `<a href="${link}">${at}</a>` : at
      lines.push(`${i + 1}. <b>${escapeHtml(item.title)}</b>${asked(item)}`)
      lines.push(`   ${escapeHtml(item.summary || 'Answered live')} (${when})`)
    })
    if (answered.length > MAX_ANSWERED) lines.push(`+${answered.length - MAX_ANSWERED} more answered`)
  }

  if (open.length) {
    lines.push('', '<b>Still open</b>')
    for (const item of open.slice(0, MAX_OPEN)) lines.push(`- ${escapeHtml(item.title)}${asked(item)}`)
    if (open.length > MAX_OPEN) lines.push(`+${open.length - MAX_OPEN} more`)
  }

  if (pageUrl) lines.push('', `<a href="${pageUrl}">Full recap</a>`)

  let text = lines.join('\n')
  // Belt and braces for very long titles: never exceed Telegram's limit.
  if (text.length > TELEGRAM_LIMIT) text = `${text.slice(0, TELEGRAM_LIMIT - 20).replace(/<[^>]*$/, '')}\n...`
  return text
}

/** Public recap page (judges can open it). No names: only questions, counts and answers. */
export function recapPage(session: Session, items: RecapItem[]): string {
  const answered = items.filter((i) => i.status === 'answered').sort((a, b) => (a.offsetS ?? 0) - (b.offsetS ?? 0))
  const open = items.filter((i) => i.status !== 'answered').sort((a, b) => b.asks - a.asks)
  const row = (i: RecapItem) =>
    `<li><strong>${escapeHtml(i.title)}</strong><span class="n">${Math.max(i.asks, i.askers)} asked</span>` +
    (i.status === 'answered'
      ? `<p>${escapeHtml(i.summary || 'Answered live')} <time>${sessionClock(0, (i.offsetS ?? 0) * 1000)}</time>${i.manual ? ' <em>marked by host</em>' : ''}</p>`
      : '') +
    '</li>'
  const status = session.status === 'ended' ? `Ended. ${answered.length} of ${items.length} answered${duration(session) ? ` in ${duration(session)}` : ''}.` : 'Live now.'
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Q&amp;A recap: ${escapeHtml(session.chatTitle)}</title>
<style>
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem } h2 { font-size: 1.1rem; margin-top: 2rem }
  ol, ul { padding-left: 1.25rem } li { margin: .75rem 0 } p { margin: .25rem 0 0 }
  .n { color: #666; font-size: .85rem; margin-left: .5rem } time { color: #666; font-size: .85rem }
  footer { margin-top: 3rem; color: #888; font-size: .8rem }
</style></head><body>
<h1>Q&amp;A recap: ${escapeHtml(session.chatTitle)}</h1>
<p>${status}</p>
${answered.length ? `<h2>Answered</h2><ol>${answered.map(row).join('')}</ol>` : ''}
${open.length ? `<h2>Still open</h2><ul>${open.map(row).join('')}</ul>` : ''}
<footer>Answered: the host answers out loud on Even Realities G2; everyone who asked gets the reply. Audio is never stored; transcripts are deleted when the session ends.</footer>
</body></html>`
}
