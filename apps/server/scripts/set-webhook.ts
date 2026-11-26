// Points the Telegram bot at this server: pnpm --filter @answered/server set-webhook
// Needs TG_BOT_TOKEN, TG_WEBHOOK_SECRET and PUBLIC_URL (HTTPS, port 443/80/88/8443).
import { Bot } from 'grammy'
import { loadConfig } from '../src/config.js'
import { ALLOWED_UPDATES } from '../src/telegram/bot.js'

const config = loadConfig()
if (!config.TG_BOT_TOKEN || !config.TG_WEBHOOK_SECRET || !config.PUBLIC_URL) {
  console.error('Set TG_BOT_TOKEN, TG_WEBHOOK_SECRET and PUBLIC_URL first.')
  process.exit(1)
}
if (!config.PUBLIC_URL.startsWith('https://')) {
  console.error('PUBLIC_URL must be https:// - Telegram only delivers webhooks over HTTPS.')
  process.exit(1)
}

const bot = new Bot(config.TG_BOT_TOKEN)
const url = `${config.PUBLIC_URL.replace(/\/$/, '')}/tg/webhook`

await bot.api.setWebhook(url, {
  secret_token: config.TG_WEBHOOK_SECRET,
  allowed_updates: [...ALLOWED_UPDATES],
  drop_pending_updates: true,
})
const info = await bot.api.getWebhookInfo()
const me = await bot.api.getMe()
console.log(`@${me.username} -> ${info.url}`)
console.log(`allowed_updates: ${(info.allowed_updates ?? []).join(', ')}`)
console.log(`can_read_all_group_messages (privacy disabled): ${me.can_read_all_group_messages}`)
if (!me.can_read_all_group_messages) {
  console.log('Tip: BotFather /setprivacy -> Disable, or make the bot a group admin, so it sees every question.')
}
if (info.last_error_message) console.log(`last error: ${info.last_error_message}`)
