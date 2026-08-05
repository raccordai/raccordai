import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Mic, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { VoicePersona } from '@shared/ipc/contracts'
import { useConfirm, useToast } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'

/**
 * Voice personas (§8): the channel's named voices — "Narrateur IS this
 * ElevenLabs voice id". Shown on the niche page because that is where the
 * channel identity lives; a persona created here is pinned to the niche
 * (unpinned personas remain visible everywhere). The speech nodes' voice
 * pickers and the assistant read the same list.
 */
export function VoicePersonasSection({ nicheId }: { nicheId: string }): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const confirmModal = useConfirm()
  const queryClient = useQueryClient()

  const personas = useQuery({
    queryKey: ['voicePersonas', nicheId],
    queryFn: () => invoke('voicePersonas:list', { nicheId })
  })
  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['voicePersonas'] })
  }

  const [name, setName] = useState('')
  const [voiceId, setVoiceId] = useState('')
  const [description, setDescription] = useState('')
  const create = useMutation({
    mutationFn: () =>
      invoke('voicePersonas:create', {
        name: name.trim(),
        voiceId: voiceId.trim(),
        description: description.trim() || null,
        nicheId
      }),
    onSuccess: () => {
      setName('')
      setVoiceId('')
      setDescription('')
      invalidate()
    },
    onError: (err) => toast.error(err.message)
  })
  const update = useMutation({
    mutationFn: (input: { personaId: string; voiceId?: string; description?: string | null }) =>
      invoke('voicePersonas:update', input),
    onSuccess: invalidate,
    onError: (err) => toast.error(err.message)
  })
  const remove = useMutation({
    mutationFn: (personaId: string) => invoke('voicePersonas:remove', { personaId }),
    onSuccess: invalidate
  })

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-neutral-300">
        <Mic className="h-4 w-4 text-accent-soft" />
        {t('niches.voices.title')}
        <span className="text-xs font-normal text-neutral-500">{t('niches.voices.hint')}</span>
      </h2>

      {(personas.data?.length ?? 0) > 0 && (
        <ul className="flex flex-col gap-2">
          {personas.data?.map((persona: VoicePersona) => (
            <li key={persona.id} className="island flex flex-wrap items-center gap-2 p-3">
              <span className="min-w-24 text-sm font-medium text-neutral-100">{persona.name}</span>
              <input
                defaultValue={persona.voiceId}
                key={`voice-${persona.id}-${persona.voiceId}`}
                title={t('niches.voices.voiceIdLabel')}
                onBlur={(e) => {
                  const next = e.target.value.trim()
                  if (next && next !== persona.voiceId)
                    update.mutate({ personaId: persona.id, voiceId: next })
                }}
                className="w-64 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-300"
              />
              <input
                defaultValue={persona.description ?? ''}
                key={`desc-${persona.id}-${persona.description ?? ''}`}
                placeholder={t('niches.voices.descriptionPlaceholder')}
                onBlur={(e) => {
                  const next = e.target.value.trim() || null
                  if (next !== persona.description)
                    update.mutate({ personaId: persona.id, description: next })
                }}
                className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300 placeholder:text-neutral-600"
              />
              {persona.nicheId === null && (
                <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                  {t('niches.voices.global')}
                </span>
              )}
              <button
                title={t('niches.voices.delete')}
                onClick={() => {
                  void confirmModal({
                    message: t('niches.voices.deleteConfirm', { name: persona.name }),
                    confirmLabel: t('niches.voices.delete'),
                    danger: true
                  }).then((accepted) => {
                    if (accepted) remove.mutate(persona.id)
                  })
                }}
                className="text-neutral-600 hover:text-danger"
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="island flex flex-wrap items-center gap-2 p-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim() && voiceId.trim()) create.mutate()
        }}
      >
        <Plus className="h-4 w-4 shrink-0 text-neutral-500" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('niches.voices.namePlaceholder')}
          className="w-40 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600"
        />
        <input
          value={voiceId}
          onChange={(e) => setVoiceId(e.target.value)}
          placeholder={t('niches.voices.voiceIdPlaceholder')}
          className="w-64 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 font-mono text-xs text-neutral-100 placeholder:font-sans placeholder:text-neutral-600"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('niches.voices.descriptionPlaceholder')}
          className="min-w-0 flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600"
        />
        <button
          type="submit"
          disabled={create.isPending || name.trim() === '' || voiceId.trim() === ''}
          className="flex items-center gap-1.5 rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
        >
          {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('niches.voices.add')}
        </button>
      </form>
    </section>
  )
}
