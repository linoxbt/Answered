// Posts the demo burst (fixtures/questions.json) into the group from real user accounts.
// Bots never see messages from other bots, so the audience has to be real accounts.
//   pnpm --filter @answered/seed seed -- --dry-run          show the plan, send nothing
//   pnpm --filter @answered/seed seed                       post it (start the session with /live first)
// Env (tools/seed/.env): TG_API_ID, TG_API_HASH, TG_SESSIONS (from `login`, comma-separated),
// SEED_CHAT: the group's @username, t.me link, or exact title as it appears in your chat list.
// Options: --duration <seconds> (default 30), --limit <n> messages, --fixtures <path>.
import { fileURLToPath } from 'node:url'
import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { loadFixtures, plan } from './plan.js'

const args = process.argv.slice(2)
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const dryRun = args.includes('--dry-run')
const fixtures = loadFixtures(opt('fixtures') ?? fileURLToPath(new URL('../../../fixtures/questions.json', import.meta.url)))
const messages = fixtures.slice(0, Number(opt('limit') ?? fixtures.length))
const sessions = (process.env.TG_SESSIONS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const accounts = dryRun ? Math.max(sessions.length, Number(opt('accounts') ?? 3)) : sessions.length
const schedule = plan(messages, accounts, Number(opt('duration') ?? 30) * 1000)

if (dryRun) {
  console.log(`Plan: ${schedule.length} messages from ${accounts} accounts over ${(schedule.at(-1)!.at / 1000).toFixed(1)} s\n`)
  for (const m of schedule) console.log(`  ${(m.at / 1000).toFixed(1).padStart(5)} s  account ${m.account + 1}  [${m.expect ?? 'chatter'}] ${m.text}`)
  process.exit(0)
}

const apiId = Number(process.env.TG_API_ID)
const apiHash = process.env.TG_API_HASH ?? ''
const chat = process.env.SEED_CHAT ?? ''
if (!apiId || !apiHash || !sessions.length || !chat) {
  console.error('Set TG_API_ID, TG_API_HASH, TG_SESSIONS (run `login` per account) and SEED_CHAT. Or use --dry-run.')
  process.exit(1)
}

const clients: TelegramClient[] = []
for (const s of sessions) {
  const client = new TelegramClient(new StringSession(s), apiId, apiHash, { connectionRetries: 3 })
  await client.connect()
  clients.push(client)
}

/** Finds the group for one account: by @username / link, or by exact title among its chats. */
async function resolveChat(client: TelegramClient) {
  if (chat.startsWith('@') || chat.includes('t.me/')) return client.getEntity(chat)
  const dialogs = await client.getDialogs({ limit: 200 })
  const match = dialogs.find((d) => d.title === chat)
  if (!match?.entity) throw new Error(`An account is not in a chat titled "${chat}". Add it to the group first.`)
  return match.entity
}
const targets = await Promise.all(clients.map(resolveChat))
for (const [i, c] of clients.entries()) {
  const me = await c.getMe()
  console.log(`account ${i + 1}: ${me.firstName ?? ''} @${me.username ?? '-'}`)
}

console.log(`\nPosting ${schedule.length} messages over ${(schedule.at(-1)!.at / 1000).toFixed(0)} s...`)
const started = Date.now()
for (const m of schedule) {
  await new Promise((r) => setTimeout(r, Math.max(0, started + m.at - Date.now())))
  try {
    await clients[m.account]!.sendMessage(targets[m.account]!, { message: m.text })
    console.log(`  ${((Date.now() - started) / 1000).toFixed(1).padStart(5)} s  #${m.account + 1}  ${m.text}`)
  } catch (err) {
    // FloodWait and similar: report and keep going; the burst is a demo, not a load test.
    console.error(`  failed (#${m.account + 1}): ${(err as Error).message}`)
  }
}
await Promise.all(clients.map((c) => c.disconnect()))
console.log('done')
process.exit(0)
