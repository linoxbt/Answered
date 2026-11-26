import { loadConfig } from './config.js'
import { buildApp, createLogger } from './app.js'
import type { Bot } from 'grammy'
import { createBot } from './telegram/bot.js'

const config = loadConfig()
const log = createLogger(config.LOG_LEVEL)

let bot: Bot | undefined
if (config.TG_BOT_TOKEN) {
  bot = createBot(config.TG_BOT_TOKEN, log)
  await bot.init() // fetches getMe; handleUpdate needs it
  log.info({ username: bot.botInfo.username }, 'telegram bot ready')
} else {
  log.warn('TG_BOT_TOKEN not set: webhook updates are logged but not handled')
}

const { app } = await buildApp(config, { bot, logger: log })

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    process.exit(0)
  })
}

await app.listen({ port: config.PORT, host: config.HOST })
