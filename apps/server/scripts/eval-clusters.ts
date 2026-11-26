// Runs fixtures/questions.json through the question pipeline and prints the spec's scorecard.
//   ANTHROPIC_API_KEY=... pnpm --filter @answered/server eval:clusters      (Claude Haiku, with fallback)
//   pnpm --filter @answered/server eval:clusters                            (heuristic only)
// On the deployed server: GET /debug/eval (Bearer GLASSES_DEV_TOKEN) runs the same eval with its own key.
import { fileURLToPath } from 'node:url'
import pino from 'pino'
import { ClaudeClassifier, FallbackClassifier, HeuristicClassifier } from '../src/pipeline/classifier.js'
import { formatScorecard, loadFixtures, runFixtures } from '../src/pipeline/evaluate.js'

const log = pino({ level: process.env.LOG_LEVEL ?? 'warn' })
const fixtures = loadFixtures(fileURLToPath(new URL('../../../fixtures/questions.json', import.meta.url)))
const model = process.env.LLM_CLASSIFY_MODEL ?? 'claude-haiku-5-5'
const key = process.env.ANTHROPIC_API_KEY
const classifier = key ? new FallbackClassifier(new ClaudeClassifier(key, model), new HeuristicClassifier(), log) : new HeuristicClassifier()

const run = await runFixtures(fixtures, classifier, log, Number(process.env.EVAL_BATCH ?? 3))
console.log(`Classifier: ${run.classifier}${key ? ` (${model})` : ' (set ANTHROPIC_API_KEY to use Claude)'}`)
console.log(`${run.batches} batches, median ${run.medianBatchMs} ms, total ${run.totalMs} ms\n`)
console.log(formatScorecard(run.scorecard))
console.log('\nQueue:')
for (const c of run.queue) console.log(`  ${String(c.askers).padStart(2)} | ${c.title}`)
if (run.misses.length) {
  console.log('\nMisclassified:')
  for (const m of run.misses) console.log(`  [${m.expect ?? 'chatter'}] ${JSON.stringify(m.text)} -> ${m.got}`)
}
for (const group of run.scorecard.mixed) console.log(`\nMixed cluster:\n  ${group.join('\n  ')}`)
