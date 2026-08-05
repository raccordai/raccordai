import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useConfirm } from '@renderer/components/feedback/Feedback'
import { AssistantModelSwitcher } from '@renderer/features/settings/AssistantModelSwitcher'
import { AssistantRunApprovalSwitcher } from '@renderer/features/settings/AssistantRunApprovalSwitcher'
import { LocaleSwitcher } from '@renderer/features/settings/LocaleSwitcher'
import { invoke } from '@renderer/lib/ipc'

export const Route = createFileRoute('/settings')({
  component: SettingsPage
})

/** All configuration in one place: language, integrations, app info. */
function SettingsPage(): React.JSX.Element {
  const { t } = useTranslation()
  const appInfo = useQuery({ queryKey: ['appInfo'], queryFn: () => invoke('app:getInfo') })

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 px-8 py-10">
      <div>
        <Link to="/" className="text-xs text-neutral-500 hover:text-neutral-300">
          ← {t('library.title')}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold text-neutral-100">{t('settings.title')}</h1>
      </div>

      <Section title={t('settings.general')}>
        <div className="flex flex-col gap-2">
          <div className="island flex items-center justify-between px-4 py-3">
            <LocaleSwitcher />
            <AssistantModelSwitcher />
          </div>
          <div className="island flex items-center justify-between px-4 py-3">
            <p className="text-xs text-neutral-500">{t('settings.assistantRunApprovalHint')}</p>
            <AssistantRunApprovalSwitcher />
          </div>
          <NotificationsToggle />
        </div>
      </Section>

      <Section title={t('integrations.title')}>
        <div className="flex flex-col gap-2">
          <ApiKeyRow
            label={t('integrations.kieKeyLabel')}
            missingText={t('integrations.kieKeyMissing')}
          />
          <NicheKeysBlock />
          <McpBlock />
        </div>
      </Section>

      <Section title={t('settings.updates')}>
        <UpdatesBlock />
      </Section>

      <Section title={t('settings.backup')}>
        <BackupBlock />
      </Section>

      <Section title={t('settings.application')}>
        <div className="island px-4 py-3">
          {appInfo.data && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
              <InfoRow label={t('home.version')} value={appInfo.data.version} />
              <InfoRow label={t('home.channel')} value={appInfo.data.channel} />
              <InfoRow label={t('home.platform')} value={appInfo.data.platform} />
              <InfoRow label={t('home.database')} value={appInfo.data.dbPath} mono />
              <InfoRow
                label={t('home.localApi')}
                value={
                  appInfo.data.localApi.running
                    ? t('home.localApiRunning', { port: appInfo.data.localApi.port })
                    : t('home.localApiStopped')
                }
              />
            </dl>
          )}
        </div>
      </Section>
    </div>
  )
}

function Section({
  title,
  children
}: {
  title: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold tracking-widest text-neutral-500 uppercase">
        {title}
      </h2>
      {children}
    </section>
  )
}

function InfoRow({
  label,
  value,
  mono = false
}: {
  label: string
  value: string
  mono?: boolean
}): React.JSX.Element {
  return (
    <>
      <dt className="text-neutral-500">{label}</dt>
      <dd className={`text-neutral-200 ${mono ? 'font-mono text-xs leading-5 break-all' : ''}`}>
        {value}
      </dd>
    </>
  )
}

