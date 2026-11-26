import { readFileSync } from 'node:fs'
import type { FastifyBaseLogger } from 'fastify'
import { openDb } from '../db/index.js'
import { SessionService } from '../sessions.js'
import type { Classifier } from './classifier.js'
import { ClusterStore } from './clusters.js'
import { Pipeline } from './index.js'

/** One labelled message from fixtures/questions.json. `expect`: cluster label, null (chatter) or "spam". */
export interface FixtureMessage {
  user: number
  name: string
  text: string
  expect: string | null
}

export function loadFixtures(path: string): FixtureMessage[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { messages: FixtureMessage[] }).messages
}

export interface Outcome {
  isQuestion: boolean
  spam: boolean
  clusterId: string | null
}

export interface Scorecard {
  questions: number
  detected: number
  /** Share of labelled questions detected as questions (target: 95 %+). */
  detection: number
  /** Share of detected questions sitting in their label's main cluster (target: 90 %+). */
  merged: number
  /** Clusters that mix two different labels: the "related but different" failure. */
  falseMerges: number
  /** Chatter marked as a question. */
  falsePositives: number
  spamCaught: number
  spamTotal: number
  clusters: number
  expectedClusters: number
}

/** Scores pipeline outcomes against fixture labels (outcomes in fixture order). */
export function score(fixtures: FixtureMessage[], outcomes: Outcome[]): Scorecard {
  const isQ = (o: Outcome) => o.isQuestion && !o.spam
  const pairs = fixtures.map((f, i) => ({ f, o: outcomes[i]! }))
  const questions = pairs.filter((p) => p.f.expect !== null && p.f.expect !== 'spam')
  const detected = questions.filter((p) => isQ(p.o))

  // For each label, the cluster holding most of its detected messages.
  const byLabel = new Map<string, Map<string, number>>()
  for (const { f, o } of detected) {
    const counts = byLabel.get(f.expect!) ?? new Map<string, number>()
    counts.set(o.clusterId!, (counts.get(o.clusterId!) ?? 0) + 1)
    byLabel.set(f.expect!, counts)
  }
  let inMain = 0
  for (const counts of byLabel.values()) inMain += Math.max(...counts.values())

  // Clusters whose members carry more than one label.
  const labelsByCluster = new Map<string, Set<string>>()
  for (const { f, o } of detected) {
    const set = labelsByCluster.get(o.clusterId!) ?? new Set<string>()
    set.add(f.expect!)
    labelsByCluster.set(o.clusterId!, set)
  }

  const spam = pairs.filter((p) => p.f.expect === 'spam')
  return {
    questions: questions.length,
    detected: detected.length,
    detection: questions.length ? detected.length / questions.length : 1,
    merged: detected.length ? inMain / detected.length : 1,
    falseMerges: [...labelsByCluster.values()].filter((s) => s.size > 1).length,
    falsePositives: pairs.filter((p) => p.f.expect === null && isQ(p.o)).length,
    spamCaught: spam.filter((p) => p.o.spam || !p.o.isQuestion).length,
    spamTotal: spam.length,
    clusters: labelsByCluster.size,
    expectedClusters: new Set(questions.map((p) => p.f.expect)).size,
  }
}

export function formatScorecard(s: Scorecard): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`
  return [
    `Questions detected   ${s.detected}/${s.questions} (${pct(s.detection)}, target 95%+)`,
    `Merged correctly     ${pct(s.merged)} (target 90%+)`,
    `Clusters             ${s.clusters} (expected ${s.expectedClusters})`,
    `False merges         ${s.falseMerges} (target 0)`,
    `Chatter as question  ${s.falsePositives}`,
    `Spam caught          ${s.spamCaught}/${s.spamTotal}`,
  ].join('\n')
}

export interface FixtureRun {
  classifier: string
  scorecard: Scorecard
  queue: Array<{ askers: number; title: string }>
  misses: Array<{ expect: string | null; text: string; got: 'spam' | 'question' | 'not a question' }>
  batches: number
  medianBatchMs: number
  totalMs: number
}

/**
 * Feeds fixtures through a fresh in-memory pipeline, `batch` messages at a time (as the 2 s
 * timer would cut a burst), and scores the result. Used by the eval script and /debug/eval.
 */
export async function runFixtures(fixtures: FixtureMessage[], classifier: Classifier, log: FastifyBaseLogger, batch = 3): Promise<FixtureRun> {
  const db = openDb(':memory:')
  try {
    const sessions = new SessionService(db)
    const store = new ClusterStore(db)
    const pipeline = new Pipeline({ classifier, store, sessions, log, batchMs: 1, onQueueChanged: () => {} })
    const { session } = sessions.start({ chatId: -1, chatTitle: 'Eval', host: { tgUserId: 1, name: 'Eval' } })

    const started = Date.now()
    const times: number[] = []
    for (let i = 0; i < fixtures.length; i += batch) {
      fixtures.slice(i, i + batch).forEach((f, j) =>
        sessions.capture(-1, { messageId: i + j + 1, userId: f.user, userName: f.name, text: f.text, at: Date.now() }),
      )
      const t = Date.now()
      await pipeline.flush(session.id)
      times.push(Date.now() - t)
    }

    const outcomes = fixtures.map((_, i) => {
      const r = db.prepare('SELECT is_question, spam, cluster_id FROM messages WHERE message_id = ?').get(i + 1) as {
        is_question: number | null
        spam: number
        cluster_id: string | null
      }
      return { isQuestion: r.is_question === 1, spam: r.spam === 1, clusterId: r.cluster_id }
    })
    const misses = fixtures
      .map((f, i) => ({ f, o: outcomes[i]! }))
      .filter(({ f, o }) => (f.expect !== null && f.expect !== 'spam') !== (o.isQuestion && !o.spam))
      .map(({ f, o }) => ({ expect: f.expect, text: f.text, got: (o.spam ? 'spam' : o.isQuestion ? 'question' : 'not a question') as FixtureRun['misses'][number]['got'] }))

    return {
      classifier: classifier.name,
      scorecard: score(fixtures, outcomes),
      queue: store.ranked(session.id).map((c) => ({ askers: c.askers, title: c.title })),
      misses,
      batches: times.length,
      medianBatchMs: [...times].sort((a, b) => a - b)[times.length >> 1] ?? 0,
      totalMs: Date.now() - started,
    }
  } finally {
    db.close()
  }
}
