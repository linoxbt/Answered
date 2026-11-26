import { AudioInputSource, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import type { MicSource, ServerMessage } from '@answered/protocol'
import { ServerConnection, type ConnectionState } from './connection'
import { Display, screenToText } from './display'
import { toInputAction } from './input'

const APP_VERSION = '0.1.0'
const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8787/ws/glasses'

// Companion view on the phone: a small status readout for debugging.
const statusEl = document.getElementById('app')!
const status = { conn: 'starting' as ConnectionState | 'starting', mic: 'off', screen: '' }
function showStatus(connection?: ServerConnection) {
  const kb = connection ? (connection.audioBytesSent / 1024).toFixed(0) : '0'
  statusEl.innerText = [
    `Server: ${status.conn}`,
    `Mic: ${status.mic} | ${kb} KB sent`,
    '',
    status.screen,
  ].join('\n')
}

const bridge = await waitForEvenAppBridge()
const display = new Display(bridge)
const created = await display.init('ANSWERED\n\nConnecting...')
if (!created) console.warn('createStartUpPageContainer failed')

// Pairing (phase 5) stores the host token on the device; until then a dev token is baked in.
const token = (await bridge.getLocalStorage('hostToken')) || import.meta.env.VITE_DEV_HOST_TOKEN || ''

let mic: MicSource | null = null
async function setMic(on: boolean, source: MicSource = 'glasses') {
  const sdkSource = source === 'phone' ? AudioInputSource.Phone : AudioInputSource.Glasses
  const ok = await bridge.audioControl(on, sdkSource)
  mic = on && ok ? source : null
  status.mic = on ? (ok ? source : `${source} failed`) : 'off'
  showStatus(connection)
}

function onServerMessage(msg: ServerMessage) {
  switch (msg.t) {
    case 'screen':
      display.render(msg)
      status.screen = screenToText(msg)
      showStatus(connection)
      return
    case 'audio':
      void setMic(msg.on, msg.source)
      return
    case 'exit':
      // Shows the system's exit confirmation.
      void bridge.shutDownPageContainer(1)
      return
  }
}

const connection = new ServerConnection(`${WS_URL}?token=${encodeURIComponent(token)}`, {
  onOpen: () => connection.send({ t: 'hello', app: 'answered-glasses', version: APP_VERSION, mic: mic ?? 'glasses' }),
  onMessage: onServerMessage,
  onState: (state) => {
    status.conn = state
    showStatus(connection)
    if (state === 'unauthorized') display.setText('ANSWERED\n\nNot paired with the server.\nCheck the host token.')
    else if (state !== 'open') display.setText('ANSWERED\n\nReconnecting...')
  },
})

const unsubscribe = bridge.onEvenHubEvent((event) => {
  const pcm = event.audioEvent?.audioPcm
  if (pcm) {
    connection.sendAudio(pcm)
    return
  }

  const action = toInputAction(event)
  if (!action) return
  switch (action.kind) {
    case 'gesture':
      if (connection.state === 'open') {
        connection.send({ t: 'input', g: action.g, src: action.src, idx: action.idx })
      } else if (action.g === 'double') {
        // Keep the platform's exit gesture working while the server is unreachable.
        void bridge.shutDownPageContainer(1)
      }
      return
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

setInterval(() => showStatus(connection), 1000)
connection.connect()
