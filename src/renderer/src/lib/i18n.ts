import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { Locale } from '@shared/ipc/contracts'
import { defaultNS, fallbackLocale, resources } from '@shared/i18n/resources'
import { invoke } from './ipc'

export async function initI18n(): Promise<void> {
  const locale = await invoke('settings:getLocale')
  await i18next.use(initReactI18next).init({
    resources,
    lng: locale,
    fallbackLng: fallbackLocale,
    defaultNS,
    interpolation: { escapeValue: false }
  })
}

export async function changeLocale(locale: Locale): Promise<void> {
  await invoke('settings:setLocale', locale)
  await i18next.changeLanguage(locale)
}
