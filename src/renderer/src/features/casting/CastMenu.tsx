import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Check, Loader2, UserSquare2 } from 'lucide-react'
import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@renderer/components/ui/Button'
import { useDismissable } from '@renderer/components/ui/useDismissable'
import { useToast } from '@renderer/components/feedback/Feedback'
import { graphKeys } from '@renderer/features/workflow/data'
import { invoke } from '@renderer/lib/ipc'

/**
 * "Cast a role on every shot" — the editor's half of §6.10.
 *
 * Two steps on purpose. Picking a role shows the PLAN (which shots would be
 * wired, which already carry it, which are skipped and why) and nothing has
 * moved yet; confirming applies it as one undo step. The dry run is free — it
 * is the same pure planner the apply path uses — so there is no reason to make
 * the user discover the skips after the fact.
 */
export function CastMenu({
  videoId,
  projectId
}: {
  videoId: string
  projectId: string
}): React.JSX.Element {
  const { t } = useTranslation()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [applying, setApplying] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setSelected(null)
  }, [])
  useDismissable(open, close, rootRef)

  const castings = useQuery({
    queryKey: ['casting', 'project', projectId],
    queryFn: () => invoke('casting:listByProject', { projectId })
  })
  const plan = useQuery({
    queryKey: ['casting', 'plan', videoId, selected],
    queryFn: () => invoke('casting:plan', { videoId, castingId: selected! }),
    enabled: selected !== null
  })

  const roles = castings.data ?? []
  const role = roles.find((r) => r.id === selected) ?? null

  async function apply(): Promise<void> {
    if (!role) return
    setApplying(true)
    try {
      const result = await invoke('casting:apply', { videoId, castingId: role.id })
      toast.success(t('castingPage.castDone', { name: result.name, count: result.cast.length }))
      void queryClient.invalidateQueries({ queryKey: graphKeys.graph(videoId) })
      void queryClient.invalidateQueries({ queryKey: ['history'] })
      void queryClient.invalidateQueries({ queryKey: ['casting'] })
      close()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setApplying(false)
    }
  }

  return (
    <div className="relative" ref={rootRef}>
      <Button variant="secondary" size="sm" onClick={() => setOpen((v) => !v)}>
        <UserSquare2 className="h-3.5 w-3.5" /> {t('assetsPage.tabCasting')}
      </Button>
      {open && (
        <div className="absolute left-0 z-20 mt-1 w-80 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 shadow-xl">
          {roles.length === 0 ? (
            <div className="px-3 py-3">
              <p className="text-sm text-neutral-300">{t('castingPage.noRoles')}</p>
              <p className="mt-1 text-[11px] leading-snug text-neutral-500">
                {t('castingPage.noRolesHint')}
              </p>
            </div>
          ) : role === null ? (
            <ul className="max-h-72 overflow-y-auto py-1">
              {roles.map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => setSelected(r.id)}
                    className="flex w-full flex-col gap-0.5 px-3 py-2 text-left hover:bg-neutral-800"
                  >
                    <span className="truncate text-sm text-neutral-100">{r.name}</span>
                    <span className="truncate text-[11px] text-neutral-500">
                      {r.designId ? t(`designs.${r.designId}.name` as never) : r.assetName}
                      {r.designSubject ? ` — ${r.designSubject}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex flex-col gap-2 p-3">
              <div className="text-sm font-medium text-neutral-100">
                {t('castingPage.castTitle', { name: role.name })}
              </div>
              {plan.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin text-neutral-500" />
              ) : plan.data ? (
                <div className="flex flex-col gap-1.5 text-[11px] leading-snug">
                  {plan.data.cast.length === 0 && plan.data.alreadyCast.length > 0 && (
                    <p className="text-neutral-400">{t('castingPage.castNothing')}</p>
                  )}
                  {plan.data.cast.length > 0 && (
                    <p className="text-neutral-200">
                      {t('castingPage.castWillWire', { count: plan.data.cast.length })}
                    </p>
                  )}
                  {plan.data.alreadyCast.length > 0 && plan.data.cast.length > 0 && (
                    <p className="text-neutral-500">
                      {t('castingPage.castAlready', { count: plan.data.alreadyCast.length })}
                    </p>
                  )}
                  {plan.data.skipped.length > 0 && (
                    <div className="rounded border border-warning/40 bg-warning/10 p-2 text-neutral-300">
                      <p className="flex items-center gap-1 font-medium">
                        <AlertTriangle className="h-3 w-3" />
                        {t('castingPage.castSkipped', { count: plan.data.skipped.length })}
                      </p>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {plan.data.skipped.map((s) => (
                          <li key={s.nodeId}>{s.reason}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              ) : null}
              <div className="mt-1 flex justify-end gap-2">
                <button
                  onClick={close}
                  className="rounded-md px-2.5 py-1.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                >
                  {t('library.cancel')}
                </button>
                <button
                  onClick={() => void apply()}
                  disabled={applying || (plan.data?.cast.length ?? 0) === 0}
                  className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
                >
                  {applying ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Check className="h-3 w-3" />
                  )}
                  {t('castingPage.castConfirm')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
