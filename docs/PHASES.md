# Answered — build phases

The build spec (`Answered — Build Spec`, 26 Nov 2026) is split into eight phases.
Each phase ends with something that runs and can be checked, so a phase that slips
never leaves the project broken. All times are Lagos time; the hard deadline is
**Sun 29 Nov, 20:59** (19:59 UTC) and the target is to submit by 18:00.

| # | Phase | When | Exit check |
|---|-------|------|------------|
| 0 | Foundation and day-1 risks | Thu night | Simulator shows text pushed by the server; server counts audio bytes and input events from the glasses socket; webhook logs a real update |
| 1 | Data model, sessions, Telegram core | Fri morning | `/live` and `/end` open and close a session in a real group; outbox never trips a 429 |
| 2 | Question pipeline: detect, cluster, rank | Fri midday | 40 fixture messages produce the expected clusters; top 5 pushed over the socket |
| 3 | Speech | Fri afternoon | `replay-audio` streams `host.wav` through the glasses socket and final transcript segments are stored |
| 4 | Answer matcher and write-back (the core) | Fri night | Spoken answer produces one threaded reply + reactions within ~6 s; a talked-around question stays open |
| 5 | Glasses experience and pairing | Sat | All six screens, the input map, throttled list rebuilds, resume on foreground, pairing without typing a token |
| 6 | Recap, seed audience, eval and tuning | Sat evening | Pinned recap; `eval.ts` scorecard meets the targets; full rehearsal in the real group |
| 7 | Ship | Sun, done by 18:00 | Video ≤ 3 min, README, `.ehpk` release, DoraHacks submission, server left running for Demo Day (3 Dec) |

Stretch (only if phase 6 is green on Saturday): Mini App mod view, private-DM opt-in.

---

## Phase 0 — Foundation and day-1 risks

Goal: prove every connection the product depends on before writing product logic.

- pnpm monorepo: `apps/server`, `apps/glasses`, `packages/protocol` (shared socket message types).
- Server (Fastify + `ws`): `GET /health`, `POST /tg/webhook` with the secret-header check,
  `WS /ws/glasses` that counts binary audio frames and logs input events, `GET /debug/stats`.
- grammY bot that logs every update; `set-webhook` script with the spec's `allowed_updates`.
- Glasses app from the official `evenhub-templates/minimal`: bridge init, socket with
  reconnect, mic frames forwarded as binary, ring/temple input forwarded as JSON, server-pushed text rendered.
- `app.json` with `network` (https **and** wss origins), `g2-microphone`, `phone-microphone`.
- Day-1 risk checks (results recorded below).

Accounts the owner must create (cannot be done from code): BotFather token, Deepgram key,
Anthropic key, OpenAI key (or skip, see phase 2), Railway project.

**Day-1 risk results so far**

| Risk | Result |
|------|--------|
| Is `wss://` allowed in the `app.json` whitelist? | Yes. The official ASR template documents `"whitelist": ["https://…", "wss://…"]`. List both origins. |
| `eventSource` values | From SDK 0.0.16 typings: `0` none, `1` right temple, `2` R1 ring, `3` left temple. |
| List selected-index field | `listEvent.currentSelectItemIndex` (also `currentSelectItemName`). |
| Audio format | PCM s16le, 16 kHz, mono on both mic sources. Frames also carry `speakerRole` (`Self` / `Other` / `Unknown`). |
| SDK version | Latest is **0.0.16** (fixes repeated `setTimeout`/`setInterval` callbacks). Use it instead of 0.0.14. |
| Audio bytes reach the server | Verified in the simulator: 100 ms frames of exactly 3,200 bytes; level meter reads speech vs silence. |
| Socket survives a server restart | Verified: glasses reconnect with backoff, resend `hello`, mic turns back on. |
| Input from the simulator | Verified: press (with `eventSource` = right temple), swipe up/down, long press, double-tap all reach the server. |
| `.ehpk` packs | Verified with `evenhub pack` (CLI 0.2.0 stamps `min_app_version` 2.2.10). |

**Deployment (26 Nov)**

- Railway project `answered`, service `server`, volume `answered-data` at `/data`.
- Public URL: `https://server-production-f558e8c1.up.railway.app` (health: `/health`).
- Telegram webhook set for **@answereddbot** with the spec's `allowed_updates`; secret header checked.
- Verified from the simulator against the deployed server: `wss://` connects, input and audio arrive.
- Remaining owner step: add @answereddbot to a test supergroup **as an admin** (privacy mode is
  still on, and admin is also what enables reaction updates and pinning), then send `/live`.

## Phase 1 — Data model, sessions, Telegram core ✔ (code complete, awaiting a real bot)

