import { X } from 'lucide-react'
import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'

/**
 * Fullscreen media viewer, opened from generation previews. Rendered in a
 * portal so islands' overflow/stacking can't clip it. Deliberately NO
 * backdrop-filter on the overlay: an ancestor with backdrop-filter breaks
 * <video> hit-testing (see the Chromium pitfall in CLAUDE.md).
 */
export function Lightbox({
  url,
  kind,
  onClose
}: {
  url: string
  kind: 'image' | 'video'
  onClose: () => void
}) {
  const { t } = useTranslation()

  // Capture phase so Escape closes the lightbox before any other handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-6"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-4 right-4 rounded-md p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
        title={t('editor.lightboxClose')}
      >
        <X className="h-5 w-5" />
      </button>
      {kind === 'video' ? (
        <video
          src={url}
          controls
          autoPlay
          loop
          className="max-h-full max-w-full rounded-lg"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          src={url}
          alt=""
          className="max-h-full max-w-full rounded-lg object-contain"
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>,
    document.body
  )
}
