import { useTranslation } from 'react-i18next'
import { localeSchema, type Locale } from '@shared/ipc/contracts'
import { changeLocale } from '@renderer/lib/i18n'

export function LocaleSwitcher(): React.JSX.Element {
  const { t, i18n } = useTranslation()

  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      {t('language.label')}
      <select
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        value={i18n.language as Locale}
        onChange={(event) => void changeLocale(localeSchema.parse(event.target.value))}
      >
        <option value="fr">{t('language.fr')}</option>
        <option value="en">{t('language.en')}</option>
      </select>
    </label>
  )
}
