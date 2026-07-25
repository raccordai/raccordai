import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Check,
  ClipboardList,
  Eraser,
  FileImage,
  Folder,
  MessageSquare,
  Paperclip,
  PenTool,
  Send,
  SquareSlash,
  Wrench,
  X
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppContext, ChatImage, ChatItem, ChatPlan } from '@shared/ipc/contracts'
import { Button } from '@renderer/components/ui/Button'
import { useToast } from '@renderer/components/feedback/Feedback'
import { MentionMenu, useMentionMenu, type MentionItem } from '@renderer/components/ui/MentionMenu'
import { ASSISTANT_MODEL_SHORT } from '@renderer/features/settings/AssistantModelSwitcher'
import { ChatMarkdown } from '@renderer/features/workflow/ChatMarkdown'
import { invoke } from '@renderer/lib/ipc'
import type { MentionToken } from '@renderer/lib/mentionToken'

/** "/" opens the assistant's action list (only as the first character);
 *  "@" mentions a project or a library reference. */
const CHAT_TRIGGERS = [{ char: '/', startOnly: true }, { char: '@' }]

const MAX_ATTACHMENTS = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** data:image/…;base64,XXXX → ChatImage (mediaType + raw base64). */
function dataUrlToChatImage(dataUrl: string): ChatImage | null {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl)
  return match ? ({ mediaType: match[1], data: match[2] } as ChatImage) : null
}

/**
 * Assistant conversation — Claude-style transcript driving the app through
 * the main-process agentic loop (claude-opus-4-8 + graph tools). Hosted by
 * the global AssistantSidebar; tool calls render as compact chips.
 */
