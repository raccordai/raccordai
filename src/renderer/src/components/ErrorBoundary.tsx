import { Component, useEffect, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@renderer/components/ui/Button'
import { normalizeErrorMessage, reportRendererError } from '@renderer/lib/errorReporter'

/**
 * Last-resort React error surfaces. Before these, a render throw was a white
 * window with nothing to act on. Two entry points, one screen:
 *   - <ErrorBoundary> wraps the whole app (mounted in main.tsx);
 *   - the router's defaultErrorComponent catches per-route render errors.
 * Both log through the renderer error funnel (no toast — the screen IS the
 * signal) and offer a reload, which restores a consistent state under file://.
 */

export function ErrorScreen({ error, scope }: { error: unknown; scope: string }): ReactNode {
  const { t } = useTranslation()
  useEffect(() => {
    reportRendererError(scope, error, { toast: false })
  }, [scope, error])
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-neutral-950 p-6">
      <div className="island w-full max-w-lg px-6 py-5">
        <h1 className="flex items-center gap-2 text-sm font-semibold text-neutral-100">
          <AlertTriangle className="h-4 w-4 text-warning" />
          {t('errors.title')}
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-neutral-400">{t('errors.description')}</p>
        <pre className="mt-3 max-h-40 overflow-auto rounded-md bg-neutral-900 px-3 py-2 text-[11px] leading-relaxed break-words whitespace-pre-wrap text-neutral-300">
          {normalizeErrorMessage(error)}
        </pre>
        <div className="mt-4 flex justify-end">
          <Button onClick={() => window.location.reload()}>{t('errors.reload')}</Button>
        </div>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: unknown | null }> {
  override state: { error: unknown | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: unknown } {
    return { error }
  }

  override render(): ReactNode {
    if (this.state.error !== null) return <ErrorScreen error={this.state.error} scope="react" />
    return this.props.children
  }
}
