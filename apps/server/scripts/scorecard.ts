// Runs the question eval and the answer eval several times with the real models and writes
// docs/SCORECARD.md: the numbers for the README and the judges.
//   ANTHROPIC_API_KEY=... pnpm --filter @answered/server scorecard [--runs 3]
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { ClaudeClassifier, FallbackClassifier, HeuristicClassifier } from '../src/pipeline/classifier.js'
import { loadFixtures, runFixtures } from '../src/pipeline/evaluate.js'
import { ClaudeJudge } from '../src/answers/judge.js'
import { runAnswerCases } from '../src/answers/evaluate.js'

const key = process.env.ANTHROPIC_API_KEY
if (!key) {
  console.error('Set ANTHROPIC_API_KEY.')
  process.exit(1)
}
const args = process.argv.slice(2)
const runs = Number(args[args.indexOf('--runs') + 1]) || 3
const classifyModel = process.env.LLM_CLASSIFY_MODEL ?? 'claude-haiku-5-5'
const judgeModel = process.env.LLM_JUDGE_MODEL ?? 'claude-sonnet-5-5'
const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url))
const log = pino({ level: 'warn' })
const fixtures = loadFixtures(root('fixtures/questions.json'))

const pct = (x: number) => `${Math.round(x * 100)}%`
const range = (xs: number[], f: (x: number) => string = String) =>
  Math.min(...xs) === Math.max(...xs) ? f(xs[0]!) : `${f(Math.min(...xs))}–${f(Math.max(...xs))}`
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!

console.log(`Question eval x${runs} (${classifyModel})...`)
const q = []
for (let i = 0; i < runs; i++) {
  q.push(await runFixtures(fixtures, new FallbackClassifier(new ClaudeClassifier(key, classifyModel), new HeuristicClassifier(), log), log))
}
const h = await runFixtures(fixtures, new HeuristicClassifier(), log)

console.log(`Answer eval x${runs} (${judgeModel})...`)
const a = []
for (let i = 0; i < runs; i++) a.push(await runAnswerCases(root('fixtures/answers.json'), new ClaudeJudge(key, judgeModel)))

const sc = q.map((r) => r.scorecard)
const md = `# Scorecard

Generated ${new Date().toISOString().slice(0, 10)} by \`pnpm --filter @answered/server scorecard --runs ${runs}\`.
Fixtures: \`fixtures/questions.json\` (the spec's 40-message demo burst) and \`fixtures/answers.json\`
(10 answer-judging cases from the demo script, including the real Deepgram transcript of \`fixtures/host.wav\`).

## Questions (${classifyModel}, ${runs} runs)

| Metric | Result | Target |
|---|---|---|
| Questions detected | ${range(sc.map((s) => s.detection), pct)} (${sc[0]!.questions} labelled) | 95% or more |
| Duplicates merged into the right question | ${range(sc.map((s) => s.merged), pct)} | 90% or more |
| False merges (different questions in one) | ${range(sc.map((s) => s.falseMerges))} | 0 |
| Chatter counted as a question | ${range(sc.map((s) => s.falsePositives))} | 0 |
| Spam caught | ${range(sc.map((s) => s.spamCaught))} of ${sc[0]!.spamTotal} | all |
| Median time per batch | ${median(q.map((r) => r.medianBatchMs))} ms | |

Fallback without the model (keyword heuristic, used if Claude is down): ${pct(h.scorecard.detection)} detected,
${pct(h.scorecard.merged)} merged, ${h.scorecard.falseMerges} false merges.

## Answers (${judgeModel}, ${runs} runs × ${a[0]!.cases} cases)

| Metric | Result | Target |
|---|---|---|
| Cases judged correctly | ${a.reduce((n, r) => n + r.correct, 0)} of ${a.reduce((n, r) => n + r.cases, 0)} | all |
| False "answered" (talked around, wrong question, promises) | ${a.reduce((n, r) => n + r.falseAnswered.length, 0)} | 0 |
| Real answers missed | ${a.reduce((n, r) => n + r.missed.length, 0)} | 0 |
| Median judge call | ${median(a.map((r) => r.medianMs))} ms | |

## Latency (live, Railway)

Host stops talking → reply in the Telegram group, measured from Deepgram's end-of-speech time to the
posted reply (logged as \`answer posted\` with \`latencyMs\`). See the section below, filled from a rehearsal.
`
writeFileSync(root('docs/SCORECARD.md'), md)
console.log(md)
