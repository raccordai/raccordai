import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { fillTemplateSlots, getWorkflowTemplate } from '@shared/templates/registry'
import { Logo } from '@renderer/components/Logo'
import { LocaleSwitcher } from '@renderer/features/settings/LocaleSwitcher'
import { invoke } from '@renderer/lib/ipc'

/** The example project is seeded from this blueprint, slots filled with its examples. */
const STARTER_TEMPLATE_ID = 'product-commercial'

type KeyTestStatus = 'ok' | 'unauthorized' | 'network' | 'missing'

/**
 * First-run onboarding (§roadmap 4.1): three floating-island steps — language,
 * kie.ai key with live validation, starter project. Skippable at every step;
 * completing or skipping persists `onboardingCompleted` so it never reappears
 * (existing users are back-filled at startup in the main process).
 */
export function FirstRunOverlay(): React.JSX.Element | null {
  const completed = useQuery({
    queryKey: ['settings', 'onboardingCompleted'],
    queryFn: () => invoke('settings:getOnboardingCompleted')
  })
  if (completed.data !== false) return null
  return <OnboardingDialog />
}

function OnboardingDialog(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [step, setStep] = useState(0)

  const complete = useMutation({
    mutationFn: () => invoke('settings:setOnboardingCompleted'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings'] })
  })

  const [key, setKey] = useState('')
  const [testStatus, setTestStatus] = useState<KeyTestStatus | null>(null)
  const saveAndTest = useMutation({
    mutationFn: async (value: string) => {
      await invoke('settings:setKieApiKey', { key: value })
      return (await invoke('settings:testKieApiKey')).status
    },
    onSuccess: (status) => {
      setTestStatus(status)
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      void queryClient.invalidateQueries({ queryKey: ['kie', 'credits'] })
    }
  })

  const createStarter = useMutation({
    mutationFn: async () => {
      const template = getWorkflowTemplate(STARTER_TEMPLATE_ID)!
      const project = await invoke('projects:create', { name: t('onboarding.starterProjectName') })
      const video = await invoke('videos:create', {
        projectId: project.id,
        name: t('onboarding.starterVideoName')
      })
      const examples = Object.fromEntries(template.slots.map((s) => [s.token, s.example]))
      await invoke('workflow:import', {
        videoId: video.id,
        json: JSON.stringify(fillTemplateSlots(template.workflow, examples)),
        replace: false
      })
      await invoke('videos:setStyle', { videoId: video.id, styleId: template.styleId })
      await invoke('settings:setOnboardingCompleted')
      return { projectId: project.id, videoId: video.id }
    },
    onSuccess: ({ projectId, videoId }) => {
      void queryClient.invalidateQueries()
      void navigate({
        to: '/projects/$projectId/videos/$videoId',
        params: { projectId, videoId }
      })
    }
  })

  const busy = complete.isPending || createStarter.isPending
  const statusTone: Record<KeyTestStatus, string> = {
    ok: 'text-success',
    unauthorized: 'text-danger',
    network: 'text-warning',
    missing: 'text-neutral-500'
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/80 p-6">
      <div className="island flex w-full max-w-lg flex-col gap-5 p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === step ? 'w-6 bg-highlight' : 'w-1.5 bg-neutral-700'
                }`}
              />
            ))}
          </div>
          <button
            onClick={() => complete.mutate()}
            disabled={busy}
            className="text-xs text-neutral-500 hover:text-neutral-300 disabled:opacity-40"
          >
            {t('onboarding.skip')}
          </button>
        </div>

        {step === 0 && (
          <>
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <Logo className="h-14 w-14" />
              <h1 className="text-xl font-semibold text-neutral-100">
                {t('onboarding.welcomeTitle')}
              </h1>
              <p className="max-w-md text-sm leading-relaxed text-neutral-400">
                {t('onboarding.welcomeText')}
              </p>
            </div>
            <div className="flex items-center justify-center">
              <LocaleSwitcher />
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <div>
              <h1 className="text-lg font-semibold text-neutral-100">{t('onboarding.keyTitle')}</h1>
              <p className="mt-1.5 text-sm leading-relaxed text-neutral-400">
                {t('onboarding.keyExplain')}{' '}
                <a
                  href="https://kie.ai"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline hover:text-accent-hover"
                >
                  kie.ai
                </a>
                .
              </p>
            </div>
            <form
              className="flex gap-2"
              onSubmit={(event) => {
                event.preventDefault()
                if (key.trim()) saveAndTest.mutate(key)
              }}
            >
              <input
                type="password"
                autoComplete="off"
                autoFocus
                className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm text-neutral-200 placeholder:font-sans placeholder:text-neutral-600 focus:border-accent focus:outline-none"
                placeholder={t('integrations.kieKeyPlaceholder')}
                value={key}
                onChange={(event) => {
                  setKey(event.target.value)
                  setTestStatus(null)
                }}
              />
              <button
                type="submit"
                disabled={saveAndTest.isPending || key.trim() === ''}
                className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
              >
                {saveAndTest.isPending ? t('onboarding.keyTesting') : t('onboarding.keyTest')}
              </button>
            </form>
            {testStatus && (
              <p className={`text-xs ${statusTone[testStatus]}`}>
                {t(`onboarding.keyStatus.${testStatus}`)}
              </p>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h1 className="text-lg font-semibold text-neutral-100">
              {t('onboarding.starterTitle')}
            </h1>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => createStarter.mutate()}
                disabled={busy}
                className="rounded-md border border-accent bg-neutral-800/60 px-4 py-3 text-left transition-colors hover:bg-neutral-800 disabled:opacity-40"
              >
                <div className="text-sm font-medium text-neutral-100">
                  {createStarter.isPending
                    ? t('onboarding.starterCreating')
                    : t('onboarding.starterCreate')}
                </div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {t('onboarding.starterCreateDesc')}
                </div>
              </button>
              <button
                onClick={() => complete.mutate()}
                disabled={busy}
                className="rounded-md border border-neutral-800 px-4 py-3 text-left transition-colors hover:border-neutral-700 disabled:opacity-40"
              >
                <div className="text-sm text-neutral-200">{t('onboarding.starterEmpty')}</div>
                <div className="mt-0.5 text-xs text-neutral-500">
                  {t('onboarding.starterEmptyDesc')}
                </div>
              </button>
            </div>
          </>
        )}

        <div className="flex items-center justify-between">
          {step > 0 ? (
            <button
              onClick={() => setStep(step - 1)}
              disabled={busy}
              className="rounded-md px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
            >
              {t('onboarding.back')}
            </button>
          ) : (
            <span />
          )}
          {step < 2 && (
            <button
              onClick={() => setStep(step + 1)}
              className="rounded-md bg-highlight px-4 py-2 text-sm font-medium text-neutral-900 hover:bg-highlight-hover"
            >
              {t('onboarding.next')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
