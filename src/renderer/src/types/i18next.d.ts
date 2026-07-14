import type frCommon from '@shared/i18n/locales/fr/common.json'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    resources: {
      common: typeof frCommon
    }
  }
}
