import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import pino from 'pino'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import type { Bot } from 'grammy'
import type { Screen } from '@answered/protocol'
import type { Config } from './config.js'
import { openDb, type Db } from './db/index.js'
import { ClaudeClassifier, FallbackClassifier, HeuristicClassifier, type Classifier } from './pipeline/classifier.js'
import { ClusterStore } from './pipeline/clusters.js'
import { Pipeline, QueuePublisher } from './pipeline/index.js'
import { evalRoutes } from './routes/eval.js'
import { debugRoutes } from './routes/debug.js'
import { deepgramFactory } from './speech/deepgram.js'
import { HostController } from './answers/controller.js'
import { ClaudeJudge, type Judge } from './answers/judge.js'
import { AnswerWriter } from './answers/writer.js'
import { SpeechService } from './speech/index.js'
import type { TranscriberFactory } from './speech/types.js'
import { telegramRoutes } from './routes/telegram.js'
import { SessionService } from './sessions.js'
import { registerHandlers } from './telegram/handlers.js'
import { Outbox } from './telegram/outbox.js'
import { DEV, GlassesHub, glassesRoutes, type Viewer } from './ws/glasses.js'
import { HostDirectory } from './hosts.js'
import { recapPage } from './recap.js'
import type { Session } from './sessions.js'

