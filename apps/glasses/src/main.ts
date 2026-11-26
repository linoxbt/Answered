import { AudioInputSource, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { MicSource, ServerMessage } from '@answered/protocol'
import { ServerConnection, type ConnectionState } from './connection'
import { Display, screenToText } from './display'
import { toInputAction } from './input'

const APP_VERSION = '0.2.0'
const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8787/ws/glasses'
const TOKEN_KEY = 'hostToken'

// Companion view on the phone: a small status readout.
const statusEl = document.getElementById('app')!
const status = { conn: 'starting' as ConnectionState | 'starting', mic: 'off', paired: '', screen: '' }
function showStatus() {
  const kb = (connection.audioBytesSent / 1024).toFixed(0)
  statusEl.innerText = [`Server: ${status.conn}`, status.paired, `Mic: ${status.mic} | ${kb} KB sent`, '', status.screen]
    .filter((l) => l !== undefined)
    .join('\n')
}

const bridge = await waitForEvenAppBridge()
const display = new Display(bridge)
if (!(await display.init('ANSWERED\n\nConnecting...'))) console.warn('createStartUpPageContainer failed')

// The host token comes from pairing (/pair <code> in the group). A dev token can be baked in for the
// simulator only; release builds leave VITE_DEV_HOST_TOKEN unset.
let token = (await bridge.getLocalStorage(TOKEN_KEY)) || import.meta.env.VITE_DEV_HOST_TOKEN || ''
const urlFor = (t: string) => `${WS_URL}?token=${encodeURIComponent(t)}`
status.paired = token ? 'Paired' : 'Not paired'

let mic: MicSource | null = null
async function setMic(on: boolean, source: MicSource = 'glasses') {
  const ok = await bridge.audioControl(on, source === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses)
  mic = on && ok ? source : null
  status.mic = on ? (ok ? source : `${source} failed`) : 'off'
  showStatus()
}

async function useToken(next: string) {
  token = next
  await bridge.setLocalStorage(TOKEN_KEY, next)
  status.paired = next ? 'Paired' : 'Not paired'
  connection.setUrl(urlFor(next))
}

function onServerMessage(msg: ServerMessage) {
  switch (msg.t) {
    case 'screen':
      display.render(msg)
      status.screen = screenToText(msg)
      showStatus()
      return
    case 'audio':
      void setMic(msg.on, msg.source)
      return
    case 'exit':
      void bridge.shutDownPageContainer(1) // system exit confirmation
      return
    case 'paired':
      status.paired = `Paired with ${msg.group}`
      display.setText(`ANSWERED\n\nPaired with ${msg.group}`)
      // The server closes this socket; the reconnect uses the new token.
      void useToken(msg.token)
      return
    case 'unpaired':
      void useToken('')
      return
  }
}

const connection = new ServerConnection(urlFor(token), {
  onOpen: () => connection.send({ t: 'hello', app: 'answered-glasses', version: APP_VERSION, mic: mic ?? 'glasses' }),
  onMessage: onServerMessage,
  onState: (state) => {
    status.conn = state
    showStatus()
    if (state === 'unauthorized') {
      // The token was revoked (re-paired elsewhere or forgotten): start pairing again.
      void useToken('').then(() => connection.restart())
    } else if (state !== 'open') {
      display.setText('ANSWERED\n\nReconnecting...')
    }
  },
})

// In the queue's native list the ring scrolls on the glasses; the server only needs the press and its row.
let listIndex = 0
const unsubscribe = bridge.onEvenHubEvent((event) => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    connection.sendAudio(pcm)
    return
  }
  if (typeof event.listEvent?.currentSelectItemIndex === 'number') listIndex = event.listEvent.currentSelectItemIndex

  const action = toInputAction(event)
  if (!action) return
  switch (action.kind) {
    case 'gesture': {
      if (display.layout === 'list' && (action.g === 'next' || action.g === 'prev')) return
      const idx = display.layout === 'list' ? (action.idx ?? listIndex) : action.idx
      if (connection.state === 'open') connection.send({ t: 'input', g: action.g, src: action.src, idx })
      else if (action.g === 'double') void bridge.shutDownPageContainer(1) // exit still works offline
      return
    }
    case 'foreground':
      // Android may drop the socket and the mic while the WebView is suspended.
      connection.ensureConnected()
      connection.send({ t: 'resume' })
      if (mic) void setMic(true, mic)
      return
    case 'exit':
      unsubscribe()
      connection.close()
      return
  }
})

setInterval(showStatus, 1000)
connection.connect()
