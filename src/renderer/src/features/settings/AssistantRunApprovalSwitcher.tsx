import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { assistantRunApprovalSchema, type AssistantRunApproval } from '@shared/ipc/contracts'
import { invoke } from '@renderer/lib/ipc'

/**
 * Does the assistant need approval before spending credits? 'ask' (default)
 * gates run_node / run_batch / finalize_video / review_generation behind the
 * same approval card as the destructive tools — approving a production plan no
 * longer implies approving the spend.
 */
export function AssistantRunApprovalSwitcher(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const mode = useQuery({
    queryKey: ['settings', 'assistantRunApproval'],
    queryFn: () => invoke('settings:getAssistantRunApproval')
  })
  const set = useMutation({
    mutationFn: (m: AssistantRunApproval) =>
      invoke('settings:setAssistantRunApproval', { mode: m }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['settings', 'assistantRunApproval'] })
  })

  return (
    <label className="flex items-center gap-2 text-xs text-neutral-400">
      {t('settings.assistantRunApproval')}
      <select
        className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200"
        value={mode.data ?? 'ask'}
        onChange={(event) => set.mutate(assistantRunApprovalSchema.parse(event.target.value))}
      >
        <option value="ask">{t('settings.assistantRunApprovalAsk')}</option>
        <option value="auto">{t('settings.assistantRunApprovalAuto')}</option>
      </select>
    </label>
  )
}
