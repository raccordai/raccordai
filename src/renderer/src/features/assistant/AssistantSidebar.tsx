import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { Check, ChevronDown, History, MessageSquare, Pencil, SquarePen, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { HOME_CHAT_ID, type AppContext } from '@shared/ipc/contracts'
import { useConfirm } from '@renderer/components/feedback/Feedback'
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

/** Selected thread, so a reload lands back on the conversation in progress. */
const SELECTED_THREAD_KEY = 'raccord.assistant.thread'

function storedThread(): string {
  try {
    return localStorage.getItem(SELECTED_THREAD_KEY) ?? HOME_CHAT_ID
  } catch {
    return HOME_CHAT_ID
  }
}

/**
 * Global assistant sidebar — full-height left-hand column of the root layout,
 * present on every route. Conversations are THREADS: "New chat" opens an empty
 * one and the switcher lists the rest, most recent first. New threads are
 * unbound (explicit-id toolset); the per-turn <app-context> block tells the
 * model what the user is looking at. Threads migrated from the pre-thread
 * per-video sessions stay bound to their video.
 */
export function AssistantSidebar(): React.JSX.Element | null {
  const { t } = useTranslation()
  const { open, width, prefill } = useAssistant()
  const [thread, setThread] = useState<string>(storedThread)
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const queryClient = useQueryClient()

  const threads = useQuery({
    queryKey: ['chat', 'threads'],
    queryFn: () => invoke('chat:listThreads'),
    enabled: open
  })
  // A thread persisted while the sidebar is open (title derived from the first
  // message, new transcript) must show up without a reload.
  useEffect(() => {
    return window.api.on('event:chatUpdate', () => {
      void queryClient.invalidateQueries({ queryKey: ['chat', 'threads'] })
    })
  }, [queryClient])

  const selectThread = useCallback((id: string) => {
    setThread(id)
    try {
      localStorage.setItem(SELECTED_THREAD_KEY, id)
    } catch {
      // Private mode / storage disabled: the selection just won't persist.
    }
  }, [])

  // A deleted thread (or a stale localStorage entry) falls back to the newest.
  const rows = threads.data ?? []
  const current = rows.find((row) => row.id === thread)
  const activeId = current?.id ?? rows[0]?.id ?? HOME_CHAT_ID
  const activeProjectId = current?.projectId ?? ''

  const newThread = useMutation({
    mutationFn: () => invoke('chat:newThread', {}),
    onSuccess: ({ threadId }) => {
      selectThread(threadId)
      void queryClient.invalidateQueries({ queryKey: ['chat', 'threads'] })
    }
  })

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
      <ChatPanel
        // Remount per thread so transcript scroll/draft reset with the switch.
        key={activeId}
        threadId={activeId}
        projectId={activeProjectId}
        emptyText={t('chat.homeEmpty')}
        prefill={prefill}
        onPrefillConsumed={consumeAssistantPrefill}
        getContext={getContext}
        onClose={closeAssistant}
        headerExtras={
          <>
            <ThreadSwitcher value={activeId} threads={rows} onChange={selectThread} />
            <button
              onClick={() => newThread.mutate()}
              disabled={newThread.isPending}
              title={t('chat.newThread')}
              aria-label={t('chat.newThread')}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            >
              <SquarePen className="h-3.5 w-3.5" />
            </button>
          </>
        }
      />
    </aside>
  )
}

interface ThreadRow {
  id: string
  title: string | null
  videoId: string | null
  videoName: string | null
}

function threadLabel(row: ThreadRow | undefined, fallback: string): string {
  if (!row) return fallback
  return row.title ?? row.videoName ?? fallback
}

/**
 * Conversation switcher — the header's dropdown, folded into the ChatPanel
 * title bar rather than a second bordered row of its own (it used to stack a
 * whole extra bar above the panel).
 */
function ThreadSwitcher({
  value,
  threads,
  onChange
}: {
  value: string
  threads: ThreadRow[]
  onChange: (threadId: string) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const queryClient = useQueryClient()
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

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['chat', 'threads'] })
  }

  async function rename(row: ThreadRow): Promise<void> {
    const next = window.prompt(t('chat.renameThread'), threadLabel(row, t('chat.threadUntitled')))
    if (!next?.trim()) return
    await invoke('chat:renameThread', { threadId: row.id, title: next.trim() })
    refresh()
  }

  async function remove(row: ThreadRow): Promise<void> {
    const ok = await confirm({
      title: t('chat.deleteThread'),
      message: t('chat.deleteThreadConfirm', { name: threadLabel(row, t('chat.threadUntitled')) }),
      confirmLabel: t('library.delete'),
      danger: true
    })
    if (!ok) return
    await invoke('chat:deleteThread', { threadId: row.id })
    if (row.id === value) {
      const next = threads.find((r) => r.id !== row.id)
      if (next) onChange(next.id)
    }
    setOpen(false)
    refresh()
  }

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        onClick={() => setOpen((v) => !v)}
        title={t('chat.threadSwitcher')}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-xs transition ${
          open
            ? 'bg-neutral-800 text-neutral-100'
            : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'
        }`}
      >
        <span className="min-w-0 flex-1 truncate text-left">
          {threadLabel(
            threads.find((row) => row.id === value),
            t('chat.threadUntitled')
          )}
        </span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-72 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-900 py-1 shadow-xl"
        >
          {threads.length === 0 && (
            <p className="px-3 py-1.5 text-xs text-neutral-500">{t('chat.threadNone')}</p>
          )}
          {threads.map((row) => (
            <ThreadOption
              key={row.id}
              icon={
                row.videoId ? (
                  <History className="h-3.5 w-3.5 text-neutral-500" />
                ) : (
                  <MessageSquare className="h-3.5 w-3.5 text-accent-soft" />
                )
              }
              label={threadLabel(row, t('chat.threadUntitled'))}
              active={row.id === value}
              onSelect={() => {
                setOpen(false)
                onChange(row.id)
              }}
              onRename={() => void rename(row)}
              onDelete={() => void remove(row)}
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
  onSelect,
  onRename,
  onDelete
}: {
  icon: React.ReactNode
  label: string
  active: boolean
  onSelect: () => void
  onRename: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div
      className={`group flex items-center gap-1 px-2 ${active ? '' : 'hover:bg-neutral-800'}`}
      role="option"
      aria-selected={active}
    >
      <button
        onClick={onSelect}
        className={`flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-xs ${
          active ? 'text-neutral-100' : 'text-neutral-300'
        }`}
      >
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {active && <Check className="h-3.5 w-3.5 shrink-0 text-accent-soft" />}
      </button>
      <button
        onClick={onRename}
        title={t('chat.renameThread')}
        aria-label={t('chat.renameThread')}
        className="rounded p-1 text-neutral-600 opacity-0 group-hover:opacity-100 hover:text-neutral-200"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        onClick={onDelete}
        title={t('chat.deleteThread')}
        aria-label={t('chat.deleteThread')}
        className="rounded p-1 text-neutral-600 opacity-0 group-hover:opacity-100 hover:text-danger"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  )
}
