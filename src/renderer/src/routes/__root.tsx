import { useQuery } from '@tanstack/react-query'
import { Link, Outlet, createRootRoute, useRouter, useRouterState } from '@tanstack/react-router'
import { KeyRound, MessageSquare, Settings } from 'lucide-react'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { HeaderActions, MenuBar, MenuBarProvider } from '@renderer/components/menubar/MenuBar'
import { FeedbackProvider } from '@renderer/components/feedback/Feedback'
import { HeaderCredits } from '@renderer/components/HeaderCredits'
import { Button } from '@renderer/components/ui/Button'
import { AssistantSidebar } from '@renderer/features/assistant/AssistantSidebar'
import { toggleAssistant, useAssistant } from '@renderer/features/assistant/assistantStore'
import { FirstRunOverlay } from '@renderer/features/onboarding/FirstRunOverlay'
import { invoke } from '@renderer/lib/ipc'
import type { NavigatePayload } from '@shared/ipc/contracts'

export const Route = createRootRoute({
  component: RootLayout
})

function RootLayout(): React.JSX.Element {
  const { t } = useTranslation()
  const router = useRouter()

  // The assistant's open_video tool pushes a route for the app to follow.
  useEffect(() => {
    return window.api.on('event:navigate', (payload) => {
      const path = (payload as NavigatePayload)?.path
      if (typeof path === 'string' && path.startsWith('/')) router.history.push(path)
    })
  }, [router])

  // Global assistant shortcut — ⌘J (mac) / Ctrl+J.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        toggleAssistant()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

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
            <Link
              to="/settings"
              className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              title={t('settings.title')}
            >
              <Settings className="h-4 w-4" />
            </Link>
          </header>
          <MissingKeyBanner />
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
