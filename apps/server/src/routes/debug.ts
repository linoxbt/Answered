import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { SessionService } from '../sessions.js'
import type { SpeechService } from '../speech/index.js'

export interface DebugRouteOptions {
  devToken: string | undefined
  sessions: SessionService
  speech: SpeechService
}

export function authorized(req: FastifyRequest, devToken: string | undefined): boolean {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
  return Boolean(devToken) && token.length === devToken!.length && timingSafeEqual(Buffer.from(token), Buffer.from(devToken!))
}

/** Read-only views for checking a live session; behind the glasses token. */
export async function debugRoutes(app: FastifyInstance, opts: DebugRouteOptions): Promise<void> {
  // GET /debug/transcript: the live session's final transcript segments (deleted at /end).
  app.get('/debug/transcript', async (req, reply) => {
    if (!authorized(req, opts.devToken)) return reply.code(401).send({ error: 'unauthorized' })
    const live = opts.sessions.live().sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]
    if (!live) return { session: null, speech: opts.speech.enabled, segments: [] }
    return { session: live.id, group: live.chatTitle, speech: opts.speech.enabled, segments: opts.speech.segments(live.id).slice(-50) }
  })
}
