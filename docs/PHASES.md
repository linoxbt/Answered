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

## Phase 4 — Answer matcher and write-back ✔ (live on Railway)

**Judge eval (`fixtures/answers.json`, 10 cases from the demo script, Claude Sonnet 5.5, 5 runs):**
50/50 cases right, 0 false "answered", 0 missed answers, median 1.8 s per call. Cases include the
real Deepgram transcript ("q one", "launch May"), the unlock talk-around, an answer to the wrong
question, a related-only question, "we'll share the date next week", and an answer to a question the
host did not take. `pnpm --filter @answered/server eval:answers` re-runs it.

- When: on Deepgram's UtteranceEnd (1.5 s of silence = the spec's silence rule) while a question is
  taken. One judge call checks the taken question plus the top 3 other open questions; a call already
  in flight re-runs once with the longer transcript.
- Window: speech since 5 s before the press (hosts start answering, then press), at most 120 s.
- Judge: Sonnet 5.5, thinking off (`between_tools`), effort low, structured output, server-side
  refusal fallbacks on (`fallbacks: "default"`); a refusal through the chain counts as not answered.
- Accept (in code): answered, confidence ≥ 0.75 for the taken question and ≥ 0.85 for others,
  non-empty summary, and ≥ 85 % of the quote's words found in order in the transcript after normalising
  case, punctuation and number words ("q one" = "Q1"). Otherwise the HUD flashes Still open.
- Undo window (3 s, `UNDO_MS`): HUD shows "Sending to N in 3s"; press = send now, swipe = cancel.
- Write-back: one HTML reply threaded to the first asker, "Answered at MM:SS: <summary>", mentions of up
  to 10 askers (+N others), then 👍 on each asker's message (max 15) at low priority in the same rate
  budget; 👀 on the first asker's message when the host takes the question.
- Manual: press while taking marks it answered; the summary comes from the same transcript window.
- Repeats: a new message that joins an answered question gets a reply with the earlier answer and a link.
- Gestures (phase 5 polishes the screens): queue press = take, swipe = select; taking press = answered,
  swipe = skip, double = put back; sending press = now, swipe/double = cancel.

## Phase 5 — Glasses experience and pairing ✔ (server live; release .ehpk built)

- Pairing: glasses without a token connect and get a 4-digit code (10-minute, single use). A group admin
  sends `/pair <code>`; the server issues a host token (rotating any older one), remembers the group, and
  sends it to the glasses, which store it with `setLocalStorage` and reconnect. A revoked token (4401)
  sends the glasses back to pairing. No token is baked into the release build.
- Routing: each host's glasses follow their paired group's session (screens, audio, gestures). The dev
  token still follows the newest live session, for the test scripts. `/live` in the group and "press to go
  live" on the glasses both post the opening message (now driven by session events, as is the end message).
- Screens (screenshots in `docs/img/glasses-screens.png`, taken in the headless simulator): pair, lobby,
  queue as a native list with a header line, taking, sending, answered, still open, confirm end, ended.
  The list scrolls on the glasses without a server round trip; a press sends the selected row's index.
  List items change only by page rebuild (server throttles to 5 s); the header and text screens update in place.
- Input map as in the README table. Platform conflict resolved: double = exit on the pair and lobby
  screens; in the queue double asks to end the session (a second double ends it, anything else cancels).
  After "Session ended", the first press shows the lobby, so a stray press never starts a new session.
- Spam: long press in the queue deletes the selected question's messages and drops it from the queue.
- Release build: `pnpm --filter @answered/glasses ehpk` (`.env.production`: Railway URL, empty dev token).
  Checked: the bundle contains the Railway URL and not the dev token.
- Not done: the phone-side pairing page (the bot command replaced it), and per-message speaker filtering.

## Phase 6 — Recap, seed audience, eval and tuning ✔ (rehearsal with real accounts pending)

- Recap at `/end` (or double, double on the glasses): a template, not a model, so it cannot invent anything.
  Every answered question with its one-line answer, time and a link to the reply, then everything still
  open; pinned without a notification; "Full recap" links to `/recap/<session id>`, a public page with no
  names. Pending messages are classified before the session ends, so last-second questions are included.
- Asks and people: the glasses show every ask ("14 asked", the spec's demo number); ranking and mentions
  count unique people, so one account can't push its own question up. Replies say "asked 14 times by 6 people".
- Spam flagged on the glasses is left out of the recap; questions the host skipped stay in "Still open".
- Pairing codes refresh before they expire, so glasses can wait on the pairing screen indefinitely.
- `tools/seed`: `login` (run per audience account on your own machine; prints a session string) and
  `seed` (posts the 40-message burst from 1-6 accounts, at most once per 1.1 s per account; `--dry-run`).
  Not run yet: it needs API credentials from my.telegram.org and audience accounts.
- Scorecard: `docs/SCORECARD.md` (`pnpm --filter @answered/server scorecard`). All model targets met;
  latency median 6.1 s including the 3 s undo window (3.1 s without).

## Phase 7 — Ship

- README: what it does, setup, architecture, "what existed before 23 Nov", eval results,
  privacy (audio not stored, transcripts and messages deleted at session end), 5 feature requests.
- Demo video (≤ 3 min) following the spec's script; `.ehpk` on a GitHub release.
- DoraHacks submission: Track 01, also eligible for Best Telegram integration and the Grand Prize.
- Check `git log -p | grep -i key` before making the repo public; keep the server up through 3 Dec.
