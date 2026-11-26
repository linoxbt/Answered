import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Bot } from 'grammy'
import type { Update } from 'grammy/types'
import { updateKind } from '../telegram/bot.js'

export interface TelegramRouteOptions {
  secret: string | undefined
  bot: Bot | undefined
}

function secretMatches(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function telegramRoutes(app: FastifyInstance, opts: TelegramRouteOptions): Promise<void> {
  app.post('/tg/webhook', async (req, reply) => {
    if (!opts.secret) return reply.code(503).send({ error: 'telegram not configured' })
    if (!secretMatches(opts.secret, req.headers['x-telegram-bot-api-secret-token'])) {
      return reply.code(401).send({ error: 'bad secret' })
    }

    const update = req.body as Update | undefined
    if (!update || typeof update.update_id !== 'number') {
      return reply.code(400).send({ error: 'not an update' })
    }

    if (!opts.bot) {
      req.log.info({ update_id: update.update_id, kind: updateKind(update) }, 'telegram update (no bot configured)')
      return reply.send({ ok: true })
    }

    // Always answer 200: a non-2xx makes Telegram redeliver the same update repeatedly.
    // Handler errors are logged by bot.catch.
    await opts.bot.handleUpdate(update)
    return reply.send({ ok: true })
  })
}
