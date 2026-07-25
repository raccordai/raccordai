import { randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { app, safeStorage } from 'electron'
import { z } from 'zod'
import { DEFAULT_LOCAL_API_PORT } from '@shared/config'
import {
  assistantModelSchema,
  assistantRunApprovalSchema,
  localeSchema,
  type AssistantModel,
  type AssistantRunApproval,
  type Locale
} from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { settings } from '../db/schema'

function getSetting(key: string): unknown {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get()
  return row?.value
}

function setSetting(key: string, value: unknown): void {
  getDb()
    .insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
    .run()
}

function detectSystemLocale(): Locale {
  const preferred = app.getPreferredSystemLanguages()[0] ?? app.getLocale()
  return preferred.toLowerCase().startsWith('fr') ? 'fr' : 'en'
}

export function getLocale(): Locale {
  const stored = localeSchema.safeParse(getSetting('locale'))
  return stored.success ? stored.data : detectSystemLocale()
}

export function setLocale(locale: Locale): void {
  setSetting('locale', locale)
}

const portSchema = z.number().int().min(1024).max(65535)

export function getLocalApiPort(): number {
  const stored = portSchema.safeParse(getSetting('localApiPort'))
  return stored.success ? stored.data : DEFAULT_LOCAL_API_PORT
}

/**
 * kie.ai API key — encrypted with the OS keychain (safeStorage), stored in the
 * settings table as base64. Never leaves the main process in clear text.
 */
export function setKieApiKey(key: string): void {
  const trimmed = key.trim()
  if (trimmed === '') {
    getDb().delete(settings).where(eq(settings.key, 'kieApiKeyEncrypted')).run()
    return
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS-level encryption is unavailable; refusing to store the API key.')
  }
  setSetting('kieApiKeyEncrypted', safeStorage.encryptString(trimmed).toString('base64'))
}

export function getKieApiKey(): string | null {
  const stored = getSetting('kieApiKeyEncrypted')
  if (typeof stored !== 'string' || stored === '') return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

export function kieApiKeyStatus(): { configured: boolean; encryptionAvailable: boolean } {
  return {
    configured: getKieApiKey() !== null,
    encryptionAvailable: safeStorage.isEncryptionAvailable()
  }
}

/**
 * First-run onboarding overlay — shown once, then never again (completing OR
 * skipping any step marks it done).
 */
export function getOnboardingCompleted(): boolean {
  return getSetting('onboardingCompleted') === true
}

export function setOnboardingCompleted(): void {
  setSetting('onboardingCompleted', true)
}

/**
 * Called at startup: existing users (a kie key already configured) never see
 * the first-run overlay — the setting is back-filled as completed.
 */
export function backfillOnboardingCompleted(): void {
  if (!getOnboardingCompleted() && getKieApiKey() !== null) setOnboardingCompleted()
}

const concurrencySchema = z.number().int().min(1).max(8)
const DEFAULT_MAX_CONCURRENT_GENERATIONS = 2

/** How many kie.ai generations may be in flight at once (queue slot count). */
export function getMaxConcurrentGenerations(): number {
  const stored = concurrencySchema.safeParse(getSetting('maxConcurrentGenerations'))
  return stored.success ? stored.data : DEFAULT_MAX_CONCURRENT_GENERATIONS
}

export function setMaxConcurrentGenerations(value: number): void {
  setSetting('maxConcurrentGenerations', concurrencySchema.parse(value))
}

/** OS notification when a generation settles while the window is unfocused. */
export function getNotifyOnCompletion(): boolean {
  return getSetting('notifyOnCompletion') !== false
}

export function setNotifyOnCompletion(enabled: boolean): void {
  setSetting('notifyOnCompletion', enabled)
}

/** Which kie.ai market model powers the embedded assistant. */
export function getAssistantModel(): AssistantModel {
  const stored = assistantModelSchema.safeParse(getSetting('assistantModel'))
  return stored.success ? stored.data : 'claude-opus-4-8'
}

export function setAssistantModel(model: AssistantModel): void {
  setSetting('assistantModel', assistantModelSchema.parse(model))
}

/**
 * Whether the assistant must ask before running anything that costs credits
 * (run_node, run_batch, finalize_video, review_generation). Defaults to 'ask':
 * the user validates a plan, then still decides when credits are actually
 * spent. 'auto' restores the previous behaviour (the assistant launches runs on
 * its own). Enforced in chat.ts through `approvalGate`.
 */
export function getAssistantRunApproval(): AssistantRunApproval {
  const stored = assistantRunApprovalSchema.safeParse(getSetting('assistantRunApproval'))
  return stored.success ? stored.data : 'ask'
}

export function setAssistantRunApproval(mode: AssistantRunApproval): void {
  setSetting('assistantRunApproval', assistantRunApprovalSchema.parse(mode))
}

const updateChannelSchema = z.enum(['stable', 'beta'])
export type UpdateChannel = z.infer<typeof updateChannelSchema>

/**
 * Release channel for packaged builds: drives the auto-update feed
 * (updater.ts). Dev builds ignore it (channel is always 'dev' unpackaged).
 */
export function getUpdateChannel(): UpdateChannel {
  const stored = updateChannelSchema.safeParse(getSetting('updateChannel'))
  return stored.success ? stored.data : 'stable'
}

export function setUpdateChannel(channel: UpdateChannel): void {
  setSetting('updateChannel', updateChannelSchema.parse(channel))
}

/** Generated once, then stable across launches — external clients (MCP) keep working. */
export function getLocalApiToken(): string {
  const stored = z.string().min(32).safeParse(getSetting('localApiToken'))
  if (stored.success) return stored.data
  const token = randomBytes(32).toString('hex')
  setSetting('localApiToken', token)
  return token
}