export function ChatPanel({
  videoId,
  projectId,
  emptyText,
  prefill,
  onPrefillConsumed,
  getContext,
  onClose
}: {
  videoId: string
  /** '' for the home session (the assistant then works across projects). */
  projectId: string
  /** Overrides the default empty-state hint (the home session has its own). */
  emptyText?: string
  /** Draft injected into the input (e.g. "fix this failed prompt" buttons). */
  prefill?: string | null
  onPrefillConsumed?: () => void
  /** Snapshot of what the user is looking at, attached to each send (§4.10). */
  getContext?: () => AppContext | undefined
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  // Seeded from `prefill` so the injected draft survives any remount of the
  // panel during the open+prefill batch; kept until the user sends (consume).
  const [draft, setDraft] = useState(prefill ?? '')
  /** Attached images as data URLs (previews + payload). */
  const [attachments, setAttachments] = useState<string[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  /** Caret position in the input — drives the "/" and "@" autocomplete. */
  const [caret, setCaret] = useState(0)

  async function addFiles(files: FileList | null): Promise<void> {
    if (!files) return
    for (const file of Array.from(files)) {
      if (!IMAGE_TYPES.has(file.type)) continue
      if (file.size > MAX_IMAGE_BYTES) {
        toast.warning(t('chat.imageTooBig', { name: file.name }))
        continue
      }
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result))
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(file)
      })
      setAttachments((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, dataUrl]))
    }
  }

  // The assistant runs on the kie.ai key (Claude proxy).
  const kieStatus = useQuery({
    queryKey: ['settings', 'kieApiKey'],
    queryFn: () => invoke('settings:kieApiKeyStatus')
  })
  const assistantModel = useQuery({
    queryKey: ['settings', 'assistantModel'],
    queryFn: () => invoke('settings:getAssistantModel')
  })
  const chat = useQuery({
    queryKey: ['chat', videoId],
    queryFn: () => invoke('chat:get', { videoId })
  })

  // ── "/" actions and "@" mentions ──────────────────────────────────────────
  const tools = useQuery({
    queryKey: ['chat', 'tools'],
    queryFn: () => invoke('chat:listTools'),
    staleTime: Infinity
  })
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => invoke('projects:list')
  })
  // References come from the project the user is looking at (falls back to the
  // session's own project for legacy per-video threads).
  const mentionProjectId = getContext?.()?.projectId ?? (projectId || undefined)
  const mentionAssets = useQuery({
    queryKey: ['assets', 'mention', mentionProjectId],
    queryFn: () => invoke('assets:listByProject', { projectId: mentionProjectId as string }),
    enabled: mentionProjectId !== undefined
  })

  const itemsFor = useCallback(
    (token: MentionToken): MentionItem[] => {
      if (token.char === '/') {
        return (tools.data ?? []).map((tool) => ({
          id: `tool:${tool.name}`,
          label: tool.name,
          description: tool.description,
          insert: `/${tool.name}`,
          section: t('chat.menuActions'),
          icon: <SquareSlash className="h-3.5 w-3.5 text-accent-soft" />
        }))
      }
      // Design sheets first: they are the references worth @-mentioning.
      const assets = [...(mentionAssets.data ?? [])].sort(
        (a, b) => Number(b.designId !== null) - Number(a.designId !== null)
      )
      return [
        ...(projects.data ?? []).map((project) => ({
          id: `project:${project.id}`,
          label: project.name,
          insert: `@${project.name}`,
          section: t('chat.menuProjects'),
          icon: <Folder className="h-3.5 w-3.5 text-accent" />
        })),
        ...assets.map((asset) => ({
          id: `asset:${asset.id}`,
          label: asset.name,
          description: asset.designId
            ? `${t(`designs.${asset.designId}.name` as never)}${asset.designSubject ? ` — ${asset.designSubject}` : ''}`
            : asset.tags.join(', ') || undefined,
          insert: `@${asset.name}`,
          section: t('chat.menuReferences'),
          icon: asset.designId ? (
            <PenTool className="h-3.5 w-3.5 text-highlight" />
          ) : (
            <FileImage className="h-3.5 w-3.5 text-accent-soft" />
          )
        }))
      ]
    },
    [tools.data, projects.data, mentionAssets.data, t]
  )
  const mention = useMentionMenu({ value: draft, caret, triggers: CHAT_TRIGGERS, itemsFor })

  /** Apply a mention pick: replace the token, restore focus and caret. */
  function applyMentionResult(result: { value: string; caret: number }): void {
    setDraft(result.value)
    setCaret(result.caret)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(result.caret, result.caret)
    })
  }

  // Live updates pushed by the main process while the loop runs.
  useEffect(() => {
    return window.api.on('event:chatUpdate', (payload) => {
      if ((payload as { videoId?: string })?.videoId === videoId) {
        void queryClient.invalidateQueries({ queryKey: ['chat', videoId] })
      }
    })
  }, [videoId, queryClient])

  // Keep the transcript pinned to the bottom (streaming text included).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [chat.data?.items.length, chat.data?.busy, chat.data?.partialText])

  // A new prepared draft while the panel is already open replaces the input.
  useEffect(() => {
    if (prefill != null && prefill !== '') setDraft(prefill)
  }, [prefill])

  const send = useMutation({
    mutationFn: (args: { text: string; images: ChatImage[] }) =>
      invoke('chat:send', {
        videoId,
        projectId,
        text: args.text,
        images: args.images.length > 0 ? args.images : undefined,
        context: getContext?.()
      }),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['chat', videoId] })
  })

  const busy = chat.data?.busy ?? false
  const hasKey = kieStatus.data?.configured ?? false

  function submit(): void {
    const text = draft.trim()
    if (!text || busy || !hasKey) return
    const images = attachments
      .map(dataUrlToChatImage)
      .filter((img): img is ChatImage => img !== null)
    setDraft('')
    setAttachments([])
    onPrefillConsumed?.()
    send.mutate({ text, images })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
          <MessageSquare className="h-3.5 w-3.5 text-accent" /> {t('chat.title')}
          <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium text-accent-soft">
            {ASSISTANT_MODEL_SHORT[assistantModel.data ?? 'claude-opus-4-8']}
          </span>
        </h2>
        <div className="flex items-center gap-0.5">
          {(chat.data?.items.length ?? 0) > 0 && (
            <button
              onClick={() => void invoke('chat:clear', { videoId })}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              title={t('chat.clear')}
            >
              <Eraser className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div ref={scrollRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
        {(chat.data?.items.length ?? 0) === 0 && !busy && (
          <p className="mt-6 px-2 text-center text-xs leading-relaxed text-neutral-500">
            {emptyText ?? t('chat.empty')}
          </p>
        )}
        {chat.data?.items.map((item, i) => (
          <ChatItemView
            key={i}
            item={item}
            // Only the latest approval card (plan or destructive action) with
            // no user reply after it is actionable — approving a stale card
            // out of order would desync the conversation.
            cardActive={i === activeCardIndex(chat.data?.items ?? []) && !busy}
            onApprove={() => {
              if (busy || !hasKey) return
              send.mutate({
                text: t(
                  item.type === 'action' ? 'chat.actionApproveMessage' : 'chat.planApproveMessage'
                ),
                images: []
              })
            }}
            onRequestChanges={() =>
              setDraft(
                t(item.type === 'action' ? 'chat.actionChangesPrefill' : 'chat.planChangesPrefill')
              )
            }
          />
        ))}
        {busy &&
          (chat.data?.partialText ? (
            // Streaming turn (§4.10 phase 6): the text grows in place, then the
            // finished transcript item replaces it.
            <ChatMarkdown text={chat.data.partialText}>
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />
            </ChatMarkdown>
          ) : (
            <div className="flex items-center gap-2 px-1 text-xs text-neutral-500">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              {t('chat.thinking')}
            </div>
          ))}
        {chat.data?.error && (
          <p className="rounded-md bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
            {chat.data.error}
          </p>
        )}
      </div>

      <div className="border-t border-neutral-800 p-3">
        {!hasKey ? (
          <p className="text-xs leading-relaxed text-warning">{t('chat.needKey')}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {attachments.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {attachments.map((src, i) => (
                  <div
                    key={i}
                    className="group relative h-14 w-14 overflow-hidden rounded-md border border-neutral-700"
                  >
                    <img src={src} alt="" className="h-full w-full object-cover" />
                    <button
                      onClick={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded bg-black/70 text-neutral-300 opacity-0 group-hover:opacity-100 hover:text-neutral-100"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="relative">
              {mention.open && (
                <div className="absolute inset-x-0 bottom-full z-30 mb-1">
                  <MentionMenu
                    items={mention.items}
                    active={mention.active}
                    onHover={mention.setActive}
                    onPick={(item) => {
                      const result = mention.select(item)
                      if (result) applyMentionResult(result)
                    }}
                  />
                </div>
              )}
              <textarea
                ref={inputRef}
                rows={Math.min(8, Math.max(2, draft.split('\n').length))}
                placeholder={t('chat.placeholder')}
                value={draft}
                disabled={busy}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setCaret(event.target.selectionStart ?? event.target.value.length)
                }}
                onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
                onPaste={(event) => void addFiles(event.clipboardData?.files ?? null)}
                onKeyDown={(event) => {
                  if (mention.onKeyDown(event, applyMentionResult)) return
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    submit()
                  }
                }}
                className="max-h-56 w-full resize-none rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none disabled:opacity-60"
              />
            </div>
            <div className="flex items-center justify-between">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                className="hidden"
                onChange={(event) => {
                  void addFiles(event.target.files)
                  event.target.value = ''
                }}
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={busy || attachments.length >= MAX_ATTACHMENTS}
                className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
                title={t('chat.attach')}
              >
                <Paperclip className="h-3.5 w-3.5" />
                {attachments.length > 0
                  ? `${attachments.length}/${MAX_ATTACHMENTS}`
                  : t('chat.attach')}
              </button>
              <button
                onClick={submit}
                disabled={busy || draft.trim() === ''}
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-accent text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
                title={t('chat.send')}
              >
                <Send className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Latest approval card (plan or destructive action) still awaiting a user
 * reply — the only one whose buttons are enabled.
 */
function activeCardIndex(items: ChatItem[]): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const type = items[i]!.type
    if (type === 'user') return -1
    if (type === 'plan' || type === 'action') return i
  }
  return -1
}

function ChatItemView({
  item,
  cardActive,
  onApprove,
  onRequestChanges
}: {
  item: ChatItem
  /** True when this is the pending approval card — its buttons are enabled. */
  cardActive?: boolean
  onApprove?: () => void
  onRequestChanges?: () => void
}): React.JSX.Element {
  if (item.type === 'plan') {
    return (
      <PlanCard
        plan={item.plan}
        active={cardActive ?? false}
        onApprove={onApprove}
        onRequestChanges={onRequestChanges}
      />
    )
  }
  if (item.type === 'action') {
    return (
      <ActionCard
        label={item.label}
        active={cardActive ?? false}
        onApprove={onApprove}
        onRequestChanges={onRequestChanges}
      />
    )
  }
  if (item.type === 'user') {
    return (
      <div className="ml-6 flex flex-col items-end gap-1.5 self-end">
        {item.images && item.images.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {item.images.map((src, i) => (
              <img
                key={i}
                src={src}
                alt=""
                className="h-16 w-16 rounded-lg border border-neutral-700 object-cover"
              />
            ))}
          </div>
        )}
        <div className="rounded-2xl rounded-br-md bg-neutral-800 px-3 py-2 text-sm whitespace-pre-wrap text-neutral-100">
          {item.text}
        </div>
      </div>
    )
  }
  if (item.type === 'assistant') {
    return <ChatMarkdown text={item.text} />
  }
  // Compact tool chip.
  return (
    <div
      className={`flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-[11px] ${
        item.ok ? 'bg-accent/10 text-accent-soft' : 'bg-danger/10 text-danger'
      }`}
      title={item.name}
    >
      {item.ok ? <Check className="h-3 w-3" /> : <Wrench className="h-3 w-3" />}
      <span className="truncate">{item.label}</span>
    </div>
  )
}

/**
 * Destructive-approval card (§4.10 phase 3): a destructive tool was called
 * without confirm — nothing executed. Approve / Request changes post back as
 * user messages; on approval the model re-calls the tool with confirm: true.
 */
function ActionCard({
  label,
  active,
  onApprove,
  onRequestChanges
}: {
  label: string
  active: boolean
  onApprove?: () => void
  onRequestChanges?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-warning/40 bg-warning/5 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-warning">
        <AlertTriangle className="h-3.5 w-3.5" />
        {t('chat.actionTitle')}
      </div>
      <p className="mt-1.5 text-sm text-neutral-200">{label}</p>
      {active && (
        <div className="mt-2.5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onRequestChanges}>
            {t('chat.plan.requestChanges')}
          </Button>
          <Button variant="primary" size="sm" onClick={onApprove}>
            <Check className="h-3.5 w-3.5" /> {t('chat.plan.approve')}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Structured plan presented by the assistant (§4.7): per-shot model + cost,
 * grand total, Approve / Request changes posting back as user messages. The
 * card persists in the transcript like tool chips do; only the latest one is
 * actionable.
 */
function PlanCard({
  plan,
  active,
  onApprove,
  onRequestChanges
}: {
  plan: ChatPlan
  active: boolean
  onApprove?: () => void
  onRequestChanges?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 p-3">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-accent-soft">
        <ClipboardList className="h-3.5 w-3.5" />
        {t('chat.plan.title', { count: plan.shots.length })}
        {plan.style && (
          <span className="ml-auto rounded bg-accent/15 px-1.5 py-0.5 text-[9px] font-medium">
            {plan.style}
          </span>
        )}
      </div>
      <ul className="mt-2 space-y-1.5">
        {plan.shots.map((shot, i) => (
          <li key={i} className="rounded-md bg-neutral-900/60 px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="min-w-0 flex-1 truncate font-medium text-neutral-100">
                {shot.label}
              </span>
              <span className="flex-shrink-0 font-mono text-[10px] text-neutral-400">
                {shot.estCredits !== null
                  ? t('chat.plan.credits', { credits: shot.estCredits })
                  : '—'}
              </span>
            </div>
            <div className="mt-0.5 text-[10px] leading-snug text-neutral-400">
              {shot.description}
            </div>
            <div className="mt-0.5 flex items-center gap-2 font-mono text-[9px] text-neutral-600">
              {shot.modelId}
              {shot.panels && <span>· {t('chat.plan.panels', { panels: shot.panels })}</span>}
            </div>
          </li>
        ))}
      </ul>
      {plan.totalCredits !== null && (
        <div className="mt-2 flex items-baseline justify-between border-t border-neutral-800 pt-1.5 text-[11px]">
          <span className="font-semibold text-neutral-200">{t('chat.plan.total')}</span>
          <span className="font-mono font-semibold text-neutral-100">
            {t('chat.plan.credits', { credits: plan.totalCredits })}
          </span>
        </div>
      )}
      {active && (
        <div className="mt-2.5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onRequestChanges}>
            {t('chat.plan.requestChanges')}
          </Button>
          <Button variant="primary" size="sm" onClick={onApprove}>
            <Check className="h-3.5 w-3.5" /> {t('chat.plan.approve')}
          </Button>
        </div>
      )}
    </div>
  )
}
