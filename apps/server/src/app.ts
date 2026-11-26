import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import pino from 'pino'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import type { Bot } from 'grammy'
import type { Config } from './config.js'
import { openDb, type Db } from './db/index.js'
import { ClaudeClassifier, FallbackClassifier, HeuristicClassifier, type Classifier } from './pipeline/classifier.js'
import { ClusterStore } from './pipeline/clusters.js'
import { Pipeline, QueuePublisher } from './pipeline/index.js'
import { evalRoutes } from './routes/eval.js'
import { debugRoutes } from './routes/debug.js'
import { deepgramFactory } from './speech/deepgram.js'
import { SpeechService } from './speech/index.js'
import type { TranscriberFactory } from './speech/types.js'
import { telegramRoutes } from './routes/telegram.js'
import { SessionService } from './sessions.js'
import { registerHandlers } from './telegram/handlers.js'
import { Outbox } from './telegram/outbox.js'
import { GlassesHub, glassesRoutes } from './ws/glasses.js'

export interface AppDeps {
  bot?: Bot
  /** Shared logger, so the bot and the server log through the same instance. */
  logger?: FastifyBaseLogger
  /** Overrides for tests (fake clock, scripted classifier). */
  outbox?: Outbox
  now?: () => number
  classifier?: Classifier
  transcriber?: TranscriberFactory
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
  store: ClusterStore
  pipeline: Pipeline
  publisher: QueuePublisher
  speech: SpeechService
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const app = Fastify({ loggerInstance: deps.logger ?? createLogger(config.LOG_LEVEL) })

  await app.register(cors, { origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') })
  await app.register(websocket, { options: { maxPayload: 1 << 20 } })

  // `speech` is created below; audio only arrives once the server is listening.
  const hub = new GlassesHub(app.log, (pcm) => speech.audio(pcm))
  const db = openDb(config.DATABASE_URL)
  const sessions = new SessionService(db, deps.now)
  const outbox =
    deps.outbox ??
    new Outbox({ onRateLimited: (i) => app.log.warn(i, 'telegram rate limit hit; outbox paused') })

  const store = new ClusterStore(db, deps.now)
  const classifier =
    deps.classifier ??
    (config.ANTHROPIC_API_KEY
      ? new FallbackClassifier(new ClaudeClassifier(config.ANTHROPIC_API_KEY, config.LLM_CLASSIFY_MODEL), new HeuristicClassifier(), app.log)
      : new HeuristicClassifier())
  app.log.info({ classifier: classifier.name }, 'question classifier')

  // Until pairing ties glasses to a host (phase 5), the glasses follow whichever session is live.
  const publisher = new QueuePublisher({ store, sessions, show: (screen) => hub.show(screen), now: deps.now })
  const pipeline = new Pipeline({
    classifier,
    store,
    sessions,
    log: app.log,
    batchMs: config.CLASSIFY_BATCH_MS,
    onQueueChanged: (sessionId) => publisher.changed(sessionId),
  })

  sessions.onEvent((e) => {
    if (e.type === 'started') {
      publisher.publishNow(e.session.id)
    } else {
      publisher.forget(e.session.id)
      hub.show({ view: 'ended', answered: e.stats.answered, open: e.stats.open })
    }
  })

  const transcriber =
    deps.transcriber ??
    (config.DEEPGRAM_API_KEY
      ? deepgramFactory({ apiKey: config.DEEPGRAM_API_KEY, url: config.DEEPGRAM_URL, keyterms: config.STT_KEYTERMS, log: app.log })
      : undefined)
  const speech = new SpeechService({ db, sessions, log: app.log, factory: transcriber, now: deps.now })
  app.log.info({ speech: transcriber ? 'deepgram' : 'off' }, 'speech to text')

  // After a restart or redeploy mid-session: classify what arrived meanwhile and restore the queue screen.
  for (const session of sessions.live()) {
    pipeline.captured(session.id)
    publisher.publishNow(session.id)
    app.log.info({ session: session.id, chat: session.chatId }, 'resumed live session')
  }

  if (deps.bot) registerHandlers(deps.bot, { sessions, outbox, store, pipeline, publisher, log: app.log, now: deps.now })

  app.get('/health', async () => ({
    ok: true,
    telegram: Boolean(deps.bot),
    glasses: hub.size,
    uptime_s: Math.round(process.uptime()),
  }))

  await app.register(telegramRoutes, { secret: config.TG_WEBHOOK_SECRET, bot: deps.bot })
  await app.register(glassesRoutes, { hub, devToken: config.GLASSES_DEV_TOKEN })
  await app.register(debugRoutes, { devToken: config.GLASSES_DEV_TOKEN, sessions, speech })
  await app.register(evalRoutes, { classifier, devToken: config.GLASSES_DEV_TOKEN, fixturesPath: config.FIXTURES_PATH })

  app.addHook('onClose', async () => {
    pipeline.stop()
    await speech.close()
    hub.closeAll()
    db.close()
  })

  return { app, hub, db, sessions, outbox, store, pipeline, publisher, speech }
}
