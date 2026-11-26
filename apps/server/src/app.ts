import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import pino from 'pino'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import type { Bot } from 'grammy'
import type { Config } from './config.js'
import { openDb, type Db } from './db/index.js'
import { telegramRoutes } from './routes/telegram.js'
import { SessionService } from './sessions.js'
import { registerHandlers } from './telegram/handlers.js'
import { Outbox } from './telegram/outbox.js'
import { GlassesHub, glassesRoutes } from './ws/glasses.js'

export interface AppDeps {
  bot?: Bot
  /** Shared logger, so the bot and the server log through the same instance. */
  logger?: FastifyBaseLogger
  /** Override for tests (fake clock). */
  outbox?: Outbox
  now?: () => number
}

/** Pino logger whose request serializer hides the glasses token in query strings. */
export function createLogger(level: Config['LOG_LEVEL']): FastifyBaseLogger {
  return pino({
    level,
    serializers: {
      req: (req: { method: string; url: string }) => ({
        method: req.method,
        url: req.url.replace(/token=[^&]*/g, 'token=***'),
      }),
    },
  })
}

export interface App {
  app: FastifyInstance
  hub: GlassesHub
  db: Db
  sessions: SessionService
  outbox: Outbox
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const app = Fastify({ loggerInstance: deps.logger ?? createLogger(config.LOG_LEVEL) })

  await app.register(cors, { origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') })
  await app.register(websocket, { options: { maxPayload: 1 << 20 } })

  const hub = new GlassesHub(app.log)
  const db = openDb(config.DATABASE_URL)
  const sessions = new SessionService(db, deps.now)
  const outbox =
    deps.outbox ??
    new Outbox({ onRateLimited: (i) => app.log.warn(i, 'telegram rate limit hit; outbox paused') })

  // Until pairing ties glasses to a host (phase 5), the glasses follow whichever session is live.
  sessions.onEvent((e) => {
    if (e.type === 'started') {
      hub.show({ view: 'queue', clock: '00:00', open: 0, items: [], group: e.session.chatTitle })
    } else {
      hub.show({ view: 'ended', answered: e.stats.answered, open: e.stats.open })
    }
  })

  if (deps.bot) registerHandlers(deps.bot, { sessions, outbox, log: app.log, now: deps.now })

  app.get('/health', async () => ({
    ok: true,
    telegram: Boolean(deps.bot),
    glasses: hub.size,
    uptime_s: Math.round(process.uptime()),
  }))

  await app.register(telegramRoutes, { secret: config.TG_WEBHOOK_SECRET, bot: deps.bot })
  await app.register(glassesRoutes, { hub, devToken: config.GLASSES_DEV_TOKEN })

  app.addHook('onClose', async () => {
    hub.closeAll()
    db.close()
  })

  return { app, hub, db, sessions, outbox }
}
