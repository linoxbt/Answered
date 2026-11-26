import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import pino from 'pino'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import type { Bot } from 'grammy'
import type { Config } from './config.js'
import { telegramRoutes } from './routes/telegram.js'
import { GlassesHub, glassesRoutes } from './ws/glasses.js'

export interface AppDeps {
  bot?: Bot
  /** Shared logger, so the bot and the server log through the same instance. */
  logger?: FastifyBaseLogger
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
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const app = Fastify({ loggerInstance: deps.logger ?? createLogger(config.LOG_LEVEL) })

  await app.register(cors, { origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') })
  await app.register(websocket, { options: { maxPayload: 1 << 20 } })

  const hub = new GlassesHub(app.log)

  app.get('/health', async () => ({
    ok: true,
    telegram: Boolean(deps.bot),
    glasses: hub.size,
    uptime_s: Math.round(process.uptime()),
  }))

  await app.register(telegramRoutes, { secret: config.TG_WEBHOOK_SECRET, bot: deps.bot })
  await app.register(glassesRoutes, { hub, devToken: config.GLASSES_DEV_TOKEN })

  app.addHook('onClose', async () => hub.closeAll())

  return { app, hub }
}