- SQLite through Node's built-in `node:sqlite` (no native module to build on Railway), versioned
  migrations, the spec's six tables. Sessions get unguessable ids because they appear in recap URLs.
  On Railway, mount a volume and set `DATABASE_URL=file:/data/answered.db`, or the data is wiped on every deploy.
- `/live` and `/end` for group admins only (`getChatMember`; anonymous admins accepted);
  `/live@botname` works; one open session per group, enforced by a unique index.
- While live, every text message and caption is captured (commands and other bots skipped); edits
  update the text and clear its classification. Basic-group → supergroup migration moves the session.
- `/end` deletes the session's raw messages and transcript segments (the privacy promise);
  clusters keep titles, counts and answers for the recap. **Phase 6 must build the recap before this purge.**
- Outbox: one queue per chat, 1 call/s and 18 per rolling minute; reactions share the budget at
  low priority behind replies; 429 pauses the chat for `retry_after` and retries. Handlers never
  wait on it, so the webhook always answers Telegram at once.
- `my_chat_member`: asks to be made admin when added as a member, says ready when promoted,
  ends the session when removed.
- Glasses follow the live session (queue screen on `/live`, end screen on `/end`) until pairing.
- Tests: 35 (fake Bot API through grammY's transformer, fake clock for the outbox).

## Phase 2 — Question pipeline ✔ (live on Railway with Claude Haiku 5.5)

**Scorecard on the spec's 40-message burst (Claude Haiku 5.5, 24 runs of the final version):**
26/26 questions detected in every run, 92–96 % merged (target 90 %+), 0 chatter as questions, 2/2 spam
caught. False merges: 0 in 21 of 24 runs, 1 in the other 3 (one inspected: the two-part question
"How does the token unlock work, when do the first tokens release?" grouped with "linear or cliff?").
Median batch 2.1 s. What got it there, each measured over 6–8 runs:

| Change | False merges | Merged |
|---|---|---|
| First prompt | 1 in every run ("cliff end" date + "linear or cliff" mechanism) | 96–100 % |
| "Group only if one answer settles both" | ~1 run in 3 | 100 % |
| + thinking on (rejected: 2x latency) | ~1 in 6 | 81–92 % |
| + member examples in the prompt (rejected) | 7 in 8 | 96–100 % |
| + second focused "same question?" check on every join (kept) | 0–1 in 8 | 92–96 % |

Other measured choices: calls are capped at 10 messages (one 30-message call fell to 77 % merged);
titles use the earliest wording with 4+ words, because the spec's "shortest" rule jumped to narrow
variants like "Is mainnet Q1 or Q2?". One fixture question, "When does the unlock cliff end?", was
replaced with "What date do community tokens unlock?": it is honestly ambiguous between the unlock-date
and cliff-mechanism groups, so it measured the label rather than the classifier.

Decision: **no OpenAI embeddings.** One Claude Haiku 5.5 call per batch both classifies and
clusters (structured output: `is_question`, `spam`, `canonical`, `cluster` = existing id or
`new:<label>`). At under 500 questions per session the open-cluster list fits easily in the prompt,
and it removes a vendor, a key and the 0.74/0.82 threshold tuning.

- Prefilter (no model call): under 6 characters, commands and chatter are dropped; anything with `?`,
  a leading question word, a mid-sentence "when is / what are …" or "any update" passes.
- Batching: captured messages wait 2 s, then go in one call (max 30); one batch per session at a time.
  Thinking off and effort `low` on Haiku keeps it on the latency path.
- Clusters: unknown or skipped ids from the model become new clusters (a model slip can never drop a
  question). Title = shortest canonical with ≥ 4 words, ≤ 56 characters. Askers are unique users;
  answered clusters stay valid targets, so a repeat of an answered question joins it (phase 4 can
  reply with the existing answer).
- Votes: a named reaction on any message in a cluster is one vote per person; askers' own reactions
  don't add (they already count double); bots are ignored; anonymous reaction totals are added.
- Ranking: `2 × askers + votes + 3 if asked in the last 2 minutes`; ties go to the earlier question.
- Glasses: top 5 pushed only when the list or counts change, at most every 5 s; header shows elapsed time.
- Edits: an edited question leaves its cluster and is classified again.
- Resilience: if Claude fails, refuses or skips a message, the keyword heuristic classifies that batch.
  The heuristic never false-merges on the fixtures but merges only ~46 % of paraphrases, so the demo needs the key.
- `fixtures/questions.json`: the spec's 40-message burst with labels. `pnpm --filter @answered/server
  eval:clusters` prints the scorecard locally; `GET /debug/eval` (Bearer glasses token) runs it on Railway
  with the server's own key.
- Spec gap: the seeding plan uses 3–6 Telegram accounts, but askers are unique people, so the demo
  can show at most 6 askers on one question, not "14 asked". Either recruit more accounts or show asks.

## Phase 3 — Speech ✔ (code complete; live transcription needs DEEPGRAM_API_KEY)

- Deepgram live over a raw WebSocket, checked against the v1/listen reference on 26 Nov:
  `Authorization: Token <key>`; nova-3, linear16, 16 kHz, mono, smart_format, interim_results,
  endpointing 300 ms, utterance_end_ms 1500, vad_events; one `keyterm` parameter per term (Nova-3 only).
  Two spec corrections: KeepAlive every 3–5 s (spec said 8; 10 s idle closes the stream with NET-0001),
  and keyterms are repeated parameters, not a list. Using `ws` directly avoids the SDK's v3→v5 API churn.
- Audio path: glasses binary frame → hub → SpeechService → the most recently started live session's
  stream (until pairing ties glasses to a host). No live session or no key: audio is dropped.
- Timestamps: Deepgram's word times are audio time, which stops while the glasses are away. An
  `AudioClock` records when each chunk was handed over and maps audio time back to wall time, so
  segment times are true seconds since `/live` even across gaps and reconnects.
- Resilience: reconnect with backoff (0.5→8 s) keeping the last 5 s of audio so the start of an answer
  is not lost; a refused key (401/402/403) stops retrying; idle streams close after 60 s; `/end` sends
  CloseStream and the transcript is deleted with the session.
- Events for phase 4: `segment` (final text, with `speechFinal`), `utterance_end`, `interim`.
- `fixtures/host.wav` (27.6 s, TTS) + `fixtures/host.json`: a real mainnet answer, a talk-around on
  unlocks with no dates (must stay open), and a bridge answer. `pnpm --filter @answered/server
  replay-audio [file] [--speed N]` streams any 16 kHz mono WAV into `/ws/glasses` like G2 and prints the
  stored transcript; `GET /debug/transcript` (Bearer glasses token) shows it on Railway.
- Not done: the prerecorded-endpoint fallback (live stream reconnects instead), and filtering frames by
  the SDK's `speakerRole` (the binary frames carry no metadata yet; revisit if room audio leaks in).

## Phase 4 — Answer matcher and write-back

- Always judge the **taken** question at each utterance end; use the embedding gate only for
  the other top-3 open questions (a 0.50 gate drops real answers).
- Sonnet judge with JSON output; quote check done in code after normalising case and
  punctuation (token overlap, not exact match); confidence ≥ 0.75; 1.5 s silence.
- Undo window: `Sending in 3s` on the HUD, press = send now, swipe = cancel.
- Write-back: one threaded reply mentioning askers (cap 10, `+N others`), then reactions on each
  asker's message using a standard reaction (**not ✅**, which bots cannot set; use 👌 or 💯).

## Phase 5 — Glasses experience and pairing

- Six screens (Pair, Lobby, Queue, Taking, Answered, Still open) plus Sending/undo; list
  rebuild at most every 5 s and only when the top 5 change; text updates debounced ~120 ms.
- Input map from the spec. Double-tap is the platform's usual "exit app" gesture, so keep
  an exit path on the Pair and Lobby screens.
- Pairing: glasses show a 4-digit code; recommended flow is `/pair 4821` sent in the group by an
  admin (no web page, no `/setdomain`). The spec's Telegram Login page is the alternative.
- Lifecycle: on `FOREGROUND_ENTER_EVENT` reconnect, re-enable audio, re-render.

## Phase 6 — Recap, seed audience, eval and tuning

- Recap from an HTML template (no LLM), pinned; public recap page without asker names.
- `scripts/seed.ts` (GramJS user accounts, ≤ 1 msg/s per account, private test group).
- `scripts/eval.ts` scorecard: detection ≥ 95 %, merges ≥ 90 %, every scripted answer matched,
  0 false "answered", median reply ≤ 6 s, 0 × 429.
- If possible, run one real 10-minute session in a real community and note it for the README.

## Phase 7 — Ship

- README: what it does, setup, architecture, "what existed before 23 Nov", eval results,
  privacy (audio not stored, transcripts and messages deleted at session end), 5 feature requests.
- Demo video (≤ 3 min) following the spec's script; `.ehpk` on a GitHub release.
- DoraHacks submission: Track 01, also eligible for Best Telegram integration and the Grand Prize.
- Check `git log -p | grep -i key` before making the repo public; keep the server up through 3 Dec.
