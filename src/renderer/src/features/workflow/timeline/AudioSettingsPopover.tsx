import { Volume2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { GraphNode } from '@shared/ipc/contracts'
import { clipVolume } from '@shared/timeline'
import { invoke } from '../../../lib/ipc'
import { popoverLeft } from '../../../lib/timelineLayout'
import { useDismissable } from '../../../components/ui/useDismissable'

/**
 * Volume inspector for one audio track (music/speech lane block, double-click).
 * The gain applies to the preview player (capped at 100% — an HTMLMediaElement
 * cannot amplify) and to the MP4 render's per-track `volume=` filter.
 */
export function AudioSettingsPopover({
  node,
  anchor,
  onClose
}: {
  node: GraphNode
  anchor: { x: number; y: number }
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [volume, setVolume] = useState(Math.round(clipVolume(node) * 100))

  const commit = (pct: number) => {
    void invoke('nodes:setVolume', {
      nodeId: node.id,
      volume: pct === 100 ? null : Math.min(2, Math.max(0, pct / 100))
    })
  }

  return (
    <div
      ref={ref}
      className="island fixed z-50 w-60 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 240, window.innerWidth), top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <Volume2 className="h-3 w-3 text-accent" /> {t('timeline.volume')}
        <span className="ml-auto font-mono text-neutral-400">{volume}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        onPointerUp={() => commit(volume)}
        onKeyUp={() => commit(volume)}
        className="w-full"
      />
      <p className="mt-1.5 text-[10px] text-neutral-500">{t('timeline.volumeHint')}</p>
    </div>
  )
}
