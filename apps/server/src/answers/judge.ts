import Anthropic from '@anthropic-ai/sdk'
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod'
import { z } from 'zod'

export interface JudgeQuestion {
  id: string
  title: string
  /** The question the host pressed to take; others are checked in case the host answered them too. */
  taken: boolean
}

export interface Verdict {
  id: string
  answered: boolean
  confidence: number
  summary: string
  quote: string
}

export interface Judge {
  readonly name: string
  /** Decides, per question, whether the transcript answers it. */
  judge(input: { questions: JudgeQuestion[]; transcript: string }): Promise<Verdict[]>
  /** One-line answer summary for a question the host marked answered by hand ('' if nothing relevant). */
  summarize(input: { question: string; transcript: string }): Promise<string>
}

export const JUDGE_SYSTEM = `You decide whether a speaker has answered audience questions during a live Q&A.

You get a speech-to-text transcript of what the speaker said since taking a question, and a list of questions. The one marked taken is the question the speaker chose to answer; the others are open questions the speaker may or may not have covered.

For every question return:
- answered: true only if the speaker gives the specific information the question asks for. Mentioning the topic, promising to answer later, saying details are still being worked out, or answering a different question is answered=false.
- confidence: 0 to 1.
- summary: one sentence of at most 120 characters, written as the answer, using only facts the speaker stated. You may fix obvious transcription errors here, such as "q one" for "Q1", but never turn a word that looks misheard into a new fact such as a date or number; leave it out instead. Empty when not answered.
- quote: the words from the transcript that answer the question, copied exactly as they appear in the transcript, including any transcription errors. Empty when not answered.

Questions other than the taken one are usually not addressed: mark them answered only when the transcript clearly answers them. If you cannot copy a quote word for word from the transcript, set answered=false.`

const SUMMARY_SYSTEM = `The host of a live Q&A marked an audience question as answered. From the speech-to-text transcript, write the answer in one sentence of at most 120 characters, using only facts the speaker stated (you may fix obvious transcription errors such as "q one" for "Q1"). If the transcript says nothing relevant to the question, return an empty summary.`

const VerdictSchema = z.object({
  verdicts: z.array(
    z.object({
      id: z.string(),
      answered: z.boolean(),
      confidence: z.number(),
      summary: z.string(),
      quote: z.string(),
    }),
  ),
})

const SummarySchema = z.object({ summary: z.string() })

/**
 * Claude Sonnet 5.5 as the answer judge. Thinking off (`between_tools`) because the verdict sits on
 * the reply-latency path; server-side refusal fallbacks are on, so a decline is retried on another model.
 */
export class ClaudeJudge implements Judge {
  readonly name = 'claude'
  private readonly client: Anthropic

  constructor(
    apiKey: string,
    private readonly model: string,
    baseURL = 'https://api.anthropic.com',
    fetch?: typeof globalThis.fetch,
  ) {
    this.client = new Anthropic({ apiKey, baseURL, timeout: 15_000, maxRetries: 1, ...(fetch ? { fetch } : {}) })
  }

  private params() {
    return {
      model: this.model,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default' as const,
      // between_tools is Sonnet 5.5's "thinking off"; other models take an explicit disabled.
      thinking: this.model.startsWith('claude-sonnet-5-5') ? ({ type: 'between_tools' } as const) : ({ type: 'disabled' } as const),
    }
  }

  async judge(input: { questions: JudgeQuestion[]; transcript: string }): Promise<Verdict[]> {
    const response = await this.client.beta.messages.parse({
      ...this.params(),
      output_config: { effort: 'low', format: betaZodOutputFormat(VerdictSchema) },
      system: JUDGE_SYSTEM,
      messages: [
        {
          role: 'user',
          content: JSON.stringify({
            questions: input.questions.map((q) => ({ id: q.id, question: q.title, ...(q.taken ? { taken: true } : {}) })),
            transcript: input.transcript,
          }),
        },
      ],
    })
    // A refusal through the whole fallback chain counts as "not answered": the question stays open.
    if (response.stop_reason === 'refusal' || !response.parsed_output) return []
    const known = new Set(input.questions.map((q) => q.id))
    return response.parsed_output.verdicts.filter((v) => known.has(v.id))
  }

  async summarize(input: { question: string; transcript: string }): Promise<string> {
    const response = await this.client.beta.messages.parse({
      ...this.params(),
      output_config: { effort: 'low', format: betaZodOutputFormat(SummarySchema) },
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: JSON.stringify({ question: input.question, transcript: input.transcript }) }],
    })
    if (response.stop_reason === 'refusal' || !response.parsed_output) return ''
    return response.parsed_output.summary.trim()
  }
}

// ---------------------------------------------------------------- quote check (in code, not trusted to the model)

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  eleven: '11', twelve: '12', first: '1st', second: '2nd', third: '3rd', fourth: '4th',
}

/**
 * Tokens for comparing a quote with the transcript: lower case, no punctuation, number words as
 * digits, and a lone letter joined to the number after it ("q one" / "Q 1" / "Q1" all become "q1").
 */
export function normalizeTokens(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => NUMBER_WORDS[t] ?? t)
  const out: string[] = []
  for (const t of raw) {
    const prev = out.at(-1)
    if (prev && /^[a-z]$/.test(prev) && /^\d+$/.test(t)) out[out.length - 1] = prev + t
    else out.push(t)
  }
  return out.flatMap((t) => (/^[a-z]\d+$/.test(t) ? [t] : t.match(/[a-z]+|\d+/g) ?? []))
}

/** Share of the quote's tokens that appear in order in the transcript (longest common subsequence). */
export function quoteCoverage(quote: string, transcript: string): number {
  const q = normalizeTokens(quote)
  const t = normalizeTokens(transcript)
  if (!q.length) return 0
  let prev = new Array<number>(t.length + 1).fill(0)
  for (const qt of q) {
    const cur = new Array<number>(t.length + 1).fill(0)
    for (let j = 1; j <= t.length; j++) cur[j] = qt === t[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!)
    prev = cur
  }
  return prev[t.length]! / q.length
}

export interface AcceptRules {
  /** Minimum confidence for the question the host took (spec: 0.75). */
  takenConfidence: number
  /** Minimum confidence for open questions the host did not take: stricter, nobody pressed for them. */
  otherConfidence: number
  /** Minimum share of quote tokens found in the transcript. */
  quoteCoverage: number
}

export const DEFAULT_RULES: AcceptRules = { takenConfidence: 0.75, otherConfidence: 0.85, quoteCoverage: 0.85 }

/** The spec's accept rule, applied in code. Returns why a verdict was rejected, or null to accept. */
export function rejection(v: Verdict, taken: boolean, transcript: string, rules: AcceptRules = DEFAULT_RULES): string | null {
  if (!v.answered) return 'not answered'
  if (v.confidence < (taken ? rules.takenConfidence : rules.otherConfidence)) return `confidence ${v.confidence}`
  if (!v.summary.trim()) return 'no summary'
  const coverage = quoteCoverage(v.quote, transcript)
  if (coverage < rules.quoteCoverage) return `quote not in transcript (${Math.round(coverage * 100)}%)`
  return null
}
