import { z } from 'zod'

const optional = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined))

const ConfigSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(8787),
    HOST: z.string().default('0.0.0.0'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    /** Public HTTPS origin of this server, e.g. https://api.answered.app (needed for the webhook). */
    PUBLIC_URL: optional,
    CORS_ORIGIN: z.string().default('*'),

    TG_BOT_TOKEN: optional,
    /** Sent back by Telegram in X-Telegram-Bot-Api-Secret-Token on every webhook call. */
    TG_WEBHOOK_SECRET: optional.pipe(
      z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,256}$/, 'TG_WEBHOOK_SECRET must be 1-256 chars of A-Z a-z 0-9 _ -')
        .optional(),
    ),

    /**
     * Phase 0 only: the token the glasses use on WS /ws/glasses until pairing (phase 5)
     * issues real host tokens. Leave empty to refuse every glasses connection.
     */
    GLASSES_DEV_TOKEN: optional,
  })
  .refine((c) => !c.TG_BOT_TOKEN || c.TG_WEBHOOK_SECRET, {
    message: 'TG_WEBHOOK_SECRET is required when TG_BOT_TOKEN is set',
    path: ['TG_WEBHOOK_SECRET'],
  })

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = ConfigSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid configuration:\n${issues}`)
  }
  return parsed.data
}
