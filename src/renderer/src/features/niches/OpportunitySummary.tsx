import { useTranslation } from 'react-i18next'
import type { SerpDurationBucket, SerpOpportunity, SerpOpportunityTier } from '@shared/niches'
import { formatSeconds } from '@renderer/lib/formatSeconds'
import { compactNumber } from './VideoRow'

/**
 * The SEOTube-style read of one keyword's SERP, computed in memory on the
 * fetched results (`analyzeSerpOpportunity`): an opportunity tier from the
 * competitive pressure, plus the supporting numbers — typical views, page
 * freshness and the dominant format.
 */

const TIER_CLASS: Record<SerpOpportunityTier, string> = {
  approachable: 'bg-success/20 text-success',
  contested: 'bg-warning/20 text-warning',
  saturated: 'bg-danger/20 text-danger'
}

const BUCKET_KEY: Record<SerpDurationBucket, 'short' | 'mid' | 'long'> = {
  short: 'short',
  mid: 'mid',
  long: 'long'
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`
}

function Stat({
  label,
  value,
  title
}: {
  label: string
  value: string
  title?: string
}): React.JSX.Element {
  return (
    <div title={title}>
      <p className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</p>
      <p className="mt-0.5 text-sm tabular-nums text-neutral-200">{value}</p>
    </div>
  )
}

export function OpportunitySummary({
  opportunity
}: {
  opportunity: SerpOpportunity
}): React.JSX.Element {
  const { t } = useTranslation()
  const dash = '—'
  return (
    <div className="island flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
      <div className="flex items-center gap-2" title={t('niches.opportunity.hint')}>
        <span className="text-[10px] uppercase tracking-wide text-neutral-500">
          {t('niches.opportunity.title')}
        </span>
        <span
          className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${TIER_CLASS[opportunity.tier]}`}
        >
          {t(`niches.opportunity.tier.${opportunity.tier}` as never)}
        </span>
      </div>
      <Stat
        label={t('niches.opportunity.medianViews')}
        value={compactNumber.format(Math.round(opportunity.medianViews))}
      />
      <Stat
        label={t('niches.opportunity.largeShare')}
        title={t('niches.opportunity.largeShareHint')}
        value={opportunity.largeChannelShare !== null ? pct(opportunity.largeChannelShare) : dash}
      />
      <Stat
        label={t('niches.opportunity.medianAge')}
        value={
          opportunity.medianAgeDays !== null
            ? t('niches.opportunity.days', { count: Math.round(opportunity.medianAgeDays) })
            : dash
        }
      />
      <Stat
        label={t('niches.opportunity.fresh')}
        value={opportunity.freshShare !== null ? pct(opportunity.freshShare) : dash}
      />
      <Stat
        label={t('niches.opportunity.format')}
        value={
          opportunity.dominantFormat !== null && opportunity.dominantFormatShare !== null
            ? `${t(`niches.opportunity.bucket.${BUCKET_KEY[opportunity.dominantFormat]}` as never)} · ${pct(
                opportunity.dominantFormatShare
              )}`
            : dash
        }
      />
      <Stat
        label={t('niches.opportunity.medianDuration')}
        value={
          opportunity.medianDurationSeconds !== null
            ? formatSeconds(Math.round(opportunity.medianDurationSeconds))
            : dash
        }
      />
    </div>
  )
}
