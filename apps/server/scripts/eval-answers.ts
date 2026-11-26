// Runs fixtures/answers.json through the answer judge and prints how many cases it got right.
//   ANTHROPIC_API_KEY=... pnpm --filter @answered/server eval:answers
// Target from the spec: every scripted answer matched, 0 false "answered".
import { fileURLToPath } from 'node:url'
import { ClaudeJudge } from '../src/answers/judge.js'
import { runAnswerCases } from '../src/answers/evaluate.js'

const key = process.env.ANTHROPIC_API_KEY
if (!key) {
  console.error('Set ANTHROPIC_API_KEY.')
  process.exit(1)
}
const model = process.env.LLM_JUDGE_MODEL ?? 'claude-sonnet-5-5'
const run = await runAnswerCases(fileURLToPath(new URL('../../../fixtures/answers.json', import.meta.url)), new ClaudeJudge(key, model))
console.log(`Judge: ${model}; median ${run.medianMs} ms per call`)
console.log(`Cases right   ${run.correct}/${run.cases}`)
console.log(`False answered ${run.falseAnswered.length} (target 0)`)
console.log(`Missed answers ${run.missed.length} (target 0)`)
for (const f of run.falseAnswered) console.log(`  FALSE  [${f.case}] ${f.question}: ${f.summary}`)
for (const m of run.missed) console.log(`  MISSED [${m.case}] ${m.question}: ${m.why}`)
console.log('\nSummaries:')
for (const s of run.summaries) console.log(`  [${s.case}] ${s.question}: ${s.summary}`)