/** Human-readable byte size for the export confirmation line. */
function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1_000))} kB`
}

function UpdatesBlock(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const channel = useQuery({
    queryKey: ['settings', 'updateChannel'],
    queryFn: () => invoke('settings:getUpdateChannel')
  })
  const state = useQuery({
    queryKey: ['update', 'state'],
    queryFn: () => invoke('update:getState'),
    refetchInterval: (query) =>
      query.state.data?.status === 'checking' || query.state.data?.status === 'downloading'
        ? 2000
        : false
  })
  const setChannel = useMutation({
    mutationFn: (value: 'stable' | 'beta') =>
      invoke('settings:setUpdateChannel', { channel: value }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['settings'] })
  })
  const check = useMutation({
    mutationFn: () => invoke('update:check'),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['update'] })
  })
  const install = useMutation({ mutationFn: () => invoke('update:install') })

  const status = state.data?.status ?? 'idle'
  const supported = status !== 'unsupported'

  return (
    <div className="island px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <label className="text-xs text-neutral-400" htmlFor="update-channel">
          {t('settings.updateChannel')}
        </label>
        <select
          id="update-channel"
          className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-200"
          value={channel.data ?? 'stable'}
          onChange={(event) => setChannel.mutate(event.target.value as 'stable' | 'beta')}
        >
          <option value="stable">{t('settings.channelStable')}</option>
          <option value="beta">{t('settings.channelBeta')}</option>
        </select>
      </div>
      <p className="mt-1.5 text-xs leading-relaxed text-neutral-500">{t('settings.channelHint')}</p>
      <div className="mt-2.5 flex items-center gap-3">
        {status === 'downloaded' ? (
          <button
            className="rounded-md bg-highlight px-3 py-1.5 text-sm font-medium text-neutral-900"
            onClick={() => install.mutate()}
          >
            {t('settings.updateInstall')}
          </button>
        ) : (
          <button
            disabled={!supported || check.isPending || status === 'checking'}
            className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
            onClick={() => check.mutate()}
          >
            {t('settings.updateCheck')}
          </button>
        )}
        <span className={`text-xs ${status === 'error' ? 'text-danger' : 'text-neutral-500'}`}>
          {t(`settings.updateStatus.${status}`, {
            version: state.data?.version ?? '',
            error: state.data?.error ?? ''
          })}
        </span>
      </div>
    </div>
  )
}

/** Settings → General: OS notification when a generation settles in the background. */
function NotificationsToggle(): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const enabled = useQuery({
    queryKey: ['settings', 'notifyOnCompletion'],
    queryFn: () => invoke('settings:getNotifyOnCompletion')
  })
  const setEnabled = useMutation({
    mutationFn: (value: boolean) => invoke('settings:setNotifyOnCompletion', { enabled: value }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['settings', 'notifyOnCompletion'] })
  })

  return (
    <div className="island flex items-center justify-between gap-4 px-4 py-3">
      <div>
        <div className="text-sm text-neutral-200">{t('settings.notifyOnCompletion')}</div>
        <p className="mt-0.5 text-xs leading-relaxed text-neutral-500">
          {t('settings.notifyOnCompletionHint')}
        </p>
      </div>
      <input
        type="checkbox"
        checked={enabled.data ?? true}
        onChange={(e) => setEnabled.mutate(e.target.checked)}
        className="h-4 w-4 flex-shrink-0 rounded border-neutral-600 bg-neutral-900"
      />
    </div>
  )
}

function BackupBlock(): React.JSX.Element {
  const { t } = useTranslation()
  const confirmModal = useConfirm()
  const exportBackup = useMutation({
    mutationFn: () => invoke('backup:export')
  })
  const importBackup = useMutation({
    mutationFn: () => invoke('backup:import')
  })
  const busy = exportBackup.isPending || importBackup.isPending
  const error = exportBackup.error ?? importBackup.error

  return (
    <div className="island px-4 py-3">
      <p className="text-xs leading-relaxed text-neutral-500">{t('settings.backupHint')}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          disabled={busy}
          className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
          onClick={() => exportBackup.mutate()}
        >
          {exportBackup.isPending ? t('settings.backupExporting') : t('settings.backupExport')}
        </button>
        <button
          disabled={busy}
          className="rounded-md bg-neutral-800 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-700 disabled:opacity-40"
          onClick={() => {
            void confirmModal({
              message: t('settings.backupImportConfirm'),
              confirmLabel: t('settings.backupImport'),
              danger: true
            }).then((accepted) => {
              if (accepted) importBackup.mutate()
            })
          }}
        >
          {importBackup.isPending ? t('settings.backupImporting') : t('settings.backupImport')}
        </button>
      </div>
      {exportBackup.data && (
        <p className="mt-2 font-mono text-xs break-all text-success">
          {t('settings.backupExportDone', {
            files: exportBackup.data.files,
            size: formatBytes(exportBackup.data.bytes),
            path: exportBackup.data.path
          })}
        </p>
      )}
      {importBackup.data && (
        <p className="mt-2 text-xs text-success">{t('settings.backupImportDone')}</p>
      )}
      {error && (
        <p className="mt-2 text-xs text-danger">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}
    </div>
  )
}

function McpBlock(): React.JSX.Element {
  const { t } = useTranslation()
  const info = useQuery({
    queryKey: ['settings', 'localApiInfo'],
    queryFn: () => invoke('settings:localApiInfo')
  })
  const [copied, setCopied] = useState<'url' | 'token' | null>(null)

  function copy(kind: 'url' | 'token', value: string): void {
    void navigator.clipboard.writeText(value)
    setCopied(kind)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="island px-4 py-3">
      <div className="text-xs text-neutral-400">{t('mcp.title')}</div>
      <p className="mt-1 text-xs leading-relaxed text-neutral-500">{t('mcp.hint')}</p>
      {info.data?.running && info.data.url ? (
        <div className="mt-2.5 flex flex-col gap-1.5">
          {(
            [
              ['url', t('mcp.url'), info.data.url],
              ['token', t('mcp.token'), info.data.token]
            ] as const
          ).map(([kind, label, value]) => (
            <div key={kind} className="flex items-center gap-2">
              <span className="w-12 text-[10px] tracking-wider text-neutral-500 uppercase">
                {label}
              </span>
              <code className="min-w-0 flex-1 truncate rounded bg-neutral-900 px-2 py-1 font-mono text-xs text-neutral-300">
                {kind === 'token' ? `${value.slice(0, 12)}…` : value}
              </code>
              <button
                onClick={() => copy(kind, value)}
                className="shrink-0 rounded-md bg-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-700"
              >
                {copied === kind ? t('mcp.copied') : t('mcp.copy')}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-xs text-warning">{t('mcp.stopped')}</p>
      )}
    </div>
  )
}

function ApiKeyRow({
  label,
  missingText
}: {
  label: string
  missingText: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const status = useQuery({
    queryKey: ['settings', 'settings:kieApiKeyStatus'],
    queryFn: () => invoke('settings:kieApiKeyStatus')
  })
  const [key, setKey] = useState('')
  const save = useMutation({
    mutationFn: (value: string) => invoke('settings:setKieApiKey', { key: value }),
    onSuccess: () => {
      setKey('')
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      // A fresh key makes the header balance fetchable (or changes account).
      void queryClient.invalidateQueries({ queryKey: ['kie', 'credits'] })
    }
  })

  return (
    <div className="island px-4 py-3">
      <label className="text-xs text-neutral-400">{label}</label>
      <form
        className="mt-1.5 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (key.trim()) save.mutate(key)
        }}
      >
        <input
          type="password"
          autoComplete="off"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-sm text-neutral-200 placeholder:font-sans placeholder:text-neutral-600"
          placeholder={t('integrations.kieKeyPlaceholder')}
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
        <button
          type="submit"
          disabled={save.isPending || key.trim() === ''}
          className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          {t('integrations.save')}
        </button>
        {status.data?.configured && (
          <button
            type="button"
            className="text-xs text-neutral-500 hover:text-danger"
            onClick={() => save.mutate('')}
          >
            {t('integrations.clear')}
          </button>
        )}
      </form>
      <p className={`mt-2 text-xs ${status.data?.configured ? 'text-success' : 'text-warning'}`}>
        {status.data?.configured ? t('integrations.kieKeyConfigured') : missingText}
      </p>
    </div>
  )
}

/** One niche-research secret (YouTube key, DataForSEO login/password). */
function SecretRow({
  label,
  channel,
  configured,
  missingText
}: {
  label: string
  channel:
    'settings:setYoutubeApiKey' | 'settings:setDataForSeoLogin' | 'settings:setDataForSeoPassword'
  configured: boolean
  missingText: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [value, setValue] = useState('')
  const save = useMutation({
    mutationFn: (secret: string) =>
      channel === 'settings:setYoutubeApiKey'
        ? invoke(channel, { key: secret })
        : invoke(channel, { value: secret }),
    onSuccess: () => {
      setValue('')
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
    }
  })

  return (
    <div className="island px-4 py-3">
      <label className="text-xs text-neutral-400">{label}</label>
      <form
        className="mt-1.5 flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (value.trim()) save.mutate(value)
        }}
      >
        <input
          type="password"
          autoComplete="off"
          className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 font-mono text-sm text-neutral-200 placeholder:font-sans placeholder:text-neutral-600"
          placeholder={t('integrations.secretPlaceholder')}
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <button
          type="submit"
          disabled={save.isPending || value.trim() === ''}
          className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 disabled:opacity-40"
        >
          {t('integrations.save')}
        </button>
        {configured && (
          <button
            type="button"
            className="text-xs text-neutral-500 hover:text-danger"
            onClick={() => save.mutate('')}
          >
            {t('integrations.clear')}
          </button>
        )}
      </form>
      <p className={`mt-2 text-xs ${configured ? 'text-success' : 'text-warning'}`}>
        {configured ? t('integrations.secretConfigured') : missingText}
      </p>
    </div>
  )
}

/** YouTube niche research credentials (§7) — same safeStorage vault as the kie key. */
function NicheKeysBlock(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useQuery({
    queryKey: ['settings', 'settings:nicheKeysStatus'],
    queryFn: () => invoke('settings:nicheKeysStatus')
  })
  return (
    <>
      <SecretRow
        label={t('integrations.youtubeKeyLabel')}
        channel="settings:setYoutubeApiKey"
        configured={status.data?.youtubeConfigured ?? false}
        missingText={t('integrations.youtubeKeyMissing')}
      />
      <SecretRow
        label={t('integrations.dataForSeoLoginLabel')}
        channel="settings:setDataForSeoLogin"
        configured={status.data?.dataForSeoConfigured ?? false}
        missingText={t('integrations.dataForSeoMissing')}
      />
      <SecretRow
        label={t('integrations.dataForSeoPasswordLabel')}
        channel="settings:setDataForSeoPassword"
        configured={status.data?.dataForSeoConfigured ?? false}
        missingText={t('integrations.dataForSeoMissing')}
      />
    </>
  )
}
