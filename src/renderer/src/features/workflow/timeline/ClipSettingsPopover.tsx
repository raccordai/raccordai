import { Scissors, Trash2 } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CLIP_LOOK_IDS } from '@shared/looks'
import { STILL_MOTION_IDS } from '@shared/stillMotion'
import { CLIP_TRANSITION_IDS } from '@shared/transitions'
import {
  clipLook,
  clipSegments,
  clipSpeed,
  isStillClip,
  segmentTransitionAfter,
  segmentTransitionSeconds,
  stillMotionOf
} from '@shared/timeline'
import { invoke } from '../../../lib/ipc'
import { ALIGN_GRID, popoverLeft } from '../../../lib/timelineLayout'
import { useDismissable } from '../../../components/ui/useDismissable'
import type { EngineClip } from './types'

/**
 * The clip inspector, anchored above the scissors button (fixed positioning —
 * the timeline island clips its own overflow). Trim and the text layer are
 * applied together on Apply; the transition choice and its length write
 * immediately (discrete choices). Everything is a journaled graph edit — ⌘Z
 * undoes any of it.
 */
export function ClipSettingsPopover({
  clip,
  isLast,
  anchor,
  splitAtMediaSec,
  onClose,
  onRemoveStill
}: {
  clip: EngineClip
  isLast: boolean
  anchor: { x: number; y: number }
  /** Razor point under the playhead (media seconds), null = playhead outside. */
  splitAtMediaSec: number | null
  onClose: () => void
  /** Set on still slots only: removes the image from the timeline (not the graph). */
  onRemoveStill?: () => void
}) {
  const node = clip.node
  const segment = clip.segment
  const segmentCount = clipSegments(node).length
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement | null>(null)
  useDismissable(true, onClose, ref)
  const [inPoint, setInPoint] = useState(
    segment.trimStartSec != null ? String(segment.trimStartSec) : ''
  )
  const [outPoint, setOutPoint] = useState(
    segment.trimEndSec != null ? String(segment.trimEndSec) : ''
  )
  const [ovText, setOvText] = useState(node.overlay?.text ?? '')
  const [ovAlign, setOvAlign] = useState(node.overlay?.align ?? 2)
  const [ovSize, setOvSize] = useState<'sm' | 'md' | 'lg'>(node.overlay?.size ?? 'md')
  const [transDur, setTransDur] = useState(String(segmentTransitionSeconds(segment)))

  const transition = segmentTransitionAfter(segment)

  const apply = () => {
    const parse = (raw: string): number | null => {
      const n = Number(raw.replace(',', '.'))
      return raw.trim() !== '' && Number.isFinite(n) ? n : null
    }
    const text = ovText.trim()
    void Promise.all([
      invoke('nodes:setTrim', {
        nodeId: node.id,
        trimStartSec: parse(inPoint),
        trimEndSec: parse(outPoint),
        segmentIndex: clip.segmentIndex
      }),
      invoke('nodes:setOverlay', {
        nodeId: node.id,
        overlay: text ? { text, align: ovAlign, size: ovSize } : null
      })
    ]).then(onClose)
  }

  const changeTransition = (id: string | null, durRaw: string) => {
    const dur = Number(durRaw.replace(',', '.'))
    void invoke('nodes:setTransition', {
      nodeId: node.id,
      transition: id,
      durationSec: id && Number.isFinite(dur) ? Math.min(2, Math.max(0.1, dur)) : null,
      segmentIndex: clip.segmentIndex
    })
  }

  const field =
    'w-16 rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none'
  return (
    <div
      ref={ref}
      className="island fixed z-50 w-72 -translate-x-1/2 -translate-y-full px-3 py-2.5 text-[11px]"
      style={{ left: popoverLeft(anchor.x, 288, window.innerWidth), top: anchor.y }}
    >
      <div className="mb-2 flex items-center gap-1.5 font-semibold text-neutral-200">
        <Scissors className="h-3 w-3 text-accent" /> {t('timeline.clipSettings')}
        {onRemoveStill && (
          <button
            onClick={onRemoveStill}
            className="ml-auto rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-danger"
            title={t('timeline.removeFromTimeline')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Trim */}
      <div className="flex items-end gap-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.trimIn')}
          <input
            className={field}
            inputMode="decimal"
            placeholder="0"
            value={inPoint}
            onChange={(e) => setInPoint(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.trimOut')}
          <input
            className={field}
            inputMode="decimal"
            placeholder="—"
            value={outPoint}
            onChange={(e) => setOutPoint(e.target.value)}
          />
        </label>
      </div>

      {/* Razor (§6.12e): split at the playhead; a split part can be removed. */}
      {!isStillClip(node) && (
        <div className="mt-2.5 flex items-center gap-2 border-t border-neutral-800 pt-2">
          <button
            disabled={splitAtMediaSec === null}
            onClick={() => {
              if (splitAtMediaSec === null) return
              void invoke('nodes:splitClip', {
                nodeId: node.id,
                atMediaSec: splitAtMediaSec
              }).then(onClose)
            }}
            className="flex items-center gap-1 rounded-md bg-neutral-800 px-2 py-1 font-semibold text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
            title={t('timeline.splitHint')}
          >
            <Scissors className="h-3 w-3" /> {t('timeline.split')}
          </button>
          {segmentCount > 1 && (
            <button
              onClick={() =>
                void invoke('nodes:removeSegment', {
                  nodeId: node.id,
                  segmentIndex: clip.segmentIndex
                }).then(onClose)
              }
              className="rounded-md bg-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-700 hover:text-danger"
            >
              {t('timeline.removeSegment')}
            </button>
          )}
          {segmentCount > 1 && (
            <span className="ml-auto text-neutral-500">
              {t('timeline.segmentBadge', { n: clip.segmentIndex + 1, count: segmentCount })}
            </span>
          )}
        </div>
      )}

      {/* Speed & look (video clips) / Ken Burns motion (stills) — discrete
          choices, written immediately like the transition. */}
      <div className="mt-2.5 flex items-end gap-2 border-t border-neutral-800 pt-2">
        {!isStillClip(node) && (
          <label className="flex flex-col gap-0.5 text-neutral-400">
            {t('timeline.speed')}
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
              value={String(clipSpeed(node))}
              onChange={(e) => {
                const v = Number(e.target.value)
                void invoke('nodes:setSpeed', { nodeId: node.id, speed: v === 1 ? null : v })
              }}
            >
              {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4].map((v) => (
                <option key={v} value={String(v)}>
                  ×{v}
                </option>
              ))}
            </select>
          </label>
        )}
        {isStillClip(node) && (
          <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
            {t('timeline.motion')}
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
              value={stillMotionOf(node) ?? ''}
              onChange={(e) =>
                void invoke('nodes:setStillMotion', {
                  nodeId: node.id,
                  motion: e.target.value || null
                })
              }
            >
              <option value="">{t('timeline.motionNone')}</option>
              {STILL_MOTION_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`timeline.motions.${id}` as never)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
          {t('timeline.look')}
          <select
            className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
            value={clipLook(node) ?? ''}
            onChange={(e) =>
              void invoke('nodes:setLook', { nodeId: node.id, look: e.target.value || null })
            }
          >
            <option value="">{t('timeline.lookNone')}</option>
            {CLIP_LOOK_IDS.map((id) => (
              <option key={id} value={id}>
                {t(`timeline.looks.${id}` as never)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Transition into the next clip */}
      {!isLast && (
        <div className="mt-2.5 flex items-end gap-2 border-t border-neutral-800 pt-2">
          <label className="flex min-w-0 flex-1 flex-col gap-0.5 text-neutral-400">
            {t('timeline.transition')}
            <select
              className="rounded border border-neutral-700 bg-neutral-900 px-1 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
              value={transition ?? ''}
              onChange={(e) => changeTransition(e.target.value || null, transDur)}
            >
              <option value="">{t('timeline.transitionNone')}</option>
              {CLIP_TRANSITION_IDS.map((id) => (
                <option key={id} value={id}>
                  {t(`timeline.transitions.${id}` as never)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-neutral-400">
            {t('timeline.transitionDuration')}
            <input
              className={field}
              inputMode="decimal"
              disabled={transition === null}
              value={transDur}
              onChange={(e) => setTransDur(e.target.value)}
              onBlur={() => transition && changeTransition(transition, transDur)}
            />
          </label>
        </div>
      )}

      {/* Text layer */}
      <div className="mt-2.5 border-t border-neutral-800 pt-2">
        <label className="flex flex-col gap-0.5 text-neutral-400">
          {t('timeline.overlayText')}
          <input
            className="w-full rounded border border-neutral-700 bg-neutral-900 px-1.5 py-1 text-[11px] text-neutral-200 focus:border-accent focus:outline-none"
            placeholder={t('timeline.overlayPlaceholder')}
            maxLength={200}
            value={ovText}
            onChange={(e) => setOvText(e.target.value)}
          />
        </label>
        <div className="mt-1.5 flex items-center gap-2.5">
          <div
            className="grid grid-cols-3 gap-0.5"
            role="group"
            aria-label={t('timeline.overlayPosition')}
          >
            {ALIGN_GRID.flat().map((a) => (
              <button
                key={a}
                onClick={() => setOvAlign(a)}
                title={t('timeline.overlayPosition')}
                className={`h-4 w-5 rounded-sm border ${
                  ovAlign === a
                    ? 'border-accent bg-accent/40'
                    : 'border-neutral-700 bg-neutral-900 hover:border-neutral-500'
                }`}
              />
            ))}
          </div>
          <div className="flex gap-1" role="group" aria-label={t('timeline.overlaySize')}>
            {(['sm', 'md', 'lg'] as const).map((s) => (
              <button
                key={s}
                onClick={() => setOvSize(s)}
                className={`rounded px-1.5 py-0.5 uppercase ${
                  ovSize === s
                    ? 'bg-accent font-semibold text-neutral-900'
                    : 'bg-neutral-800 text-neutral-400 hover:text-neutral-200'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <button
            onClick={apply}
            className="ml-auto rounded-md bg-accent px-2 py-1 font-semibold text-neutral-900 hover:bg-accent-hover"
          >
            {t('timeline.apply')}
          </button>
        </div>
      </div>
    </div>
  )
}
