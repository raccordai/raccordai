import { Clapperboard, FileJson, Film, FolderArchive, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/Button'
import { RENDER_PRESETS, type RenderPreset, type WorkflowIO } from './useWorkflowIO'

/**
 * Guided export window (replaces the flat "Fichier" menu entries): one card per
 * format, each explaining what it produces, where the file lands and why it may
 * be unavailable. Island style over a dimmed backdrop, like the confirm modal.
 */
export function ExportDialog({ io, onClose }: { io: WorkflowIO; onClose: () => void }) {
  const { t } = useTranslation()
  const [preset, setPreset] = useState<RenderPreset | 'auto'>('auto')
  const [burnSubtitles, setBurnSubtitles] = useState(false)
  const [watermarkText, setWatermarkText] = useState('')
  const [watermarkPosition, setWatermarkPosition] = useState<
    'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'
  >('bottom-right')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const busy = io.exporting || io.exportingZip || io.exportingMedia || io.renderingMp4

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="island flex max-h-full w-full max-w-xl flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 pt-4 pb-3">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">{t('exportDialog.title')}</h2>
            <p className="mt-0.5 text-xs text-neutral-400">{t('exportDialog.subtitle')}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-3 overflow-y-auto px-5 pb-5">
          {/* MP4 — the main outcome, hence the accent treatment and format choice. */}
          <ExportCard
            icon={<Film className="h-4 w-4 text-accent" />}
            title={t('exportDialog.mp4Title')}
            badge={t('exportDialog.recommended')}
            description={t('exportDialog.mp4Desc')}
            hint={t('exportDialog.mp4Hint')}
            disabledReason={io.canExportFcpxml ? null : t('exportDialog.needsClips')}
            action={
              <Button
                size="sm"
                variant="primary"
                disabled={!io.canExportFcpxml || busy}
                onClick={() => {
                  // Close first: the native save dialog takes over, then the
                  // editor's floating progress island reports the render.
                  onClose()
                  void io.exportMp4(preset === 'auto' ? undefined : preset, {
                    burnSubtitles,
                    ...(watermarkText.trim()
                      ? {
                          watermark: {
                            text: watermarkText.trim(),
                            position: watermarkPosition
                          }
                        }
                      : {})
                  })
                }}
              >
                {io.renderingMp4 ? t('editor.rendering') : t('exportDialog.exportBtn')}
              </Button>
            }
          >
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[11px] text-neutral-400">
                {t('exportDialog.mp4Format')}
              </span>
              <FormatPill
                active={preset === 'auto'}
                label={t('exportDialog.mp4FormatAuto')}
                sub={t('exportDialog.mp4FormatAutoHint')}
                onClick={() => setPreset('auto')}
              />
              {(Object.keys(RENDER_PRESETS) as RenderPreset[]).map((p) => (
                <FormatPill
                  key={p}
                  active={preset === p}
                  label={p}
                  sub={`${RENDER_PRESETS[p].width}×${RENDER_PRESETS[p].height}`}
                  onClick={() => setPreset(p)}
                />
              ))}
            </div>
            <label className="mt-2 flex items-center gap-1.5 text-[11px] text-neutral-300">
              <input
                type="checkbox"
                checked={burnSubtitles}
                onChange={(e) => setBurnSubtitles(e.target.checked)}
              />
              {t('exportDialog.mp4Subtitles')}
            </label>
            <div className="mt-1.5 flex items-center gap-1.5">
              <input
                className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
                placeholder={t('exportDialog.watermarkPlaceholder')}
                maxLength={80}
                value={watermarkText}
                onChange={(e) => setWatermarkText(e.target.value)}
              />
              <select
                className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
                value={watermarkPosition}
                disabled={watermarkText.trim() === ''}
                onChange={(e) => setWatermarkPosition(e.target.value as typeof watermarkPosition)}
              >
                {(['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const).map((p) => (
                  <option key={p} value={p}>
                    {t(`exportDialog.watermarkCorner.${p}` as never)}
                  </option>
                ))}
              </select>
            </div>
          </ExportCard>

          <ExportCard
            icon={<FolderArchive className="h-4 w-4 text-neutral-300" />}
            title={t('exportDialog.clipsTitle')}
            description={t('exportDialog.clipsDesc')}
            hint={`${t('exportDialog.clipsHint')} ${t('exportDialog.downloadsHint')}`}
            disabledReason={io.canExportFcpxml ? null : t('exportDialog.needsClips')}
            action={
              <Button
                size="sm"
                disabled={!io.canExportFcpxml || busy}
                onClick={() => void io.exportMediaZip()}
              >
                {io.exportingMedia ? t('editor.fcpxmlBundling') : t('exportDialog.exportBtn')}
              </Button>
            }
          />

          <ExportCard
            icon={<Clapperboard className="h-4 w-4 text-neutral-300" />}
            title={t('exportDialog.fcpxmlTitle')}
            description={t('exportDialog.fcpxmlDesc')}
            hint={`${t('exportDialog.fcpxmlHint')} ${t('exportDialog.downloadsHint')}`}
            disabledReason={io.canExportFcpxml ? null : t('exportDialog.needsClips')}
            action={
              <Button
                size="sm"
                disabled={!io.canExportFcpxml || busy}
                onClick={() => void io.exportFcpxmlZip()}
              >
                {io.exportingZip ? t('editor.fcpxmlBundling') : t('exportDialog.exportBtn')}
              </Button>
            }
          />

          <ExportCard
            icon={<FileJson className="h-4 w-4 text-neutral-300" />}
            title={t('exportDialog.jsonTitle')}
            description={t('exportDialog.jsonDesc')}
            hint={t('exportDialog.downloadsHint')}
            disabledReason={io.canExport ? null : t('exportDialog.needsNodes')}
            action={
              <Button
                size="sm"
                disabled={!io.canExport || busy}
                onClick={() => void io.exportJson()}
              >
                {io.exporting ? t('editor.exporting') : t('exportDialog.exportBtn')}
              </Button>
            }
          />
        </div>
      </div>
    </div>
  )
}

function ExportCard({
  icon,
  title,
  badge,
  description,
  hint,
  disabledReason,
  action,
  children
}: {
  icon: ReactNode
  title: string
  badge?: string
  description: string
  hint: string
  disabledReason: string | null
  action: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900/60 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            {icon}
            <span className="text-xs font-semibold text-neutral-100">{title}</span>
            {badge && (
              <span className="rounded-full bg-accent px-1.5 py-px text-[10px] font-medium text-neutral-900">
                {badge}
              </span>
            )}
          </div>
          <p className="text-xs leading-relaxed text-neutral-300">{description}</p>
        </div>
        <div className="flex-shrink-0">{action}</div>
      </div>
      {children}
      <p className="text-[11px] leading-relaxed text-neutral-500">{disabledReason ?? hint}</p>
    </div>
  )
}

function FormatPill({
  active,
  label,
  sub,
  onClick
}: {
  active: boolean
  label: string
  sub: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md border px-2 py-1 text-[11px] transition ${
        active
          ? 'border-accent/60 bg-accent/15 text-neutral-100'
          : 'border-neutral-700 bg-neutral-800/60 text-neutral-300 hover:border-neutral-500'
      }`}
    >
      <span className="font-medium">{label}</span>
      <span className="ml-1 text-neutral-400">{sub}</span>
    </button>
  )
}
