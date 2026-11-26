import type { Bot, Context } from 'grammy'
import type { FastifyBaseLogger } from 'fastify'
import type { SessionService } from '../sessions.js'
import type { Outbox } from './outbox.js'

export interface HandlerDeps {
  sessions: SessionService
  outbox: Outbox
  log: FastifyBaseLogger
  now?: () => number
}

export const TEXT = {
  opening: 'Live Q&A has started. Ask your question here.\nQuestions asked by several people get answered first.',
  alreadyLive: 'A live Q&A is already running here. Send /end to close it.',
  notLive: 'There is no live Q&A in this group. An admin can start one with /live.',
  adminsOnly: 'Only group admins can start or end a live Q&A.',
  groupsOnly: 'Add me to a group, make me an admin, then send /live there to start a Q&A.',
  addedNeedsAdmin:
    'Thanks for adding Answered. Make me an admin (with Pin messages and Delete messages) so I can read questions, see reactions and pin the recap. Then an admin can send /live.',
  promoted: 'Answered is ready. An admin can send /live to start a Q&A.',
  ended: (questions: number, answered: number) =>
    `Live Q&A ended. ${answered} of ${questions} questions answered.\nThanks for asking!`,
} as const

const ADMIN_STATUSES = new Set(['creator', 'administrator'])

function isGroup(ctx: Context): boolean {
  return ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'
}

/** Display name of whoever sent the message; anonymous admins post as the group itself. */
export function senderOf(ctx: Context): { id: number; name: string } | undefined {
  const senderChat = ctx.msg?.sender_chat
  if (senderChat) return { id: senderChat.id, name: 'title' in senderChat ? (senderChat.title ?? 'Admin') : 'Admin' }
  const from = ctx.from
  if (!from) return undefined
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || `user ${from.id}`
  return { id: from.id, name }
}

async function isAdmin(ctx: Context): Promise<boolean> {
  const chat = ctx.chat
  if (!chat) return false
  // Anonymous admins post on behalf of the group itself.
  if (ctx.msg?.sender_chat?.id === chat.id) return true
  if (!ctx.from) return false
  const member = await ctx.api.getChatMember(chat.id, ctx.from.id)
  return ADMIN_STATUSES.has(member.status)
}

export function registerHandlers(bot: Bot, deps: HandlerDeps): void {
  const { sessions, outbox, log } = deps
  const now = deps.now ?? Date.now

  /**
   * Sends a plain-text message through the rate-limited outbox. Handlers never await it:
   * the webhook must answer Telegram quickly or the update is delivered again.
   */
  const send = (chatId: number, text: string, replyTo?: number) =>
    outbox.enqueue(
      chatId,
      () =>
        bot.api.sendMessage(chatId, text, {
          ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}),
          link_preview_options: { is_disabled: true },
        }),
      { label: 'sendMessage' },
    )
  const say = (chatId: number, text: string, replyTo?: number): void => {
    send(chatId, text, replyTo).catch((err) => log.warn({ err, chat: chatId }, 'sendMessage failed'))
  }

  bot.command('start', async (ctx) => {
    if (!isGroup(ctx)) await ctx.reply(TEXT.groupsOnly)
  })

  bot.command('live', async (ctx) => {
    if (!isGroup(ctx)) return void (await ctx.reply(TEXT.groupsOnly))
    const chat = ctx.chat
    if (!(await isAdmin(ctx))) return say(chat.id, TEXT.adminsOnly, ctx.msg.message_id)

    const sender = senderOf(ctx)!
    const { session, created } = sessions.start({
      chatId: chat.id,
      chatTitle: 'title' in chat ? (chat.title ?? 'Group') : 'Group',
      chatUsername: 'username' in chat ? chat.username : undefined,
      host: { tgUserId: sender.id, name: sender.name },
    })
    if (!created) return say(chat.id, TEXT.alreadyLive, ctx.msg.message_id)

    log.info({ session: session.id, chat: chat.id }, 'session live')
    send(chat.id, TEXT.opening)
      .then((m) => sessions.setOpeningMessage(session.id, m.message_id))
      .catch((err) => log.warn({ err, chat: chat.id }, 'opening message failed'))
  })

  bot.command('end', async (ctx) => {
    if (!isGroup(ctx)) return
    const chat = ctx.chat
    if (!(await isAdmin(ctx))) return say(chat.id, TEXT.adminsOnly, ctx.msg.message_id)
    const result = sessions.end(chat.id)
    if (!result) return say(chat.id, TEXT.notLive, ctx.msg.message_id)
    log.info({ session: result.session.id, ...result.stats }, 'session ended')
    // Phase 6 replaces this with the pinned recap.
    say(chat.id, TEXT.ended(result.stats.clusters, result.stats.answered))
  })

  // Capture every other text message (and captions) while a session is live.
  bot.on(['message:text', 'message:caption'], (ctx) => {
    if (!isGroup(ctx)) return
    const text = ctx.msg.text ?? ctx.msg.caption ?? ''
    if (text.startsWith('/')) return
    if (ctx.from?.is_bot && !ctx.msg.sender_chat) return
    const sender = senderOf(ctx)
    if (!sender) return
    const session = sessions.capture(ctx.chat.id, {
      messageId: ctx.msg.message_id,
      userId: sender.id,
      userName: sender.name,
      text,
      replyTo: ctx.msg.reply_to_message?.message_id,
      at: ctx.msg.date * 1000,
    })
    if (session) log.debug({ session: session.id, message: ctx.msg.message_id }, 'message captured')
  })

  bot.on(['edited_message:text', 'edited_message:caption'], (ctx) => {
    const text = ctx.editedMessage.text ?? ctx.editedMessage.caption ?? ''
    if (sessions.edit(ctx.chat.id, ctx.editedMessage.message_id, text, (ctx.editedMessage.edit_date ?? now() / 1000) * 1000)) {
      log.debug({ message: ctx.editedMessage.message_id }, 'captured message edited')
    }
  })

  // A basic group upgraded to a supergroup gets a new chat id.
  bot.on('message:migrate_to_chat_id', (ctx) => {
    sessions.migrateChat(ctx.chat.id, ctx.msg.migrate_to_chat_id)
    log.info({ from: ctx.chat.id, to: ctx.msg.migrate_to_chat_id }, 'group migrated to supergroup')
  })

  bot.on('my_chat_member', (ctx) => {
    const { old_chat_member: before, new_chat_member: after, chat } = ctx.myChatMember
    log.info({ chat: chat.id, from: before.status, to: after.status }, 'bot membership changed')
    if (chat.type !== 'group' && chat.type !== 'supergroup') return
    if (after.status === 'left' || after.status === 'kicked') {
      sessions.end(chat.id)
      return
    }
    const wasIn = before.status !== 'left' && before.status !== 'kicked'
    if (after.status === 'administrator' && before.status !== 'administrator') say(chat.id, TEXT.promoted)
    else if (after.status === 'member' && !wasIn) say(chat.id, TEXT.addedNeedsAdmin)
  })

  // Read in later phases (votes, opt-in DMs); logged so the webhook can be checked now.
  bot.on(['message_reaction', 'message_reaction_count', 'callback_query'], (ctx) => {
    log.debug({ kind: Object.keys(ctx.update).find((k) => k !== 'update_id') }, 'update noted for later phases')
  })
}
