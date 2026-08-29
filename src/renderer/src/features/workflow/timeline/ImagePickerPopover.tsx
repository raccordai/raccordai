import { ImagePlus } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { GraphNode } from '@shared/ipc/contracts'
import { getModel } from '@shared/models'
import { popoverLeft } from '../../../lib/timelineLayout'
import { useDismissable } from '../../../components/ui/useDismissable'
import { VideoThumb } from '../../../components/VideoThumb'

/**
 * The add-image picker: every image of the graph not already on the timeline
 * (image-model nodes with a successful output, image assets). Picking one
 * appends it as a STILL slot — 5 s by default, resizable by its edge grips.
 */
export function ImagePickerPopover({
  candidates,
  anchor,
  onPick,
  onClose
}: {
  candidates: Array<{ node: GraphNode; url: string; video?: boolean }>
  anchor: { x: number; y: number }
  onPick: (nodeId: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-64 -translate-x-1/2 -translate-y-full px-2 py-2 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 256, window.innerWidth), top: anchor.y }}
    >
      <div className="mb-1.5 flex items-center gap-1.5 px-1 font-semibold text-neutral-200">
        <ImagePlus className="h-3 w-3 text-accent" /> {t('timeline.addImage')}
      </div>
      {candidates.length === 0 ? (
        <p className="px-1 pb-1 text-neutral-500">{t('timeline.addImageEmpty')}</p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          {candidates.map(({ node, url, video }) => (
            <button
              key={node.id}
              onClick={() => onPick(node.id)}
              className="flex w-full items-center gap-2 rounded px-1 py-1 text-left hover:bg-neutral-800"
            >
              {video ? (
                <span className="h-8 w-12 flex-shrink-0 overflow-hidden rounded border border-neutral-800">
                  <VideoThumb src={url} overlay={false} className="h-full w-full object-cover" />
                </span>
              ) : (
                <img
                  src={url}
                  alt=""
                  className="h-8 w-12 flex-shrink-0 rounded border border-neutral-800 object-cover"
                />
              )}
              <span className="truncate text-neutral-200">
                {node.label ?? getModel(node.modelId)?.label ?? node.key}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
