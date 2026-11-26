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

## Phase 1 — Data model, sessions, Telegram core

- SQLite schema from the spec (6 tables) behind a small `db.ts`; on Railway, mount a volume
  or SQLite is wiped on every redeploy.
- `/live` and `/end` (group admins only, checked with `getChatMember`); opening message.
- Outbox: one queue per chat, 1 msg/s and 18/min. **Reactions share the same per-chat budget**
  and sit behind replies; `retry_after` handling.
- `my_chat_member` handling (bot added, removed, or promoted to admin).

## Phase 2 — Question pipeline

- Prefilter, then batched Haiku classification every 2 s (JSON output).
- Clustering: embeddings + 0.82 / 0.74 thresholds + Haiku "same question?" check between them.
  Fallback if the OpenAI key is a problem: let Haiku assign clusters directly (fewer than 500 questions).
- Ranking: `2 × unique_askers + votes + recency bonus`; reactions as votes.
- `fixtures/questions.json` (40 labelled messages) and a unit test that checks the clusters.

## Phase 3 — Speech

- Deepgram live bridge per session (Nova-3, linear16, 16 kHz). Note: `@deepgram/sdk` is now v5,
  so check the spec's v3-style snippet against the current API.
- Store final segments with session-relative timestamps; delete them at `/end`.
- Consider forwarding only frames whose `speakerRole` is `Self` (the host).
- `scripts/replay-audio.ts` streams a WAV into `/ws/glasses` as if it came from G2.
- Fallbacks: phone mic; prerecorded endpoint in 10 s chunks.

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
