import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Clapperboard, Plus, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { nameMatchesQuery } from '@shared/assets/search'
import { LibraryCard } from '@renderer/components/LibraryCard'
import { useConfirm } from '@renderer/components/feedback/Feedback'
import { useShortcut } from '@renderer/components/ui/useShortcut'
import { invoke } from '@renderer/lib/ipc'
import { relativeTime } from '@renderer/lib/relativeTime'

export const Route = createFileRoute('/')({
  component: LibraryPage
})

/** Home — the project library. */
function LibraryPage(): React.JSX.Element {
  const { t } = useTranslation()
  const confirmModal = useConfirm()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [query, setQuery] = useState('')

  const projects = useQuery({
    queryKey: ['projects', 'overview'],
    queryFn: () => invoke('projects:overview')
  })
  const filteredProjects = useMemo(
    () => (projects.data ?? []).filter((p) => nameMatchesQuery(p.name, query)),
    [projects.data, query]
  )

  // ⌘N opens the new-project form (⇧⌘N is the assistant's new chat).
  useShortcut('newProject', () => setShowForm(true))

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
  }
  const create = useMutation({
    mutationFn: (value: string) => invoke('projects:create', { name: value }),
    onSuccess: (project) => {
      invalidate()
      setName('')
      setShowForm(false)
      void navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
    }
  })
  const rename = useMutation({
    mutationFn: (input: { id: string; name: string }) => invoke('projects:rename', input),
    onSuccess: invalidate
  })
  const remove = useMutation({
    mutationFn: (id: string) => invoke('projects:delete', { id }),
    onSuccess: invalidate
  })

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6 px-8 py-10">
      <div className="flex items-center justify-between">
        <h1 className="flex items-baseline gap-2.5 text-2xl font-semibold text-neutral-100">
          {t('library.title')}
          {(projects.data?.length ?? 0) > 0 && (
            <span className="text-sm font-normal text-neutral-500">{projects.data?.length}</span>
          )}
        </h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover"
        >
          <Plus className="h-4 w-4" /> {t('library.newProject')}
        </button>
      </div>

      {showForm && (
        <form
          className="island flex items-center gap-2 p-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) create.mutate(name.trim())
          }}
        >
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('library.namePlaceholder')}
            className="flex-1 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200 placeholder:text-neutral-600 focus:border-accent focus:outline-none"
          />
          <button
            type="submit"
            disabled={create.isPending || name.trim() === ''}
            className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
          >
            {t('library.create')}
          </button>
          <button
            type="button"
            onClick={() => setShowForm(false)}
            className="rounded-md px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
          >
            {t('library.cancel')}
          </button>
        </form>
      )}

      {projects.data?.length === 0 && !showForm ? (
        <div className="island flex flex-col items-center gap-3 px-8 py-16 text-center">
          <Clapperboard className="h-10 w-10 text-neutral-700" />
          <p className="text-sm font-medium text-neutral-300">{t('library.empty')}</p>
          <p className="max-w-sm text-xs text-neutral-500">{t('library.emptyHint')}</p>
          <button
            onClick={() => setShowForm(true)}
            className="mt-2 flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-sm font-medium text-neutral-900 hover:bg-accent-hover"
          >
            <Plus className="h-4 w-4" /> {t('library.newProject')}
          </button>
        </div>
      ) : (
        <>
          {(projects.data?.length ?? 0) > 0 && (
            <div className="island flex items-center gap-2 px-3 py-2">
              <Search className="h-4 w-4 flex-shrink-0 text-neutral-500" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('library.searchPlaceholder')}
                className="w-full bg-transparent text-sm text-neutral-100 placeholder:text-neutral-600 focus:outline-none"
              />
            </div>
          )}
          {filteredProjects.length === 0 && (projects.data?.length ?? 0) > 0 ? (
            <p className="text-sm italic text-neutral-500">{t('library.noMatch', { query })}</p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4">
              {filteredProjects.map((project) => (
                <LibraryCard
                  key={project.id}
                  name={project.name}
                  meta={`${t('library.videoCount', { count: project.videoCount })} · ${t('library.updated', { when: relativeTime(t, project.updatedAt) })}`}
                  thumbnailUrl={project.thumbnailUrl}
                  thumbnailKind={project.thumbnailKind}
                  placeholderIcon={Clapperboard}
                  onOpen={() =>
                    void navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
                  }
                  onRename={(value) => rename.mutate({ id: project.id, name: value })}
                  onDelete={() => {
                    void confirmModal({
                      message: t('library.deleteConfirm', { name: project.name }),
                      confirmLabel: t('library.delete'),
                      danger: true
                    }).then((accepted) => {
                      if (accepted) remove.mutate(project.id)
                    })
                  }}
                  renameTitle={t('library.rename')}
                  deleteTitle={t('library.delete')}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
