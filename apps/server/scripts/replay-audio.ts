// Streams a WAV into WS /ws/glasses exactly as the G2 app would (100 ms frames, real time),
// so the speech path can be tested and the demo recorded without the room's acoustics.
//   WS_URL=wss://<server>/ws/glasses GLASSES_DEV_TOKEN=... pnpm --filter @answered/server replay-audio [file.wav] [--speed 2]
// Needs a live session (send /live in the group first); afterwards prints the stored transcript.
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { readPcmWav } from '../src/speech/wav.js'

const args = process.argv.slice(2)
const speedAt = args.indexOf('--speed')
const speed = speedAt >= 0 ? Number(args[speedAt + 1]) || 1 : 1
const file =
  args.find((a, i) => !a.startsWith('--') && i !== speedAt + 1) ?? fileURLToPath(new URL('../../../fixtures/host.wav', import.meta.url))
const base = process.env.WS_URL ?? 'ws://localhost:8787/ws/glasses'
const token = process.env.GLASSES_DEV_TOKEN ?? ''
const FRAME = 3200 // 100 ms

const pcm = readPcmWav(file)
console.log(`${file}: ${(pcm.length / 32000).toFixed(1)} s of audio -> ${base} at ${speed}x`)

const ws = new WebSocket(`${base}?token=${encodeURIComponent(token)}`)
ws.on('close', (code) => {
  if (code === 4401) console.error('Rejected: GLASSES_DEV_TOKEN does not match the server.')
})
ws.on('error', (err) => {
  console.error(`socket error: ${err.message}`)
  process.exit(1)
})
ws.on('open', async () => {
  ws.send(JSON.stringify({ t: 'hello', app: 'replay-audio', version: '0', mic: 'glasses' }))
  const started = Date.now()
  for (let i = 0, n = 0; i < pcm.length; i += FRAME, n++) {
    ws.send(pcm.subarray(i, i + FRAME), { binary: true })
    // Pace against the start time so timer drift does not stretch the audio.
    const due = started + ((n + 1) * 100) / speed
    await new Promise((r) => setTimeout(r, Math.max(0, due - Date.now())))
  }
  console.log('audio sent; waiting for the last results...')
  await new Promise((r) => setTimeout(r, 4000))

  const http = base.replace(/^ws/, 'http').replace(/\/ws\/glasses$/, '')
  const res = await fetch(`${http}/debug/transcript`, { headers: { authorization: `Bearer ${token}` } })
  const body = (await res.json()) as { session: string | null; speech: boolean; segments: Array<{ startS: number; endS: number; text: string }> }
  if (!body.session) console.log('No live session: send /live in the group, then replay again.')
  else if (!body.speech) console.log('Speech is off on the server: set DEEPGRAM_API_KEY.')
  for (const s of body.segments) console.log(`  [${s.startS.toFixed(1)}-${s.endS.toFixed(1)}s] ${s.text}`)
  ws.close()
})
