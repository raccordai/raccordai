import { Sticker as StickerIcon, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ImageLayer } from '@shared/ipc/contracts'
import { invoke } from '../../../lib/ipc'
import { popoverLeft } from '../../../lib/timelineLayout'
import { useDismissable } from '../../../components/ui/useDismissable'

/**
 * Inspector for one sticker: timing, size (as % of the output width) and
 * deletion. Position is set by dragging the sticker ON THE PLAYER (x/y are
 * normalized centers — the preview is the render).
 */
export function StickerSettingsPopover({
  layer,
  anchor,
  onClose
}: {
  layer: ImageLayer
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [start, setStart] = useState(String(layer.startSec))
  const [end, setEnd] = useState(String(layer.endSec))
  const [width, setWidth] = useState(Math.round(layer.widthPct))

  const apply = () => {
    const num = (raw: string, fallback: number) => {
      const n = Number(raw.replace(',', '.'))
      return Number.isFinite(n) ? n : fallback
    }
    void invoke('imageLayers:update', {
      id: layer.id,
      patch: {
        startSec: Math.max(0, num(start, layer.startSec)),
        endSec: num(end, layer.endSec),
        widthPct: Math.min(100, Math.max(1, width))
      }
    }).then(onClose)
  }

  const field =
    'rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none'
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-64 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 256, window.innerWidth), top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <StickerIcon className="h-3 w-3 text-accent" /> {t('timeline.sticker')}
      </div>
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerStart')}
          <input
            className={`${field} w-14`}
            inputMode="decimal"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerEnd')}
          <input
            className={`${field} w-14`}
            inputMode="decimal"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
          {t('timeline.stickerSize', { pct: width })}
          <input
            type="range"
            min={5}
            max={100}
            step={1}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
        </label>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => {
            void invoke('imageLayers:delete', { id: layer.id }).then(onClose)
          }}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
          title={t('timeline.stickerDelete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={apply}
          className="ml-auto rounded-md bg-accent px-2 py-1 font-semibold text-neutral-900 hover:bg-accent-hover"
        >
          {t('timeline.apply')}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-neutral-500">{t('timeline.stickerDragHint')}</p>
    </div>
  )
}
