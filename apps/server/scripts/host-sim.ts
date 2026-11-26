// Plays the host's part without glasses: connects as G2, takes the top question with a press,
// streams a WAV as the host's voice, and prints every screen the server sends.
//   WS_URL=wss://<server>/ws/glasses GLASSES_DEV_TOKEN=... pnpm --filter @answered/server host-sim [file.wav] [--no-take]
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import type { ServerMessage } from '@answered/protocol'
import { readPcmWav } from '../src/speech/wav.js'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--')) ?? fileURLToPath(new URL('../../../fixtures/host.wav', import.meta.url))
const take = !args.includes('--no-take')
const base = process.env.WS_URL ?? 'ws://localhost:8787/ws/glasses'
const pcm = readPcmWav(file)
const started = Date.now()
const stamp = () => `${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s`

const ws = new WebSocket(`${base}?token=${encodeURIComponent(process.env.GLASSES_DEV_TOKEN ?? '')}`)
let taken = false
let done: () => void
const finished = new Promise<void>((r) => (done = r))

ws.on('message', (data) => {
  const m = JSON.parse(data.toString()) as ServerMessage
  if (m.t !== 'screen') return
  const { t: _t, view, ...rest } = m
  console.log(`${stamp()}  ${view.padEnd(10)} ${JSON.stringify(rest)}`)
  if (view === 'queue' && take && !taken && 'items' in m && m.items.length) {
    taken = true
    console.log(`${stamp()}  >> press (take "${m.items[0]!.title}")`)
    ws.send(JSON.stringify({ t: 'input', g: 'press', src: 'ring' }))
    void play()
  }
  if (taken && view === 'queue' && Date.now() - started > 5000) done()
})
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', app: 'host-sim', version: '0', mic: 'glasses' }))
  if (!take) void play()
})

async function play() {
  console.log(`${stamp()}  >> speaking ${(pcm.length / 32000).toFixed(1)} s of audio`)
  const t0 = Date.now()
  for (let i = 0, n = 0; i < pcm.length; i += 3200, n++) {
    ws.send(pcm.subarray(i, i + 3200), { binary: true })
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + (n + 1) * 100 - Date.now())))
  }
  console.log(`${stamp()}  >> finished speaking`)
  setTimeout(() => done(), 15000)
}

await finished
ws.close()
process.exit(0)
