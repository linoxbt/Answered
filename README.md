# Answered

Answer a Telegram audience out loud, once. Answered runs on Even Realities G2 glasses:
questions from a Telegram group are merged and ranked on the display, the host takes one
with a ring or temple press and answers naturally, and the bot replies in the group to
everyone who asked. A question that was only talked around stays open.

Built for the [Heads Up: Even Realities Hackathon](https://dorahacks.io/hackathon/even-realities/detail)
(Track 01 · Messaging & News). The build plan is in [docs/PHASES.md](docs/PHASES.md).

> Status: **phases 0-4 of 0-7 done**: questions are detected and ranked, the host answers out loud, and Answered replies to everyone who asked.
> Glasses screens, pairing, the recap and the demo tooling land in phases 5-6.

![Phase 0 in the Even Hub simulator](docs/img/phase0-simulator.png)

## Layout

```
apps/glasses     G2 app (Vite + TypeScript + Even Hub SDK), from evenhub-templates/minimal
apps/server      Fastify server: Telegram webhook, glasses WebSocket, pipeline (later phases)
packages/protocol  Message types shared by both over WS /ws/glasses
docs/            Build phases and notes
```

The glasses app is a thin client: it streams mic audio (PCM s16le, 16 kHz, mono) and
gestures to the server and renders the screens the server pushes. No API keys ship in the app.

## Run locally

Requires Node 22+ and pnpm 10.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env        # GLASSES_DEV_TOKEN=dev is enough for phase 0
cp apps/glasses/.env.example apps/glasses/.env.local

pnpm dev:server                                     # http://localhost:8787
pnpm dev:glasses                                    # http://localhost:5173
pnpm --filter @answered/glasses simulate            # Even Hub simulator
```

The simulator should show `ANSWERED phase 0` with a live mic level; press, swipe and
long-press show up as "Last input", and double-tap exits.

Without glasses or a simulator, check the socket with
`GLASSES_DEV_TOKEN=dev pnpm --filter @answered/server ws-smoke`.

### Telegram webhook

1. BotFather: `/newbot`, `/setprivacy` → Disable, `/setjoingroups` → Enable; add the bot to a test
   supergroup as an admin (needed for reaction updates).
2. Deploy the server behind HTTPS and set `PUBLIC_URL`, `TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET`.
3. `pnpm --filter @answered/server set-webhook`, then send `/ping` in the group.
4. An admin sends `/live` to start a Q&A and `/end` to close it.

### Deploying on Railway

One service from this repo; Railway runs `pnpm start` (the server). Add a volume mounted at
`/data`, set `DATABASE_URL=file:/data/answered.db`, and copy the variables from
`apps/server/.env.example`. Generate a public domain and use it as `PUBLIC_URL`.

### Packaging

`pnpm --filter @answered/glasses pack` builds `answered.ehpk`. Before packing, put the
deployed server's origins in `apps/glasses/app.json` → `network.whitelist` (both the
`https://` and the `wss://` origin); requests to anything else are blocked on the device.

### Headless simulator (Linux CI or cloud containers)

The simulator needs WebKitGTK, a display and an audio input:

```bash
apt-get install -y libwebkit2gtk-4.1-0 xvfb xauth pulseaudio libasound2-plugins
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=virt && pactl set-default-source virt.monitor
printf 'pcm.!default { type pulse }\nctl.!default { type pulse }\n' > ~/.asoundrc
xvfb-run -a npx evenhub-simulator --automation-port 9898 --aid alsa:default http://localhost:5173
paplay --device=virt some-speech.wav                 # feeds the simulated glasses mic
curl localhost:9898/api/screenshot/glasses -o glasses.png
```

## Tests

```bash
pnpm test        # protocol, webhook secret, glasses socket, outbox limits, /live and /end flows, database
pnpm typecheck
```

## What existed before 23 Nov

The official `evenhub-templates/minimal` template (index.html, Vite and TS config), the
Even Hub SDK, CLI and simulator, and open-source libraries (Fastify, grammY, ws, zod).
Everything else in this repository was written during build week.

## License

MIT
