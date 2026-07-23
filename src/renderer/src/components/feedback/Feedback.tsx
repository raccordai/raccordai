import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/Button'

/**
 * App-wide replacement for native alert()/confirm() (§4.4): a toast stack for
 * outcomes and a styled confirm modal for decisions, both in the island style
 * with token colors. Mounted once in __root.tsx; use via useToast()/useConfirm().
 */

type ToastKind = 'info' | 'success' | 'warning' | 'error'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

/** Errors are sticky (0) — a failed run must not vanish while the user is away. */
const TOAST_TTL_MS: Record<ToastKind, number> = {
  info: 5000,
  success: 5000,
  warning: 8000,
  error: 0
}

export interface ConfirmOptions {
  title?: string
  message: string
  /** Defaults to the generic Confirm/Cancel labels. */
  confirmLabel?: string
  cancelLabel?: string
  /** Destructive action — the confirm button takes the danger treatment. */
  danger?: boolean
}

interface FeedbackApi {
  toast: (kind: ToastKind, message: string) => void
  confirm: (options: ConfirmOptions) => Promise<boolean>
}

const FeedbackContext = createContext<FeedbackApi | null>(null)

export interface Toast {
  info: (message: string) => void
  success: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
}

export function useToast(): Toast {
  const api = useContext(FeedbackContext)
  if (!api) throw new Error('useToast requires <FeedbackProvider>')
  return useMemo(
    () => ({
      info: (m: string) => api.toast('info', m),
      success: (m: string) => api.toast('success', m),
      warning: (m: string) => api.toast('warning', m),
      error: (m: string) => api.toast('error', m)
    }),
    [api]
  )
}

/** Styled confirm — resolves true on confirm, false on cancel/backdrop/Esc. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  const api = useContext(FeedbackContext)
  if (!api) throw new Error('useConfirm requires <FeedbackProvider>')
  return api.confirm
}

interface PendingConfirm extends ConfirmOptions {
  resolve: (accepted: boolean) => void
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [confirms, setConfirms] = useState<PendingConfirm[]>([])
  const nextId = useRef(1)

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++
      setToasts((prev) => [...prev, { id, kind, message }])
      const ttl = TOAST_TTL_MS[kind]
      if (ttl > 0) setTimeout(() => dismissToast(id), ttl)
    },
    [dismissToast]
  )

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        setConfirms((prev) => [...prev, { ...options, resolve }])
      }),
    []
  )

  const settleConfirm = useCallback((accepted: boolean) => {
    setConfirms((prev) => {
      prev[0]?.resolve(accepted)
      return prev.slice(1)
    })
  }, [])

  const api = useMemo<FeedbackApi>(() => ({ toast, confirm }), [toast, confirm])

  return (
    <FeedbackContext.Provider value={api}>
      {children}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
      {confirms[0] && <ConfirmModal confirm={confirms[0]} onSettle={settleConfirm} />}
    </FeedbackContext.Provider>
  )
}

const TOAST_STYLE: Record<ToastKind, { border: string; icon: ReactNode }> = {
  info: {
    border: 'border-accent/50',
    icon: <Info className="h-4 w-4 flex-shrink-0 text-accent" />
  },
  success: {
    border: 'border-success/50',
    icon: <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-success" />
  },
  warning: {
    border: 'border-warning/50',
    icon: <AlertTriangle className="h-4 w-4 flex-shrink-0 text-warning" />
  },
  error: {
    border: 'border-danger/50',
    icon: <AlertCircle className="h-4 w-4 flex-shrink-0 text-danger" />
  }
}

function ToastStack({
  toasts,
  onDismiss
}: {
  toasts: ToastItem[]
  onDismiss: (id: number) => void
}) {
  const { t } = useTranslation()
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((item) => (
        <div
          key={item.id}
          className={`island pointer-events-auto flex items-start gap-2.5 border px-3.5 py-2.5 ${TOAST_STYLE[item.kind].border}`}
        >
          {TOAST_STYLE[item.kind].icon}
          <div className="min-h-4 flex-1 text-xs leading-relaxed break-words whitespace-pre-wrap text-neutral-200">
            {item.message}
          </div>
          <button
            onClick={() => onDismiss(item.id)}
            className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('common.close')}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function ConfirmModal({
  confirm,
  onSettle
}: {
  confirm: PendingConfirm
  onSettle: (accepted: boolean) => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={() => onSettle(false)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onSettle(false)
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="island w-full max-w-md px-5 py-4"
        onClick={(e) => e.stopPropagation()}
      >
        {confirm.title && (
          <h2 className="mb-2 text-sm font-semibold text-neutral-100">{confirm.title}</h2>
        )}
        <p className="text-xs leading-relaxed whitespace-pre-wrap text-neutral-300">
          {confirm.message}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onSettle(false)}>
            {confirm.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button
            variant={confirm.danger ? 'danger' : 'primary'}
            onClick={() => onSettle(true)}
            autoFocus
          >
            {confirm.confirmLabel ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
