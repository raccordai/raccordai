import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Eraser, MessageSquare, Paperclip, Send, Wrench, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ChatImage, ChatItem } from '@shared/ipc/contracts'
import { useToast } from '@renderer/components/feedback/Feedback'
import { ASSISTANT_MODEL_SHORT } from '@renderer/features/settings/AssistantModelSwitcher'
import { invoke } from '@renderer/lib/ipc'

const MAX_ATTACHMENTS = 4
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/** data:image/…;base64,XXXX → ChatImage (mediaType + raw base64). */
function dataUrlToChatImage(dataUrl: string): ChatImage | null {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(dataUrl)
  return match ? ({ mediaType: match[1], data: match[2] } as ChatImage) : null
}

/**
 * Assistant island — a Claude-style conversation that drives the workflow
 * through the main-process agentic loop (claude-opus-4-8 + graph tools).
 * Stacked on the LEFT of the canvas; tool calls render as compact chips.
 */
export function ChatPanel({
  videoId,
  projectId,
  emptyText,
  prefill,
  onPrefillConsumed,
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

  // Live updates pushed by the main process while the loop runs.
  useEffect(() => {
    return window.api.on('event:chatUpdate', (payload) => {
      if ((payload as { videoId?: string })?.videoId === videoId) {
        void queryClient.invalidateQueries({ queryKey: ['chat', videoId] })
      }
    })
  }, [videoId, queryClient])

  // Keep the transcript pinned to the bottom.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [chat.data?.items.length, chat.data?.busy])

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
        images: args.images.length > 0 ? args.images : undefined
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
    <aside className="island flex min-h-0 w-96 flex-1 flex-shrink-0 flex-col overflow-hidden">
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
          <ChatItemView key={i} item={item} />
        ))}
        {busy && (
          <div className="flex items-center gap-2 px-1 text-xs text-neutral-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
            {t('chat.thinking')}
          </div>
        )}
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
            <textarea
              rows={Math.min(8, Math.max(2, draft.split('\n').length))}
              placeholder={t('chat.placeholder')}
              value={draft}
              disabled={busy}
              onChange={(event) => setDraft(event.target.value)}
              onPaste={(event) => void addFiles(event.clipboardData?.files ?? null)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  submit()
                }
              }}
              className="max-h-56 w-full resize-none rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none disabled:opacity-60"
            />
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
    </aside>
  )
}

function ChatItemView({ item }: { item: ChatItem }): React.JSX.Element {
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
    return (
      <div className="px-1 text-sm leading-relaxed whitespace-pre-wrap text-neutral-200">
        {item.text}
      </div>
    )
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