export interface AppDeps {
  bot?: Bot
  /** Shared logger, so the bot and the server log through the same instance. */
  logger?: FastifyBaseLogger
  /** Overrides for tests (fake clock, scripted classifier). */
  outbox?: Outbox
  now?: () => number
  classifier?: Classifier
  transcriber?: TranscriberFactory
  judge?: Judge
  undoMs?: number
  flashMs?: number
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
  controller: HostController
  hosts: HostDirectory
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<App> {
  const app = Fastify({ loggerInstance: deps.logger ?? createLogger(config.LOG_LEVEL) })

  await app.register(cors, { origin: config.CORS_ORIGIN === '*' ? true : config.CORS_ORIGIN.split(',') })
  await app.register(websocket, { options: { maxPayload: 1 << 20 } })

  const db = openDb(config.DATABASE_URL)
  const sessions = new SessionService(db, deps.now)
  const hosts = new HostDirectory(db, deps.now)

  // Routing between glasses and sessions. A paired host's glasses follow their group's open session;
  // the dev token (test scripts) follows the newest live session.
  const sessionFor = (viewer: Viewer): Session | undefined => {
    if (viewer === DEV) return sessions.active()
    const host = hosts.get(viewer)
    return host ? sessions.open(host.chatId) : undefined
  }
  const viewersOf = (session: Session): Viewer[] => [DEV, ...hosts.forChat(session.chatId).map((h) => h.id)]
  const showSession = (sessionId: string, screen: Screen) => {
    const session = sessions.get(sessionId)
    if (session) hub.show(screen, viewersOf(session))
  }

  // `speech` and `controller` are created below; the hub only calls them once the server is listening.
  const hub = new GlassesHub(app.log, {
    audio: (pcm, viewer) => {
      const session = sessionFor(viewer)
      if (session?.status === 'live') speech.audio(pcm, session)
    },
    input: (g, idx, viewer) => controller.input(g, idx, viewer),
    screenFor: (viewer) => {
      const session = sessionFor(viewer)
      if (session?.status === 'live') return controller.screen(session.id)
      const host = viewer === DEV ? undefined : hosts.get(viewer)
      return host ? { view: 'lobby', group: host.chatTitle } : undefined
    },
  })
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

  const publisher = new QueuePublisher({ store, sessions, show: (screen, sessionId) => showSession(sessionId, screen), now: deps.now })
  const pipeline = new Pipeline({
    classifier,
    store,
    sessions,
    log: app.log,
    batchMs: config.CLASSIFY_BATCH_MS,
    onQueueChanged: (sessionId) => publisher.changed(sessionId),
    onAnsweredRepeat: (sessionId, clusterId, messageId) => {
      const session = sessions.get(sessionId)
      if (session) writer.repeat(session, clusterId, messageId)
    },
  })
  const writer = new AnswerWriter({ bot: deps.bot, outbox, store, log: app.log })

  sessions.onEvent((e) => {
    if (e.type === 'started') {
      publisher.publishNow(e.session.id)
    } else {
      publisher.forget(e.session.id)
      const viewers = viewersOf(e.session)
      hub.show({ view: 'ended', answered: e.stats.answered, open: e.stats.open }, viewers)
      controller.ended(viewers)
    }
  })

  const transcriber =
    deps.transcriber ??
    (config.DEEPGRAM_API_KEY
      ? deepgramFactory({ apiKey: config.DEEPGRAM_API_KEY, url: config.DEEPGRAM_URL, keyterms: config.STT_KEYTERMS, log: app.log })
      : undefined)
  const speech = new SpeechService({ db, sessions, log: app.log, factory: transcriber, now: deps.now })
  app.log.info({ speech: transcriber ? 'deepgram' : 'off' }, 'speech to text')

  const judge = deps.judge ?? (config.ANTHROPIC_API_KEY ? new ClaudeJudge(config.ANTHROPIC_API_KEY, config.LLM_JUDGE_MODEL) : undefined)
  const controller = new HostController({
    sessions,
    store,
    publisher,
    speech,
    writer,
    judge,
    show: showSession,
    sessionFor,
    lobby: {
      goLive: (viewer) => {
        const host = hosts.get(viewer)
        if (!host) return
        const { session } = sessions.start({ chatId: host.chatId, chatTitle: host.chatTitle, host: { tgUserId: host.tgUserId, name: host.name } })
        app.log.info({ session: session.id, host: host.id }, 'session live (from glasses)')
      },
      unpair: (viewer) => {
        hosts.unpair(viewer)
        hub.unpair(viewer)
        app.log.info({ host: viewer }, 'glasses unpaired')
      },
      showLobby: (viewer) => {
        const host = hosts.get(viewer)
        if (host) hub.show({ view: 'lobby', group: host.chatTitle }, [viewer])
      },
    },
    // Classify what is still waiting first, so last-second questions make it into the recap.
    endSession: (session) =>
      void pipeline
        .flush(session.id)
        .catch((err) => app.log.warn({ err }, 'final classification failed'))
        .finally(() => {
          const result = sessions.end(session.chatId)
          if (result) app.log.info({ session: session.id, ...result.stats, from: 'glasses' }, 'session ended')
        }),
    flagSpam: (session, clusterId) => writer.spam(session, clusterId),
    log: app.log,
    now: deps.now,
    undoMs: deps.undoMs ?? config.UNDO_MS,
    flashMs: deps.flashMs,
  })
  publisher.setSelection((id) => controller.selected(id))
  app.log.info({ judge: judge ? config.LLM_JUDGE_MODEL : 'off (manual answers only)' }, 'answer judge')

  // After a restart or redeploy mid-session: classify what arrived meanwhile and restore the queue screen.
  for (const session of sessions.live()) {
    // The host's in-progress take lived in memory: put those questions back in the queue.
    const released = store.releaseTaken(session.id)
    if (released) app.log.info({ session: session.id, released }, 'released questions taken before the restart')
    pipeline.captured(session.id)
    publisher.publishNow(session.id)
    app.log.info({ session: session.id, chat: session.chatId }, 'resumed live session')
  }

  if (deps.bot) {
    registerHandlers(deps.bot, {
      sessions,
      outbox,
      store,
      pipeline,
      publisher,
      hosts,
      publicUrl: config.PUBLIC_URL,
      pairing: { waiting: (code) => hub.pairingWaiting(code), complete: (code, token, group) => hub.completePairing(code, token, group) },
      log: app.log,
      now: deps.now,
    })
  }

  // Public recap page (no names); session ids are unguessable.
  app.get('/recap/:id', async (req, reply) => {
    const session = sessions.get((req.params as { id: string }).id)
    if (!session) return reply.code(404).type('text/plain').send('No such recap.')
    return reply.type('text/html; charset=utf-8').send(recapPage(session, store.recap(session.id)))
  })

  app.get('/health', async () => ({
    ok: true,
    telegram: Boolean(deps.bot),
    glasses: hub.size,
    uptime_s: Math.round(process.uptime()),
  }))

  await app.register(telegramRoutes, { secret: config.TG_WEBHOOK_SECRET, bot: deps.bot })
  await app.register(glassesRoutes, { hub, devToken: config.GLASSES_DEV_TOKEN, hostByToken: (t) => hosts.byToken(t)?.id })
  await app.register(debugRoutes, { devToken: config.GLASSES_DEV_TOKEN, sessions, speech })
  await app.register(evalRoutes, { classifier, devToken: config.GLASSES_DEV_TOKEN, fixturesPath: config.FIXTURES_PATH })

  app.addHook('onClose', async () => {
    pipeline.stop()
    controller.stop()
    await speech.close()
    hub.closeAll()
    db.close()
  })

  return { app, hub, db, sessions, outbox, store, pipeline, publisher, speech, controller, hosts }
}
