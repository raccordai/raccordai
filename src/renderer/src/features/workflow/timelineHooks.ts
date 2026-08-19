import { useCallback, useEffect, useRef, useState } from 'react'
import type * as React from 'react'

/**
 * Layout hooks of the timeline island (collapse + resizable height), persisted
 * across sessions. The clip-selection logic lives in `@shared/timeline` —
 * shared with the FCPXML export and the MP4 render.
 */

const HEIGHT_STORAGE_KEY = 'raccord:timeline-height'
const COLLAPSED_STORAGE_KEY = 'raccord:timeline-collapsed'
const MUTED_STORAGE_KEY = 'raccord:timeline-muted'
const INPUT_STILLS_STORAGE_KEY = 'raccord:timeline-input-stills'
const MIN_HEIGHT = 160
const MAX_HEIGHT_VH = 0.8 // 80% of viewport

// Lets the timeline be hidden down to a thin bar and restored, persisted across
// sessions like the height.
export function useCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === '1'
  })

  const set = useCallback((v: boolean) => {
    setCollapsed(v)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, v ? '1' : '0')
    }
  }, [])

  return [collapsed, set]
}

// Preview-only mute of the whole timeline (clips + music + speech lanes),
// persisted like the collapse state. Never touches the exported MP4.
export function useMuted(): [boolean, (v: boolean) => void] {
  const [muted, setMuted] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.localStorage.getItem(MUTED_STORAGE_KEY) === '1'
  })

  const set = useCallback((v: boolean) => {
    setMuted(v)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(MUTED_STORAGE_KEY, v ? '1' : '0')
    }
  }, [])

  return [muted, set]
}

// Animatic mode (ON by default): clips without a generated output play their
// INPUT image as a still, so the whole film can be reviewed (and annotated)
// from its start frames before spending video credits.
export function useInputStills(): [boolean, (v: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(INPUT_STILLS_STORAGE_KEY) !== '0'
  })

  const set = useCallback((v: boolean) => {
    setEnabled(v)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(INPUT_STILLS_STORAGE_KEY, v ? '1' : '0')
    }
  }, [])

  return [enabled, set]
}

function readStoredHeight(): number {
  if (typeof window === 'undefined') return 256
  const raw = window.localStorage.getItem(HEIGHT_STORAGE_KEY)
  const parsed = raw ? Number(raw) : NaN
  if (!Number.isFinite(parsed)) return 256
  return clampHeight(parsed)
}

function clampHeight(h: number): number {
  const max = typeof window === 'undefined' ? 800 : Math.round(window.innerHeight * MAX_HEIGHT_VH)
  return Math.max(MIN_HEIGHT, Math.min(max, Math.round(h)))
}

export function useResizableHeight() {
  const [height, setHeight] = useState<number>(() => readStoredHeight())
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null)

  const startDrag = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault()
      dragRef.current = { startY: e.clientY, startHeight: height }
      setDragging(true)
    },
    [height]
  )

  useEffect(() => {
    if (!dragging) return
    function onMove(e: PointerEvent) {
      if (!dragRef.current) return
      // Dragging UP grows the timeline (we anchor at the bottom).
      const delta = dragRef.current.startY - e.clientY
      setHeight(clampHeight(dragRef.current.startHeight + delta))
    }
    function onUp() {
      dragRef.current = null
      setDragging(false)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    // Prevent text selection while dragging.
    const prevUserSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'row-resize'
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      document.body.style.userSelect = prevUserSelect
      document.body.style.cursor = ''
    }
  }, [dragging])

  // Persist on stable height (when drag ends).
  useEffect(() => {
    if (dragging || typeof window === 'undefined') return
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(height))
  }, [height, dragging])

  // Re-clamp if the window shrinks below the stored size.
  useEffect(() => {
    function onResize() {
      setHeight((h) => clampHeight(h))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  return { height, startDrag, dragging }
}
