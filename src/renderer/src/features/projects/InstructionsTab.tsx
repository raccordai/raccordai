import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BookOpenText, Eye, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import type { Project } from '@shared/ipc/contracts'
import { PROJECT_INSTRUCTIONS_MAX_CHARS } from '@shared/config'
import { graphKeys } from '@renderer/features/workflow/data'
import { invoke } from '@renderer/lib/ipc'

/**
 * The project's Instructions (its "skill"): a free markdown methodology the
 * assistant reads with PRIORITY on every turn of every video of the project —
 * the one place a recurring way of working is written down instead of being
 * repeated conversation after conversation. The assistant can also maintain it
 * (set_project_instructions); its writes land here via event:workflowChanged.
 */

// Readable-size markdown mapping for the preview — deliberately NOT ChatMarkdown,
// whose chat-bubble type scale (11px code/tables) and internal-tag stripping
// don't belong in a document view.
const COMPONENTS: Components = {
  p: (props) => <p className="mb-3 leading-relaxed last:mb-0" {...props} />,
  h1: (props) => <h1 className="mb-3 mt-5 text-xl font-semibold first:mt-0" {...props} />,
  h2: (props) => <h2 className="mb-2 mt-4 text-lg font-semibold first:mt-0" {...props} />,
  h3: (props) => <h3 className="mb-2 mt-3 text-base font-semibold first:mt-0" {...props} />,
  ul: (props) => <ul className="mb-3 list-disc space-y-1 pl-5" {...props} />,
  ol: (props) => <ol className="mb-3 list-decimal space-y-1 pl-5" {...props} />,
  li: (props) => <li className="leading-relaxed" {...props} />,
  blockquote: (props) => (
    <blockquote className="mb-3 border-l-2 border-accent pl-3 text-neutral-400" {...props} />
  ),
  hr: () => <hr className="my-4 border-neutral-800" />,
  a: (props) => <a className="text-accent underline" {...props} />,
  pre: (props) => (
    <pre
      className="mb-3 overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900 p-3 text-xs"
      {...props}
    />
  ),
  code: (props) => <code className="rounded bg-neutral-900 px-1 py-0.5 text-xs" {...props} />,
  table: (props) => <table className="mb-3 w-full border-collapse text-left text-sm" {...props} />,
  th: (props) => (
    <th className="border-b border-neutral-700 px-2 py-1 font-medium text-neutral-300" {...props} />
  ),
  td: (props) => <td className="border-b border-neutral-800 px-2 py-1" {...props} />
}

interface Props {
  projectId: string
  project: Project | null
}

export function InstructionsTab({ projectId, project }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')

  // Saved on demand, synced from the server value (same contract as the niche brief).
  const [draft, setDraft] = useState('')
  useEffect(() => {
    setDraft(project?.instructions ?? '')
  }, [project?.instructions])

  const save = useMutation({
    mutationFn: (instructions: string) =>
      invoke('projects:setInstructions', {
        id: projectId,
        instructions: instructions.trim() || null
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: graphKeys.project(projectId) })
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
    }
  })

  const dirty = draft !== (project?.instructions ?? '')
  const overCap = draft.trim().length > PROJECT_INSTRUCTIONS_MAX_CHARS

  return (
    <div className="island flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5">
          <BookOpenText className="mt-0.5 h-4 w-4 shrink-0 text-neutral-500" />
          <p className="max-w-xl text-xs leading-relaxed text-neutral-400">
            {t('instructionsPage.hint')}
          </p>
        </div>
        <div className="flex shrink-0 gap-1 rounded-lg border border-neutral-800 p-0.5">
          {(['edit', 'preview'] as const).map((key) => (
            <button
              key={key}
              onClick={() => setMode(key)}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs transition-colors ${
                mode === key
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {key === 'edit' ? <Pencil className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {key === 'edit' ? t('instructionsPage.edit') : t('instructionsPage.preview')}
            </button>
          ))}
        </div>
      </div>

      {mode === 'edit' ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t('instructionsPage.placeholder')}
          rows={16}
          className="w-full resize-y rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 font-mono text-sm leading-relaxed text-neutral-200 placeholder:font-sans placeholder:text-neutral-600 focus:border-accent focus:outline-none"
        />
      ) : (
        <div className="min-h-[10rem] rounded-md border border-neutral-800 bg-neutral-900/50 px-4 py-3 text-sm text-neutral-200">
          {draft.trim() ? (
            <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
              {draft}
            </Markdown>
          ) : (
            <p className="text-neutral-600">{t('instructionsPage.placeholder')}</p>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className={`text-[11px] ${overCap ? 'text-danger' : 'text-neutral-600'}`}>
          {t('instructionsPage.charCount', {
            count: draft.trim().length,
            max: PROJECT_INSTRUCTIONS_MAX_CHARS
          })}
        </span>
        {dirty && (
          <button
            onClick={() => save.mutate(draft)}
            disabled={save.isPending || overCap}
            className="rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-neutral-900 hover:bg-accent-hover disabled:opacity-40"
          >
            {t('instructionsPage.save')}
          </button>
        )}
      </div>
    </div>
  )
}
