import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, Outlet, createRootRoute, useRouter, useRouterState } from '@tanstack/react-router'
import { Download, KeyRound, MessageSquare, Settings, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HeaderActions, MenuBar, MenuBarProvider } from '@renderer/components/menubar/MenuBar'
import { FeedbackProvider } from '@renderer/components/feedback/Feedback'
import { HeaderCredits } from '@renderer/components/HeaderCredits'
import { Button } from '@renderer/components/ui/Button'
import { useShortcut } from '@renderer/components/ui/useShortcut'
import { AssistantSidebar } from '@renderer/features/assistant/AssistantSidebar'
import { toggleAssistant, useAssistant } from '@renderer/features/assistant/assistantStore'
import { FirstRunOverlay } from '@renderer/features/onboarding/FirstRunOverlay'
import {
  handleDemoControl,
  reconcileDemoStatus,
  useDemoRecorder
} from '@renderer/features/demo/demoRecorderStore'
import { invoke } from '@renderer/lib/ipc'
import { reportRendererError } from '@renderer/lib/errorReporter'
import type { DemoControlPayload, NavigatePayload } from '@shared/ipc/contracts'

export const Route = createRootRoute({
  component: RootLayout
})

function RootLayout(): React.JSX.Element {
  const router = useRouter()

  // The assistant's open_video tool pushes a route for the app to follow.
  useEffect(() => {
    return window.api.on('event:navigate', (payload) => {
      const path = (payload as NavigatePayload)?.path
      if (typeof path === 'string' && path.startsWith('/')) router.history.push(path)
    })
  }, [router])

  useShortcut('toggleAssistant', toggleAssistant)

  return (
    <MenuBarProvider>
      <FeedbackProvider>
        <div className="flex h-full flex-col">
          <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 border-b border-neutral-800 pr-4 pl-24">
            {/* Pages contribute their menus (Fichier, …) while mounted. */}
            <MenuBar />
            <div className="flex-1" />
            <HeaderCredits />
            <HeaderActions />
            <AssistantToggle />
            <SettingsToggle />
          </header>
          <MissingKeyBanner />
          <UpdateBanner />
          <DemoRecordingBanner />
          <div className="flex min-h-0 flex-1">
            <AssistantSidebar />
            <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
              <Outlet />
            </main>
          </div>
        </div>
        <FirstRunOverlay />
      </FeedbackProvider>
    </MenuBarProvider>
  )
}

/**
 * Settings gear — a TOGGLE, not a one-way link: clicking it while already on
 * /settings goes back where you came from. Anything that opens from a button
 * should close from that same button; the gear was the one place in the header
 * that didn't.
 *
 * The origin is remembered rather than using `history.back()`, which would walk
 * back into an earlier route if the user navigated within /settings, or do
 * nothing at all when settings was the first screen.
 */
function SettingsToggle(): React.JSX.Element {
  const { t } = useTranslation()
  const router = useRouter()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const onSettings = pathname === '/settings'
  const origin = useRef('/')
  if (!onSettings) origin.current = pathname

  const toggle = useCallback(() => {
    router.navigate({ to: onSettings ? origin.current : '/settings' })
  }, [router, onSettings])

  useShortcut('openSettings', toggle)

  return (
    <button
      onClick={toggle}
      aria-pressed={onSettings}
      className={`rounded-md p-1.5 ${
        onSettings
          ? 'bg-neutral-800 text-neutral-200'
          : 'text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200'
      }`}
      title={t('settings.title')}
    >
      <Settings className="h-4 w-4" />
    </button>
  )
}

/** Permanent header toggle for the global assistant sidebar (§4.10 phase 1). */
function AssistantToggle(): React.JSX.Element {
  const { t } = useTranslation()
  const { open } = useAssistant()
  return (
    <Button
      variant={open ? 'secondary' : 'ghost'}
      size="sm"
      onClick={toggleAssistant}
      title={t('chat.toggleTitle')}
    >
      <MessageSquare className="h-4 w-4" />
    </Button>
  )
}

/**
 * App-wide notice when an update finished downloading — until this, Settings →
 * Updates was the only place the new version showed up. Hidden on /settings
 * (that page has its own install button) and dismissible for the session: the
 * update installs on quit anyway (autoInstallOnAppQuit), so the banner is an
 * offer to restart now, not a nag.
 */
function UpdateBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [dismissed, setDismissed] = useState(false)
  const onSettingsPage = useRouterState({
    select: (state) => state.location.pathname === '/settings'
  })
  const state = useQuery({
    queryKey: ['update', 'state'],
    queryFn: () => invoke('update:getState')
  })

  // The main process pushes every meaningful updater transition; Settings
  // shares the same query key, so this keeps both surfaces live.
  useEffect(() => {
    return window.api.on('event:updateStateChanged', () => {
      void queryClient.invalidateQueries({ queryKey: ['update'] })
    })
  }, [queryClient])

  const install = useMutation({ mutationFn: () => invoke('update:install') })

  if (dismissed || onSettingsPage || state.data?.status !== 'downloaded') return null
  return (
    <div className="flex shrink-0 items-center justify-center gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-1.5">
      <Download className="h-3.5 w-3.5 text-accent" />
      <span className="text-xs text-neutral-300">
        {t('updateBanner.text', { version: state.data.version ?? '' })}
      </span>
      <button
        className="rounded-md bg-highlight px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-highlight-hover"
        onClick={() => install.mutate()}
      >
        {t('settings.updateInstall')}
      </button>
      <button
        className="rounded-md p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        onClick={() => setDismissed(true)}
        title={t('updateBanner.dismiss')}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

/**
 * Demo mode (§9): the REC banner + the whole renderer-side wiring — the
 * demoControl subscription, the reload reconciliation and the ⇧⌘R toggle all
 * live here because this component is always mounted while the banner itself
 * only renders during a take. Everything is inert unless the app was launched
 * with RACCORD_DEMO=1 (app:getInfo.demo).
 */
function DemoRecordingBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const info = useQuery({ queryKey: ['app', 'info'], queryFn: () => invoke('app:getInfo') })
  const demo = info.data?.demo === true
  const { recording, startedAt } = useDemoRecorder()
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const projectId = /^\/projects\/([^/]+)/.exec(pathname)?.[1]

  useEffect(() => {
    if (!demo) return
    void reconcileDemoStatus()
    return window.api.on('event:demoControl', (payload) =>
      handleDemoControl(payload as DemoControlPayload)
    )
  }, [demo])

  const toggle = useCallback(() => {
    const run = recording
      ? invoke('demo:stop')
      : invoke('demo:start', projectId ? { projectId } : {})
    void run.then(
      () => undefined,
      (error: unknown) => reportRendererError('demo', error)
    )
  }, [recording, projectId])

  // Stop must work while a text field has focus — a demo often ends mid-typing.
  useShortcut('toggleDemoRecording', toggle, { enabled: demo, allowWhileTyping: true })

  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!recording || startedAt === null) return
    const update = (): void => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [recording, startedAt])

  if (!demo || !recording || startedAt === null) return null
  const clock = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`
  return (
    <div className="flex shrink-0 items-center justify-center gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-1.5">
      <span className="h-2 w-2 animate-pulse rounded-full bg-danger" aria-hidden />
      <span className="text-xs text-neutral-300">
        {t('demoBanner.recording')} · {clock}
      </span>
      <button
        className="rounded-md bg-neutral-800 px-2.5 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-700"
        onClick={toggle}
      >
        {t('demoBanner.stop')}
      </button>
    </div>
  )
}

/**
 * Persistent, non-blocking fallback when no kie.ai key is configured — the app
 * is inert without one, and the gear icon shouldn't be the only way to find
 * out. Hidden while the first-run overlay is up (it owns the key step) and on
 * the settings page itself (the CTA's destination).
 */
function MissingKeyBanner(): React.JSX.Element | null {
  const { t } = useTranslation()
  const onSettingsPage = useRouterState({
    select: (state) => state.location.pathname === '/settings'
  })
  const onboardingCompleted = useQuery({
    queryKey: ['settings', 'onboardingCompleted'],
    queryFn: () => invoke('settings:getOnboardingCompleted')
  })
  const keyStatus = useQuery({
    queryKey: ['settings', 'settings:kieApiKeyStatus'],
    queryFn: () => invoke('settings:kieApiKeyStatus')
  })

  if (onSettingsPage || onboardingCompleted.data !== true || keyStatus.data?.configured !== false) {
    return null
  }
  return (
    <div className="flex shrink-0 items-center justify-center gap-3 border-b border-neutral-800 bg-neutral-900 px-4 py-1.5">
      <KeyRound className="h-3.5 w-3.5 text-warning" />
      <span className="text-xs text-neutral-300">{t('onboarding.bannerText')}</span>
      <Link
        to="/settings"
        className="rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-accent-hover"
      >
        {t('onboarding.bannerCta')}
      </Link>
    </div>
  )
}
