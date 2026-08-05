import { Captions } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { HIDDEN_SUBSCRIBERS, nicheRatio, ratioSignal, type RatioSignal } from '@shared/niches'
import { formatSeconds } from '@renderer/lib/formatSeconds'

/** Shared presentation of one scored video (niche detail + global search). */

export const compactNumber = new Intl.NumberFormat(undefined, {
  notation: 'compact',
  maximumFractionDigits: 1
})

export function formatSubscribers(count: number, hiddenLabel: string): string {
  return count === HIDDEN_SUBSCRIBERS ? hiddenLabel : compactNumber.format(count)
}

const SIGNAL_CLASS: Record<RatioSignal, string> = {
  strong: 'bg-success/20 text-success',
  interesting: 'bg-warning/20 text-warning',
  neutral: 'bg-neutral-800 text-neutral-400'
}

export function RatioBadge({
  views,
  subscribers
}: {
  views: number
  subscribers: number
}): React.JSX.Element {
  const ratio = nicheRatio(views, subscribers)
  const label = Number.isFinite(ratio)
    ? `×${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}`
    : '∞'
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${SIGNAL_CLASS[ratioSignal(ratio)]}`}
    >
      {label}
    </span>
  )
}

export interface VideoRowData {
  key: string
  nicheVideoId?: string
  title: string
  url: string
  thumbnail: string | null
  channelTitle: string
  views: number
  durationSeconds: number
  publishedAt: string | null
  channelSubscribers: number
  hasTranscript?: boolean
}

export function VideoRow({
  video,
  onTranscript,
  trailing
}: {
  video: VideoRowData
  onTranscript?: (nicheVideoId: string) => void
  /** Extra action rendered after the ratio badge (e.g. "track channel"). */
  trailing?: React.ReactNode
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="flex items-center gap-3 border-b border-neutral-800/60 px-3 py-2 last:border-b-0">
      {video.thumbnail ? (
        <img
          src={video.thumbnail}
          alt=""
          className="h-12 w-21 shrink-0 rounded-md bg-neutral-900 object-cover"
          loading="lazy"
        />
      ) : (
        <div className="h-12 w-21 shrink-0 rounded-md bg-neutral-900" />
      )}
      <div className="min-w-0 flex-1">
        <a
          href={video.url}
          target="_blank"
          rel="noreferrer"
          className="line-clamp-1 text-sm text-neutral-200 hover:text-accent"
          title={video.title}
        >
          {video.title}
        </a>
        <p className="mt-0.5 line-clamp-1 text-xs text-neutral-500">
          {video.channelTitle} ·{' '}
          {formatSubscribers(video.channelSubscribers, t('niches.subsHidden'))}{' '}
          {video.channelSubscribers !== HIDDEN_SUBSCRIBERS && t('niches.subsShort')}
          {video.publishedAt && ` · ${new Date(video.publishedAt).toLocaleDateString()}`}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs text-neutral-400">
        {/* Transcript indicator — always visible on tracked videos: green and
            clickable when fetched, muted when absent. */}
        {video.hasTranscript !== undefined &&
          (video.hasTranscript && video.nicheVideoId && onTranscript ? (
            <button
              onClick={() => onTranscript(video.nicheVideoId as string)}
              title={t('niches.transcriptTitle')}
              className="rounded-md p-1 text-success hover:bg-neutral-800"
            >
              <Captions className="h-4 w-4" />
            </button>
          ) : (
            <span title={t('niches.noTranscript')} className="p-1 text-neutral-700">
              <Captions className="h-4 w-4" />
            </span>
          ))}
        {video.durationSeconds > 0 && (
          <span className="tabular-nums">{formatSeconds(video.durationSeconds)}</span>
        )}
        <span className="w-16 text-right tabular-nums">
          {compactNumber.format(video.views)} {t('niches.viewsShort')}
        </span>
        <RatioBadge views={video.views} subscribers={video.channelSubscribers} />
        {trailing}
      </div>
    </div>
  )
}
