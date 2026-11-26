import { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import type { FastifyBaseLogger } from 'fastify'

/**
 * The updates Answered reads (see the spec's "What the bot reads").
 * Reaction updates only arrive when they are listed here AND the bot is a group admin.
 */
export const ALLOWED_UPDATES = [
  'message',
  'edited_message',
  'message_reaction',
  'message_reaction_count',
  'callback_query',
  'my_chat_member',
] as const satisfies ReadonlyArray<Exclude<keyof Update, 'update_id'>>

/** Short label of what an update carries, for logs. */
export function updateKind(update: Update): string {
  const key = Object.keys(update).find((k) => k !== 'update_id')
  return key ?? 'unknown'
}

export function createBot(token: string, log: FastifyBaseLogger): Bot {
  const bot = new Bot(token)

  // Phase 0: log every update so the webhook can be checked against a real group.
  // Message text is logged at debug level only.
  bot.use(async (ctx, next) => {
    const chat = ctx.chat
    log.info(
      {
        update_id: ctx.update.update_id,
        kind: updateKind(ctx.update),
        chat: chat ? { id: chat.id, type: chat.type, title: 'title' in chat ? chat.title : undefined } : undefined,
        from: ctx.from?.id,
      },
      'telegram update',
    )
    if (ctx.msg?.text) log.debug({ text: ctx.msg.text }, 'telegram message text')
    await next()
  })

  bot.command('ping', (ctx) => ctx.reply('pong - Answered is listening.'))

  bot.catch((err) => {
    log.error({ err: err.error, update_id: err.ctx.update.update_id }, 'telegram handler failed')
  })

  return bot
}
