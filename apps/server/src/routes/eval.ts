import { timingSafeEqual } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type { Classifier } from '../pipeline/classifier.js'
import { loadFixtures, runFixtures } from '../pipeline/evaluate.js'

export interface EvalRouteOptions {
  classifier: Classifier
  devToken: string | undefined
  fixturesPath: string
}

/**
 * GET /debug/eval runs the labelled fixtures through the live classifier configuration
 * (the server's own API key) and returns the scorecard. Costs a few Haiku calls per run.
 */
export async function evalRoutes(app: FastifyInstance, opts: EvalRouteOptions): Promise<void> {
  let running = false
  app.get('/debug/eval', async (req, reply) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
    const ok = opts.devToken && token.length === opts.devToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(opts.devToken))
    if (!ok) return reply.code(401).send({ error: 'unauthorized' })
    if (running) return reply.code(409).send({ error: 'an eval is already running' })
    running = true
    try {
      const batch = Number((req.query as Record<string, string>).batch ?? 3)
      // Per-batch info lines would flood production logs; keep warnings (e.g. classifier fallbacks).
      const log = req.log.child({ eval: true }, { level: 'warn' })
      return await runFixtures(loadFixtures(opts.fixturesPath), opts.classifier, log, Math.min(Math.max(batch, 1), 30))
    } finally {
      running = false
    }
  })
}
