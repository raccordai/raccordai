import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  assistantModelSchema,
  DEFAULT_ASSISTANT_MODEL,
  type AssistantModel
} from '@shared/ipc/contracts'
import { invoke } from '@renderer/lib/ipc'

/** Human labels of the kie.ai market models the assistant can run on. */
export const ASSISTANT_MODEL_LABELS: Record<AssistantModel, string> = {
  'claude-opus-5': 'Claude Opus 5',
  'claude-opus-4-8': 'Claude Opus 4.8',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'gpt-5-6-sol': 'GPT 5.6 Sol',
  'gpt-5.4-codex': 'GPT Codex 5.4'
}

/** Compact badge labels (chat panel header). */
export const ASSISTANT_MODEL_SHORT: Record<AssistantModel, string> = {
  'claude-opus-5': 'Opus 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-sonnet-5': 'Sonnet 5',
  'gpt-5-6-sol': 'GPT 5.6',
  'gpt-5.4-codex': 'Codex 5.4'
}

export function AssistantModelSwitcher(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const model = useQuery({
    queryKey: ['settings', 'assistantModel'],
    queryFn: () => invoke('settings:getAssistantModel')
  })
  const set = useMutation({
    mutationFn: (m: AssistantModel) => invoke('settings:setAssistantModel', { model: m }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['settings', 'assistantModel'] })
  })

  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      {t('settings.assistantModel')}
      <select
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        value={model.data ?? DEFAULT_ASSISTANT_MODEL}
        onChange={(event) => set.mutate(assistantModelSchema.parse(event.target.value))}
      >
        {Object.entries(ASSISTANT_MODEL_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
    </label>
  )
}
