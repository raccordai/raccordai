import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Pencil, Plus, Trash2, UserSquare2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssetWithUrl, Casting } from '@shared/ipc/contracts'
import { useConfirm } from '@renderer/components/feedback/Feedback'
import { invoke } from '@renderer/lib/ipc'

/**
 * The project's CAST (§6.10) — the film's named identities.
 *
 * The library answers "what sheets do I have"; this tab answers "who is in this
 * film". A role is a name pointed at one published sheet, and the reason it is
 * worth a table of its own is that the name is what every later prompt carries:
 * re-pointing "Léa" at a regenerated sheet is one edit here instead of a hunt
 * through the shots that referenced the old one.
 *
 * Casting a role ONTO shots is the editor's gesture, not this one — it is a
 * graph mutation, and it belongs where the graph is.
 */

interface Props {
  projectId: string
  assets: AssetWithUrl[]
}

export function CastingTab({ projectId, assets }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const confirmModal = useConfirm()
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)

  const castings = useQuery({
    queryKey: ['casting', 'project', projectId],
    queryFn: () => invoke('casting:listByProject', { projectId })
  })

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['casting'] })
  }

  const create = useMutation({
    mutationFn: (input: { name: string; assetId: string; notes: string | null }) =>
      invoke('casting:create', { projectId, ...input }),
    onSuccess: () => {
      setAdding(false)
      invalidate()
    }
  })
  const update = useMutation({
    mutationFn: (input: {
      castingId: string
      name: string
      assetId: string
      notes: string | null
    }) => invoke('casting:update', input),
    onSuccess: () => {
      setEditingId(null)
      invalidate()
    }
  })
  const remove = useMutation({
    mutationFn: (castingId: string) => invoke('casting:remove', { castingId }),
    onSuccess: invalidate
  })

  // Only published design sheets can be cast: a role is an identity, and a
  // plain media file carries none of the markers the role sentence reads.
  const sheets = useMemo(
    () => assets.filter((a) => a.kind === 'image' && a.designId !== null),
    [assets]
  )
  const assetById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets])
  const rows = castings.data ?? []

  if (sheets.length === 0 && rows.length === 0) {
    return (
      <div className="island flex flex-col items-center gap-3 px-8 py-16 text-center">
        <UserSquare2 className="h-10 w-10 text-neutral-700" />
        <p className="text-sm font-medium text-neutral-300">{t('castingPage.empty')}</p>
        <p className="max-w-sm text-xs text-neutral-500">{t('castingPage.emptyHint')}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-xs leading-relaxed text-neutral-500">
          {t('castingPage.intro')}
        </p>
        {!adding && (
          <button
            onClick={() => setAdding(true)}
            disabled={sheets.length === 0}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
          >
            <Plus className="h-4 w-4" /> {t('castingPage.newRole')}
          </button>
        )}
      </div>

      {adding && (
        <RoleForm
          sheets={sheets}
          pending={create.isPending}
          error={create.error instanceof Error ? create.error.message : null}
          onCancel={() => setAdding(false)}
          onSubmit={(values) => create.mutate(values)}
        />
      )}

      {rows.length === 0 ? (
        <p className="text-sm italic text-neutral-500">{t('castingPage.none')}</p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-3">
          {rows.map((casting) =>
            editingId === casting.id ? (
              <RoleForm
                key={casting.id}
                sheets={sheets}
                initial={casting}
                pending={update.isPending}
                error={update.error instanceof Error ? update.error.message : null}
                onCancel={() => setEditingId(null)}
                onSubmit={(values) => update.mutate({ castingId: casting.id, ...values })}
              />
            ) : (
              <RoleCard
                key={casting.id}
                casting={casting}
                url={assetById.get(casting.assetId)?.url ?? null}
                onEdit={() => setEditingId(casting.id)}
                onDelete={() => {
                  void (async () => {
                    const accepted = await confirmModal({
                      message: t('castingPage.deleteConfirm', { name: casting.name }),
                      confirmLabel: t('library.delete'),
                      danger: true
                    })
                    if (accepted) remove.mutate(casting.id)
                  })()
                }}
              />
            )
          )}
        </div>
      )}
    </div>
  )
}

function RoleCard({
  casting,
  url,
  onEdit,
  onDelete
}: {
  casting: Casting
  url: string | null
  onEdit: () => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className="island group flex gap-3 p-3">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-16 w-16 flex-shrink-0 rounded object-cover"
        />
      ) : (
        <span className="flex h-16 w-16 flex-shrink-0 items-center justify-center rounded bg-neutral-800">
          <UserSquare2 className="h-5 w-5 text-neutral-600" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <span className="truncate text-sm font-medium text-neutral-100">{casting.name}</span>
          <span className="flex flex-shrink-0 gap-0.5 opacity-0 transition group-hover:opacity-100">
            <button
              onClick={onEdit}
              className="rounded p-1 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300"
              title={t('library.rename')}
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={onDelete}
              className="rounded p-1 text-neutral-600 hover:bg-neutral-800 hover:text-danger"
              title={t('library.delete')}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
        <div className="truncate text-[11px] text-neutral-500">
          {casting.designId ? t(`designs.${casting.designId}.name` as never) : casting.assetName}
          {casting.designSubject ? ` — ${casting.designSubject}` : ''}
        </div>
        {casting.notes && (
          <div className="mt-1 line-clamp-2 text-[11px] italic leading-snug text-neutral-400">
            {casting.notes}
          </div>
        )}
      </div>
    </div>
  )
}

function RoleForm({
  sheets,
  initial,
  pending,
  error,
  onCancel,
  onSubmit
}: {
  sheets: AssetWithUrl[]
  initial?: Casting
  pending: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (values: { name: string; assetId: string; notes: string | null }) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? '')
  const [assetId, setAssetId] = useState(initial?.assetId ?? sheets[0]?.id ?? '')
  const [notes, setNotes] = useState(initial?.notes ?? '')

  const submit = (): void => {
    if (name.trim() === '' || assetId === '') return
    onSubmit({ name: name.trim(), assetId, notes: notes.trim() === '' ? null : notes.trim() })
  }

  return (
    <form
      className="island flex flex-col gap-2 p-3"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('castingPage.namePlaceholder')}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
      />
      <select
        value={assetId}
        onChange={(e) => setAssetId(e.target.value)}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 focus:border-accent focus:outline-none"
      >
        {sheets.map((sheet) => (
          <option key={sheet.id} value={sheet.id}>
            {sheet.name}
            {sheet.designSubject ? ` — ${sheet.designSubject}` : ''}
          </option>
        ))}
      </select>
      <input
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={t('castingPage.notesPlaceholder')}
        className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
      />
      {error && <p className="text-[11px] text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex items-center gap-1 rounded-md px-3 py-1.5 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
        >
          <X className="h-3.5 w-3.5" /> {t('library.cancel')}
        </button>
        <button
          type="submit"
          disabled={pending || name.trim() === '' || assetId === ''}
          className="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" /> {t('library.save')}
        </button>
      </div>
    </form>
  )
}
