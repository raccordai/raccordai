import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { Check, ChevronDown, History, MessageSquare } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HOME_CHAT_ID, type AppContext } from '@shared/ipc/contracts'
import { ChatPanel } from '@renderer/features/workflow/ChatPanel'
import { invoke } from '@renderer/lib/ipc'
import { getEditorContext } from './appContextStore'
import {
  ASSISTANT_MAX_WIDTH,
  ASSISTANT_MIN_WIDTH,
  closeAssistant,
  consumeAssistantPrefill,
  setAssistantWidth,
  useAssistant
} from './assistantStore'

const VIDEO_ROUTE = /^\/projects\/([^/]+)\/videos\/([^/]+)$/

/**
 * Global assistant sidebar (§4.10) — full-height left-hand column of the
 * root layout, present on every route. Since phase 5 the GLOBAL thread
 * (`HOME_CHAT_ID`, explicit-id toolset) is the default everywhere — the
 * per-turn <app-context> block tells the model what the user is looking at —
 * and legacy per-video threads remain readable/resumable via the switcher
 * (they are no longer auto-created).
 */
export function AssistantSidebar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { open, width, prefill } = useAssistant()
  /** Selected conversation: the global thread, or a legacy per-video thread. */
  const [thread, setThread] = useState<string>(HOME_CHAT_ID)
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  // Legacy per-video threads (persisted before phase 5) — switcher hidden
  // when there are none.
  const queryClient = useQueryClient()
  const legacyThreads = useQuery({
    queryKey: ['chat', 'sessions'],
    queryFn: () => invoke('chat:listSessions'),
    enabled: open
  })
  // A thread persisted while the sidebar is open (e.g. a resumed legacy
  // conversation) must show up without a reload.
  useEffect(() => {
    return window.api.on('event:chatUpdate', () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', 'sessions'] })
    })
  }, [queryClient])
  const threadRow = legacyThreads.data?.find((row) => row.videoId === thread)
  const session =
    thread !== HOME_CHAT_ID && threadRow
      ? { videoId: threadRow.videoId, projectId: threadRow.projectId, home: false }
      : { videoId: HOME_CHAT_ID, projectId: '', home: true }

  // What the user is LOOKING at (independent of the selected thread): route +
  // ids parsed from it, live selection/error from the editor-fed store.
  const viewed = useMemo(
    () => ({
      projectId: /^\/projects\/([^/]+)/.exec(pathname)?.[1],
      videoId: VIDEO_ROUTE.exec(pathname)?.[2]
    }),
    [pathname]
  )
  const getContext = useCallback((): AppContext => {
    const editor = getEditorContext()
    return {
      route: pathname,
      projectId: viewed.projectId,
      videoId: viewed.videoId,
      selectedNodeId: editor.selectedNodeId ?? undefined,
      lastError: editor.lastError ?? undefined
    }
  }, [pathname, viewed])

  // Drag the right edge to resize; width is persisted by the store.
  const startResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const onMove = (move: PointerEvent): void => {
      setAssistantWidth(move.clientX)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }, [])

  if (!open) return null

  return (
    <aside
      className="relative flex min-h-0 shrink-0 flex-col border-r border-neutral-800 bg-neutral-900/40"
      style={{ width, minWidth: ASSISTANT_MIN_WIDTH, maxWidth: ASSISTANT_MAX_WIDTH }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('chat.resizeHandle')}
        onPointerDown={startResize}
        className="absolute inset-y-0 right-0 z-10 w-1.5 cursor-col-resize hover:bg-accent/40 active:bg-accent/60"
      />
      {(legacyThreads.data?.length ?? 0) > 0 && (
        <ThreadSwitcher
          value={session.home ? HOME_CHAT_ID : session.videoId}
          threads={legacyThreads.data ?? []}
          onChange={setThread}
        />
      )}
      <ChatPanel
        // Remount per thread so transcript scroll/draft reset with the switch.
        key={session.videoId}
        videoId={session.videoId}
        projectId={session.projectId}
        emptyText={session.home ? t('chat.homeEmpty') : undefined}
        prefill={prefill}
        onPrefillConsumed={consumeAssistantPrefill}
        getContext={getContext}
        onClose={closeAssistant}
      />
    </aside>
  )
}

/**
 * Conversation switcher — same dropdown idiom as the app menu bar, replacing
 * the native <select> (global thread on top, legacy per-video threads below).
 */
function ThreadSwitcher({
  value,
  threads,
  onChange
}: {
  value: string
  threads: { videoId: string; videoName: string | null }[]
  onChange: (videoId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape (the button toggles itself).
  useEffect(() => {
    if (!open) return
    function onPointerDown(e: PointerEvent): void {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const current = threads.find((row) => row.videoId === value)
  const currentLabel =
    value === HOME_CHAT_ID ? t('chat.threadGlobal') : (current?.videoName ?? value)

  function select(videoId: string): void {
    setOpen(false)
    onChange(videoId)
  }

  return (
    <div ref={rootRef} className="relative border-b border-neutral-800 px-2 py-1.5">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('chat.threadSwitcher')}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition ${
          open
            ? 'bg-neutral-800 text-neutral-100'
            : 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100'
        }`}
      >
        <History className="h-3.5 w-3.5 shrink-0 text-accent-soft" />
        <span className="min-w-0 flex-1 truncate text-left">{currentLabel}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute inset-x-2 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 py-1 shadow-xl"
        >
          <ThreadOption
            icon={<MessageSquare className="h-3.5 w-3.5 text-accent-soft" />}
            label={t('chat.threadGlobal')}
            active={value === HOME_CHAT_ID}
            onSelect={() => select(HOME_CHAT_ID)}
          />
          <div className="my-1 h-px bg-neutral-800" />
          <div className="px-3 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-neutral-500 uppercase">
            {t('chat.threadLegacySection')}
          </div>
          {threads.map((row) => (
            <ThreadOption
              key={row.videoId}
              icon={<History className="h-3.5 w-3.5 text-neutral-500" />}
              label={row.videoName ?? row.videoId}
              active={value === row.videoId}
              onSelect={() => select(row.videoId)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function ThreadOption({
  icon,
  label,
  active,
  onSelect
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  return (
    <button
      role="option"
      aria-selected={active}
      onClick={onSelect}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
        active ? 'text-neutral-100' : 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100'
      }`}
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent-soft" />}
    </button>
  )
}
