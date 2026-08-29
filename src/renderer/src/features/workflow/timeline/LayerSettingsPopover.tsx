import { Trash2, Type } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TextLayer } from '@shared/ipc/contracts'
import { TEXT_ANIMATION_IDS } from '@shared/textAnimations'
import { invoke } from '../../../lib/ipc'
import { popoverLeft } from '../../../lib/timelineLayout'
import { useDismissable } from '../../../components/ui/useDismissable'

/** Font suggestions for the layer inspector (free text — any system font works). */
const FONT_SUGGESTIONS = [
  'Arial',
  'Helvetica Neue',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Menlo',
  'Futura',
  'Impact',
  'Trebuchet MS',
  'Verdana'
]

/**
 * Typography inspector for one text layer. Position is set by dragging the
 * text ON THE PLAYER (x/y are normalized, the preview is the render); this
 * popover owns everything else: content, timing, font, size, weight, colour.
 */
export function LayerSettingsPopover({
  layer,
  anchor,
  onClose
}: {
  layer: TextLayer
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [content, setContent] = useState(layer.content)
  const [start, setStart] = useState(String(layer.startSec))
  const [end, setEnd] = useState(String(layer.endSec))
  const [font, setFont] = useState(layer.fontFamily ?? '')
  const [size, setSize] = useState(String(layer.sizePct))
  const [bold, setBold] = useState(layer.bold)
  const [italic, setItalic] = useState(layer.italic)
  const [color, setColor] = useState(layer.colorHex)
  const [animation, setAnimation] = useState(layer.animation ?? '')

  const apply = () => {
    const num = (raw: string, fallback: number) => {
      const n = Number(raw.replace(',', '.'))
      return Number.isFinite(n) ? n : fallback
    }
    void invoke('textLayers:update', {
      id: layer.id,
      patch: {
        content: content.trim() || layer.content,
        startSec: Math.max(0, num(start, layer.startSec)),
        endSec: num(end, layer.endSec),
        fontFamily: font.trim() === '' ? null : font.trim(),
        sizePct: Math.min(30, Math.max(1, num(size, layer.sizePct))),
        bold,
        italic,
        colorHex: color,
        animation: animation === '' ? null : animation
      }
    }).then(onClose)
  }

  const field =
    'rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none'
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-72 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 288, window.innerWidth), top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <Type className="h-3 w-3 text-accent" /> {t('timeline.layerSettings')}
      </div>
      <input
        className={`${field} w-full`}
        value={content}
        maxLength={500}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="mt-1.5 flex items-end gap-2">
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
          {t('timeline.layerFont')}
          <input
            className={`${field} w-full`}
            list="timeline-layer-fonts"
            placeholder="Arial"
            value={font}
            onChange={(e) => setFont(e.target.value)}
          />
          <datalist id="timeline-layer-fonts">
            {FONT_SUGGESTIONS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </label>
      </div>
      <div className="mt-1.5 flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerAnimation')}
          <select
            className={`${field} w-full`}
            value={animation}
            onChange={(e) => setAnimation(e.target.value)}
          >
            <option value="">{t('timeline.layerAnimationNone')}</option>
            {TEXT_ANIMATION_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`timeline.layerAnimations.${id}` as never)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-1.5 flex items-end gap-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerSize')}
          <input
            className={`${field} w-14`}
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
          />
        </label>
        <div className="flex gap-1">
          <button
            onClick={() => setBold((b) => !b)}
            className={`rounded px-2 py-1 font-bold ${
              bold ? 'bg-accent text-neutral-900' : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            B
          </button>
          <button
            onClick={() => setItalic((i) => !i)}
            className={`rounded px-2 py-1 italic ${
              italic ? 'bg-accent text-neutral-900' : 'bg-neutral-800 text-neutral-400'
            }`}
          >
            I
          </button>
        </div>
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.layerColor')}
          <input
            type="color"
            className="h-6 w-9 cursor-pointer rounded border border-neutral-700 bg-neutral-900"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </label>
        <button
          onClick={() => {
            void invoke('textLayers:delete', { id: layer.id }).then(onClose)
          }}
          className="ml-auto rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
          title={t('timeline.layerDelete')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={apply}
          className="rounded-md bg-accent px-2 py-1 font-semibold text-neutral-900 hover:bg-accent-hover"
        >
          {t('timeline.apply')}
        </button>
      </div>
      <p className="mt-1.5 text-[10px] text-neutral-500">{t('timeline.layerDragHint')}</p>
    </div>
  )
}
