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

## Latency (end to end, real Deepgram and Claude)

Host stops talking → reply posted, measured by the server from Deepgram's end-of-speech time to the
posted reply (`answer posted`, `latencyMs`). 3 runs of `fixtures/host.wav` through the real pipeline
(Deepgram streaming, Haiku classification, Sonnet judge) with a stubbed Telegram send (~0.3 s in production):

| Run | Latency |
|---|---|
| 1 | 6.37 s |
| 2 | 6.11 s |
| 3 | 5.96 s |
| **Median** | **6.11 s** (target: 6 s or less) |

That includes the 3 s undo window (`UNDO_MS=3000`), which the spec did not have; the pipeline itself takes
about 3.1 s (1.5 s end-of-speech detection + ~1.6 s judge call). `UNDO_MS=2500` brings the median to ~5.6 s.

Earlier live check on Railway (26 Nov, real group): 6.7 s from the end of the spoken answer to the reply.
