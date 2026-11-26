// Run once per audience account, on your own machine:  pnpm --filter @answered/seed login
// Needs TG_API_ID and TG_API_HASH from https://my.telegram.org (API development tools).
// Prints a session string; put it in TG_SESSIONS (comma-separated) in tools/seed/.env. Treat it like a password.
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const apiId = Number(process.env.TG_API_ID)
const apiHash = process.env.TG_API_HASH ?? ''
if (!apiId || !apiHash) {
  console.error('Set TG_API_ID and TG_API_HASH (from https://my.telegram.org) first.')
  process.exit(1)
}
const rl = createInterface({ input: stdin, output: stdout })
const client = new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 3 })
await client.start({
  phoneNumber: () => rl.question('Phone number (international format): '),
  phoneCode: () => rl.question('Code Telegram just sent you: '),
  password: () => rl.question('Two-step verification password (if set): '),
  onError: (err) => console.error(err.message),
})
const me = await client.getMe()
console.log(`\nLogged in as ${me.firstName ?? ''} (@${me.username ?? 'no username'}). Session string:\n`)
console.log(client.session.save())
rl.close()
await client.disconnect()
process.exit(0)
