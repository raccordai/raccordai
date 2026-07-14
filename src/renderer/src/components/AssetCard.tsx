import { Check, Copy, Image as ImageIcon, Music, Pencil, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AssetWithUrl } from '@shared/ipc/contracts'

/**
 * Asset card (port of the studio's) — thumbnail / audio player, name,
 * portable key, tags, and the LLM-facing description with an inline edit form.
 * The description feeds the assistant and workflow-JSON asset manifests.
 */
export function AssetCard({
  asset,
  isDuplicate = false,
  onSave,
  onDelete
}: {
  asset: AssetWithUrl
  /** Another asset in the project has byte-identical content. */
  isDuplicate?: boolean
  onSave: (patch: { name: string; description: string | null; tags: string[] }) => void
  onDelete: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(asset.name)
  const [description, setDescription] = useState(asset.description ?? '')
  const [tagsDraft, setTagsDraft] = useState(asset.tags.join(', '))

  function save(e: React.FormEvent): void {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    onSave({
      name: trimmed,
      description: description.trim() === '' ? null : description.trim(),
      tags: tagsDraft
        .split(',')
        .map((tag) => tag.trim())
        .filter((tag) => tag !== '')
    })
    setEditing(false)
  }

  return (
    <div className="group island overflow-hidden">
      <div className="relative aspect-video w-full overflow-hidden bg-neutral-900">
        {asset.kind === 'audio' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-3">
            <Music className="h-5 w-5 text-highlight-soft" />
            {asset.url && <audio src={asset.url} controls preload="none" className="w-full" />}
          </div>
        ) : asset.url ? (
          asset.kind === 'video' ? (
            <video
              src={asset.url}
              muted
              preload="metadata"
              className="pointer-events-none h-full w-full object-cover"
            />
          ) : (
            <img src={asset.url} alt="" className="h-full w-full object-cover" />
          )
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="h-8 w-8 text-neutral-700" />
          </div>
        )}
        {isDuplicate && (
          <span
            className="absolute top-2 left-2 flex items-center gap-1 rounded bg-warning/20 px-1.5 py-0.5 text-[10px] font-medium text-warning"
            title={t('assetsPage.duplicateHint')}
          >
            <Copy className="h-3 w-3" /> {t('assetsPage.duplicate')}
          </span>
        )}
        <div className="absolute top-2 right-2 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            onClick={() => setEditing((v) => !v)}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-neutral-300 backdrop-blur hover:text-neutral-100"
            title={t('assetsPage.edit')}
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={() => onDelete()}
            className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 text-neutral-300 backdrop-blur hover:text-danger"
            title={t('library.delete')}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="border-t border-neutral-800 p-3">
        {!editing ? (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <div
                className="min-w-0 flex-1 truncate text-sm font-medium text-neutral-100"
                title={asset.name}
              >
                {asset.name}
              </div>
              <div className="text-[10px] tracking-wider text-neutral-500 uppercase">
                {t(`assetsPage.kinds.${asset.kind}`)}
              </div>
            </div>
            <div className="mt-0.5 font-mono text-[10px] text-accent-soft/80">
              key: <span className="text-accent-soft">{asset.key}</span>
            </div>
            {asset.tags.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {asset.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent-soft"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {asset.description ? (
              <p className="mt-1.5 text-[11px] leading-snug text-neutral-400">
                {asset.description}
              </p>
            ) : (
              <button
                onClick={() => setEditing(true)}
                className="mt-1.5 text-[11px] text-neutral-600 italic hover:text-accent"
              >
                {t('assetsPage.addDescription')}
              </button>
            )}
          </>
        ) : (
          <form onSubmit={save} className="space-y-2">
            <div>
              <label className="text-[10px] tracking-wider text-neutral-500 uppercase">
                {t('assetsPage.name')}
              </label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="mt-0.5 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-sm text-neutral-100 focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] tracking-wider text-neutral-500 uppercase">
                {t('assetsPage.description')}
              </label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('assetsPage.descriptionPlaceholder')}
                rows={2}
                className="mt-0.5 w-full resize-none rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
              />
            </div>
            <div>
              <label className="text-[10px] tracking-wider text-neutral-500 uppercase">
                {t('assetsPage.tags')}
              </label>
              <input
                value={tagsDraft}
                onChange={(e) => setTagsDraft(e.target.value)}
                placeholder={t('assetsPage.tagsPlaceholder')}
                className="mt-0.5 w-full rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
              />
            </div>
            <div className="text-[10px] text-neutral-500">
              {t('assetsPage.keyReadonly', { key: asset.key })}
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setName(asset.name)
                  setDescription(asset.description ?? '')
                  setTagsDraft(asset.tags.join(', '))
                  setEditing(false)
                }}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              >
                <X className="h-3 w-3" /> {t('assetsPage.cancel')}
              </button>
              <button
                type="submit"
                className="flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-neutral-900 hover:bg-accent-hover"
              >
                <Check className="h-3 w-3" /> {t('assetsPage.save')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
