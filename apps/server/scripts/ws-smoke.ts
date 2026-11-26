// Day-1 risk check without glasses: acts like the G2 app on WS /ws/glasses.
// Sends 3 s of silent PCM in 100 ms frames plus a ring press, then prints what the server saw.
//   WS_URL=ws://localhost:8787/ws/glasses GLASSES_DEV_TOKEN=dev pnpm --filter @answered/server ws-smoke
import WebSocket from 'ws'
import type { ServerMessage } from '@answered/protocol'

const base = process.env.WS_URL ?? 'ws://localhost:8787/ws/glasses'
const token = process.env.GLASSES_DEV_TOKEN ?? ''
const FRAME_BYTES = 3200 // 100 ms of s16le @ 16 kHz mono
const FRAMES = 30

const ws = new WebSocket(`${base}?token=${encodeURIComponent(token)}`)
const received: ServerMessage[] = []

ws.on('message', (data) => received.push(JSON.parse(data.toString()) as ServerMessage))
ws.on('close', (code, reason) => {
  if (code === 4401) {
    console.error('Rejected: GLASSES_DEV_TOKEN does not match the server.')
    process.exit(1)
  }
  console.log(`closed ${code} ${reason}`)
})
ws.on('error', (err) => {
  console.error(`socket error: ${err.message}`)
  process.exit(1)
})

ws.on('open', async () => {
  ws.send(JSON.stringify({ t: 'hello', app: 'ws-smoke', version: '0', mic: 'glasses' }))
  for (let i = 0; i < FRAMES; i++) {
    ws.send(Buffer.alloc(FRAME_BYTES), { binary: true })
    await new Promise((r) => setTimeout(r, 100))
  }
  ws.send(JSON.stringify({ t: 'input', g: 'press', src: 'ring' }))
  await new Promise((r) => setTimeout(r, 1500))

  const httpBase = base.replace(/^ws/, 'http').replace(/\/ws\/glasses$/, '')
  const res = await fetch(`${httpBase}/debug/stats`, { headers: { authorization: `Bearer ${token}` } })
  const stats = (await res.json()) as { connections: Array<{ audioBytes: number; inputs: number }> }
  const me = stats.connections.at(-1)
  const screens = received.filter((m) => m.t === 'screen').length
  const audioOn = received.some((m) => m.t === 'audio' && m.on)

  console.log(`sent      ${FRAMES * FRAME_BYTES} audio bytes, 1 input`)
  console.log(`server    ${me?.audioBytes ?? 0} audio bytes, ${me?.inputs ?? 0} inputs`)
  console.log(`glasses   ${screens} screen updates, mic turned on: ${audioOn}`)
  const ok = me?.audioBytes === FRAMES * FRAME_BYTES && me.inputs === 1 && screens > 0 && audioOn
  console.log(ok ? 'PASS' : 'FAIL')
  ws.close()
  process.exitCode = ok ? 0 : 1
})
