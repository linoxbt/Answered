import { readFileSync } from 'node:fs'
import { rejection, type Judge, type JudgeQuestion } from './judge.js'

interface AnswerCase {
  name: string
  taken: string
  others: string[]
  transcript: string
  expect: string[]
}

export interface AnswerRun {
  judge: string
  cases: number
  correct: number
  /** Questions marked answered that should have stayed open: the failure the spec forbids on stage. */
  falseAnswered: Array<{ case: string; question: string; summary: string }>
  missed: Array<{ case: string; question: string; why: string }>
  medianMs: number
  summaries: Array<{ case: string; question: string; summary: string }>
}

/** Runs fixtures/answers.json through a judge with the in-code accept rules. */
export async function runAnswerCases(path: string, judge: Judge): Promise<AnswerRun> {
  const data = JSON.parse(readFileSync(path, 'utf8')) as { questions: Record<string, string>; cases: AnswerCase[] }
  const run: AnswerRun = { judge: judge.name, cases: data.cases.length, correct: 0, falseAnswered: [], missed: [], medianMs: 0, summaries: [] }
  const times: number[] = []
  await Promise.all(
    data.cases.map(async (c) => {
      const questions: JudgeQuestion[] = [c.taken, ...c.others].map((id) => ({ id, title: data.questions[id]!, taken: id === c.taken }))
      const started = Date.now()
      const verdicts = await judge.judge({ questions, transcript: c.transcript })
      times.push(Date.now() - started)
      let ok = true
      for (const q of questions) {
        const v = verdicts.find((x) => x.id === q.id)
        const why = v ? rejection(v, q.taken, c.transcript) : 'no verdict'
        const accepted = why === null
        const expected = c.expect.includes(q.id)
        if (accepted) run.summaries.push({ case: c.name, question: q.id, summary: v!.summary })
        if (accepted && !expected) run.falseAnswered.push({ case: c.name, question: q.id, summary: v!.summary })
        if (!accepted && expected) run.missed.push({ case: c.name, question: q.id, why: why! })
        if (accepted !== expected) ok = false
      }
      if (ok) run.correct += 1
    }),
  )
  run.medianMs = times.sort((a, b) => a - b)[times.length >> 1] ?? 0
  return run
}
