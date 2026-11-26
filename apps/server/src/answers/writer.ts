import type { Bot } from 'grammy'
import type { FastifyBaseLogger } from 'fastify'
import type { ClusterStore } from '../pipeline/clusters.js'
import { sessionClock } from '../pipeline/index.js'
import type { Session } from '../sessions.js'
import type { Outbox } from '../telegram/outbox.js'

/** Standard reactions bots may set (✅ is not one of them). */
export const REACTION_TAKEN = '👀'
export const REACTION_ANSWERED = '👍'
/** Mentions per reply; the rest are summed up as "+N others" to keep the message readable. */
export const MAX_MENTIONS = 10
/** Reactions per answer: the 20/min group budget is shared with replies. */
export const MAX_REACTIONS = 15

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Link to a message: t.me/<username>/<id> for public groups, t.me/c/<id without -100>/<id> for private supergroups. */
export function messageLink(session: Pick<Session, 'chatId' | 'chatUsername'>, messageId: number): string | undefined {
  if (session.chatUsername) return `https://t.me/${session.chatUsername}/${messageId}`
  const id = String(session.chatId)
  return id.startsWith('-100') ? `https://t.me/c/${id.slice(4)}/${messageId}` : undefined
}

export function answerText(o: {
  summary: string
  offsetS: number
  askers: Array<{ userId: number; userName: string }>
  /** Every ask including repeats; shown when it is more than the number of people. */
  asks?: number
}): string {
  const clock = sessionClock(0, o.offsetS * 1000)
  const head = o.summary ? `<b>Answered at ${clock}:</b> ${escapeHtml(o.summary)}` : `<b>Answered live at ${clock}.</b>`
  // Anonymous admins and channels post with negative ids: they can't be mentioned.
  const mentionable = o.askers.filter((a) => a.userId > 0)
  const shown = mentionable.slice(0, MAX_MENTIONS).map((a) => `<a href="tg://user?id=${a.userId}">${escapeHtml(a.userName)}</a>`)
  const more = mentionable.length - shown.length
  const people = o.askers.length
  const asks = Math.max(o.asks ?? people, people)
  const asked = asks > people ? ` (asked ${asks} times by ${people} ${people === 1 ? 'person' : 'people'})` : people > 1 ? ` (${people} people asked this)` : ''
  const mentions = shown.length ? `\n${shown.join(', ')}${more > 0 ? ` +${more} others` : ''}${asked}` : asked ? `\n${asked.trim()}` : ''
  return head + mentions
}

/**
 * Writes answers back to the group through the rate-limited outbox: one threaded reply per
 * answered question, then a reaction on each asker's message at low priority.
 */
export class AnswerWriter {
  constructor(
    private readonly o: { bot?: Bot; outbox: Outbox; store: ClusterStore; log: FastifyBaseLogger },
  ) {}

  /** 👀 on the first asker's message: the audience sees their question is being answered. */
  taken(session: Session, clusterId: string): void {
    const first = this.o.store.askers(clusterId)[0]
    if (first) this.react(session.chatId, first.messageId, REACTION_TAKEN)
  }

  /** Posts the answer. Resolves with the reply's message id (undefined without a bot or on failure). */
  async answered(session: Session, clusterId: string, summary: string, offsetS: number): Promise<number | undefined> {
    const bot = this.o.bot
    const askers = this.o.store.askers(clusterId)
    if (!bot || !askers.length) return undefined
    const text = answerText({ summary, offsetS, askers, asks: this.o.store.get(clusterId)?.asks })
    try {
      const reply = await this.o.outbox.enqueue(
        session.chatId,
        () =>
          bot.api.sendMessage(session.chatId, text, {
            parse_mode: 'HTML',
            reply_parameters: { message_id: askers[0]!.messageId, allow_sending_without_reply: true },
            link_preview_options: { is_disabled: true },
          }),
        { label: 'answer' },
      )
      this.o.store.setReplyMessage(clusterId, reply.message_id)
      for (const id of this.o.store.messageIds(clusterId).slice(0, MAX_REACTIONS)) this.react(session.chatId, id, REACTION_ANSWERED)
      return reply.message_id
    } catch (err) {
      this.o.log.error({ err, cluster: clusterId }, 'answer reply failed')
      return undefined
    }
  }

  /** Someone asked a question that was already answered: reply to them with the answer and a link. */
  repeat(session: Session, clusterId: string, messageId: number): void {
    const bot = this.o.bot
    const answer = this.o.store.answer(clusterId)
    if (!bot || !answer) return
    const link = answer.replyMessageId ? messageLink(session, answer.replyMessageId) : undefined
    const when = sessionClock(0, (answer.offsetS ?? 0) * 1000)
    const text =
      `<b>Answered earlier at ${when}:</b> ${escapeHtml(answer.summary ?? 'see the live answer')}` + (link ? `\n<a href="${link}">See the answer</a>` : '')
    this.o.outbox
      .enqueue(
        session.chatId,
        () =>
          bot.api.sendMessage(session.chatId, text, {
            parse_mode: 'HTML',
            reply_parameters: { message_id: messageId, allow_sending_without_reply: true },
            link_preview_options: { is_disabled: true },
          }),
        { label: 'repeat' },
      )
      .catch((err) => this.o.log.warn({ err }, 'repeat reply failed'))
  }

  /** Host flagged a question as spam: its messages are deleted from the group (bot needs Delete rights). */
  spam(session: Session, clusterId: string): void {
    const bot = this.o.bot
    const ids = this.o.store.messageIds(clusterId)
    this.o.store.flag(clusterId)
    this.o.log.info({ cluster: clusterId, messages: ids.length }, 'question flagged as spam')
    if (!bot) return
    for (const id of ids) {
      this.o.outbox
        .enqueue(session.chatId, () => bot.api.deleteMessage(session.chatId, id), { label: 'deleteMessage' })
        .catch((err) => this.o.log.warn({ err, messageId: id }, 'deleting spam failed (is the bot allowed to delete messages?)'))
    }
  }

  private react(chatId: number, messageId: number, emoji: '👀' | '👍'): void {
    const bot = this.o.bot
    if (!bot) return
    this.o.outbox
      .enqueue(chatId, () => bot.api.setMessageReaction(chatId, messageId, [{ type: 'emoji', emoji }]), { priority: 'low', label: 'reaction' })
      // A group can restrict reactions; a missing reaction is cosmetic.
      .catch((err) => this.o.log.debug({ err, messageId }, 'reaction failed'))
  }
}
