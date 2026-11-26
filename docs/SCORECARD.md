# Scorecard

Generated 2026-11-26 by `pnpm --filter @answered/server scorecard --runs 3`.
Fixtures: `fixtures/questions.json` (the spec's 40-message demo burst) and `fixtures/answers.json`
(10 answer-judging cases from the demo script, including the real Deepgram transcript of `fixtures/host.wav`).

## Questions (claude-haiku-5-5, 3 runs)

| Metric | Result | Target |
|---|---|---|
| Questions detected | 100% (26 labelled) | 95% or more |
| Duplicates merged into the right question | 92%–100% | 90% or more |
| False merges (different questions in one) | 0 | 0 |
| Chatter counted as a question | 0 | 0 |
| Spam caught | 2 of 2 | all |
| Median time per batch | 2148 ms | |

Fallback without the model (keyword heuristic, used if Claude is down): 100% detected,
50% merged, 0 false merges.

## Answers (claude-sonnet-5-5, 3 runs × 10 cases)

| Metric | Result | Target |
|---|---|---|
| Cases judged correctly | 30 of 30 | all |
| False "answered" (talked around, wrong question, promises) | 0 | 0 |
| Real answers missed | 0 | 0 |
| Median judge call | 1752 ms | |

## Latency (live, Railway)

Host stops talking → reply in the Telegram group, measured from Deepgram's end-of-speech time to the
posted reply (logged as `answer posted` with `latencyMs`). See the section below, filled from a rehearsal.
