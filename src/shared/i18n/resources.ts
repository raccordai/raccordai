import frCommon from './locales/fr/common.json'
import enCommon from './locales/en/common.json'
import type { Locale } from '../ipc/contracts'

export const resources = {
  fr: { common: frCommon },
  en: { common: enCommon }
} as const satisfies Record<Locale, { common: typeof frCommon }>

export const defaultNS = 'common'
export const fallbackLocale: Locale = 'en'
