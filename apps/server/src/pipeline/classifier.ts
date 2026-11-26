import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'
import type { FastifyBaseLogger } from 'fastify'
import type { Classification, ClusterStatus } from './clusters.js'
import { TITLE_MAX, clampTitle, jaccard, keywords, mightBeQuestion } from './text.js'

export interface ClassifyInput {
  messages: Array<{ id: number; text: string; isReply: boolean }>
  clusters: Array<{ id: string; title: string; status: ClusterStatus }>
}

export interface Classifier {
  readonly name: string
  classify(input: ClassifyInput): Promise<Classification[]>
}

// ---------------------------------------------------------------- Claude

export const CLASSIFY_SYSTEM = `You sort messages from a live Telegram Q&A, where a host answers the audience out loud.

For every message, return:
- is_question: true only if it asks the host for information or a decision. Greetings, hype, opinions, thanks and replies to other users are not questions.
- spam: true for scams, shilling other projects, suspicious links or flooding.
- canonical: the question rewritten as a short, neutral English question of at most ${TITLE_MAX} characters, using only facts stated in the message. Never add facts. Empty when not a question.
- cluster: for questions only, otherwise empty. Two questions belong together only if one answer from the host would fully answer both. Sharing a topic or keywords is not enough: a question about timing ("when does the cliff end?") and one about how something works ("is it linear or a cliff?") need different answers, and so do "When is mainnet?" and "Will mainnet have staking?". Use an existing cluster's id when that cluster's question needs the same answer; clusters marked answered are still valid targets. Otherwise use "new:" plus a short label, and give questions in this batch that need the same new answer the same label.

Return exactly one result per message, using the message's id.`

const ResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.number().int(),
      is_question: z.boolean(),
      spam: z.boolean(),
      canonical: z.string(),
      cluster: z.string(),
    }),
  ),
})

export class RefusalError extends Error {}

/** One structured-output call per batch: classification and clustering together. */
export class ClaudeClassifier implements Classifier {
  readonly name = 'claude'
  private readonly client: Anthropic

  constructor(
    apiKey: string,
    private readonly model: string,
    baseURL = 'https://api.anthropic.com',
    /** Test seam: replaces the HTTP layer. */
    fetch?: typeof globalThis.fetch,
  ) {
    // baseURL is explicit so a stray ANTHROPIC_BASE_URL in the environment is never picked up.
    this.client = new Anthropic({ apiKey, baseURL, timeout: 20_000, maxRetries: 1, ...(fetch ? { fetch } : {}) })
  }

  async classify(input: ClassifyInput): Promise<Classification[]> {
    const payload = {
      clusters: input.clusters.map((c) => ({ id: c.id, title: c.title, ...(c.status === 'answered' ? { answered: true } : {}) })),
      messages: input.messages.map((m) => ({ id: m.id, text: m.text, ...(m.isReply ? { reply_to_another_user: true } : {}) })),
    }
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: 8000,
      // Classification needs no deliberation and sits on the latency path.
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: zodOutputFormat(ResultSchema) },
      system: CLASSIFY_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    })
    if (response.stop_reason === 'refusal') throw new RefusalError(response.stop_details?.category ?? 'refusal')
    if (!response.parsed_output) throw new Error(`classifier returned no parsable output (stop_reason ${response.stop_reason})`)

    const asked = new Set(input.messages.map((m) => m.id))
    return response.parsed_output.results
      .filter((r) => asked.has(r.id))
      .map((r) => ({
        messageId: r.id,
        isQuestion: r.is_question,
        spam: r.spam,
        canonical: r.canonical,
        cluster: r.cluster,
      }))
  }
}

// ---------------------------------------------------------------- heuristic

const SPAM = /(https?:\/\/|t\.me\/|www\.)\S+|\b(airdrop|giveaway|dm me|100x|pump|presale|whitelist spot)\b/i
const JOIN_AT = 0.5

function toCanonical(text: string): string {
  const firstQuestion = text.match(/[^.!?\n]*\?/)?.[0] ?? text
  const t = firstQuestion.replace(/\s+/g, ' ').trim().replace(/\?+$/, '?')
  return clampTitle(t.charAt(0).toUpperCase() + t.slice(1))
}

/**
 * Model-free classifier: the prefilter decides "question", keyword overlap decides the cluster.
 * Used when no API key is set and whenever the model call fails, so the queue never stalls.
 */
export class HeuristicClassifier implements Classifier {
  readonly name = 'heuristic'

  async classify(input: ClassifyInput): Promise<Classification[]> {
    const pool = input.clusters
      .filter((c) => c.status !== 'skipped')
      .map((c) => ({ key: c.id, words: keywords(c.title) }))
    return input.messages.map((m) => {
      const spam = SPAM.test(m.text)
      const isQuestion = !spam && mightBeQuestion(m.text)
      if (!isQuestion) return { messageId: m.id, isQuestion: false, spam, canonical: '', cluster: '' }
      const words = keywords(m.text)
      let best: { key: string; sim: number } | undefined
      for (const c of pool) {
        const sim = jaccard(words, c.words)
        if (sim >= JOIN_AT && (!best || sim > best.sim)) best = { key: c.key, sim }
      }
      const cluster = best?.key ?? `new:${m.id}`
      if (!best) pool.push({ key: cluster, words })
      return { messageId: m.id, isQuestion, spam, canonical: toCanonical(m.text), cluster }
    })
  }
}

// ---------------------------------------------------------------- fallback

/** Tries the primary classifier and falls back per batch, and per message it left out. */
export class FallbackClassifier implements Classifier {
  readonly name: string

  constructor(
    private readonly primary: Classifier,
    private readonly fallback: Classifier,
    private readonly log: FastifyBaseLogger,
  ) {
    this.name = `${primary.name}+${fallback.name}`
  }

  async classify(input: ClassifyInput): Promise<Classification[]> {
    let results: Classification[] = []
    try {
      results = await this.primary.classify(input)
    } catch (err) {
      this.log.warn({ err, classifier: this.primary.name, batch: input.messages.length }, 'classifier failed; using fallback')
    }
    const covered = new Set(results.map((r) => r.messageId))
    const missing = input.messages.filter((m) => !covered.has(m.id))
    if (!missing.length) return results
    return [...results, ...(await this.fallback.classify({ ...input, messages: missing }))]
  }
}
