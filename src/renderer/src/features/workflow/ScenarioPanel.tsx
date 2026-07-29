import { useState } from 'react'
import { AlertTriangle, ArrowRight, Clapperboard, Loader2, Workflow, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ScenarioGraphPlan } from '@shared/ipc/contracts'
import { formatSeconds } from '@renderer/lib/formatSeconds'
import { graphKeys, useInvalidateWorkflow, useIpcMutation, useVideo } from './data'

/**
 * Scenario (§6.7) — the shot list, and the button that realizes it (§6.11).
 *
 * It is written by the assistant (`write_scenario`) from the user's brief, with
 * the durations already made legal for the target model and every shot chained
 * to the next by its opening/closing frame. Shown here so the user can review
 * the film BEFORE any node exists, and come back to it later: the scenario is
 * stored on the video, not in the conversation.
 *
 * Building the graph is deliberately a two-step gesture: the plan is free and
 * says which preset each shot lands on and why, so the user arbitrates the
 * camera choices BEFORE a single node exists. The build itself is one undo step.
 *
 * Editing the shot list still goes through the assistant — one author keeps the
 * shot list, the durations and the graph consistent.
 */
export function ScenarioPanel({ videoId, onClose }: { videoId: string; onClose: () => void }) {
  const { t } = useTranslation()
  const scenario = useVideo(videoId).data?.scenario ?? null
  const [plan, setPlan] = useState<ScenarioGraphPlan | null>(null)
  const invalidate = useInvalidateWorkflow(videoId)

  const planGraph = useIpcMutation('scenario:planGraph')
  const buildGraph = useIpcMutation('scenario:buildGraph', [graphKeys.graph(videoId)])
  const busy = planGraph.isPending || buildGraph.isPending
  const error = planGraph.error ?? buildGraph.error

  return (
    <aside className="island flex w-96 flex-col overflow-hidden px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-neutral-100">
          <Clapperboard className="h-4 w-4 text-accent" /> {t('editor.scenario.title')}
        </h2>
        <button
          onClick={onClose}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {scenario === null ? (
        <p className="text-xs leading-relaxed text-neutral-500 italic">
          {t('editor.scenario.empty')}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <p className="rounded-md border border-neutral-800 bg-neutral-900/40 px-2 py-1.5 text-[11px] leading-relaxed text-neutral-300">
            {scenario.brief}
          </p>

          <div className="mt-2 flex items-baseline gap-2 text-[10px] text-neutral-500">
            <span className="font-mono text-neutral-300">
              {t('editor.scenario.shotCount', { count: scenario.shots.length })}
            </span>
            <span className="font-mono text-neutral-300">
              {formatSeconds(scenario.totalSeconds)}
            </span>
            {scenario.targetSeconds !== undefined &&
              scenario.targetSeconds !== scenario.totalSeconds && (
                <span className="text-warning">
                  {t('editor.scenario.target', {
                    target: formatSeconds(scenario.targetSeconds)
                  })}
                </span>
              )}
            <span className="ml-auto truncate font-mono">{scenario.modelId}</span>
          </div>

          {scenario.warnings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {scenario.warnings.map((warning, i) => (
                <li
                  key={i}
                  className="flex gap-1.5 rounded-md border border-warning/40 bg-warning/5 p-2 text-[10px] leading-relaxed text-warning"
                >
                  <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
                  <span>{warning}</span>
                </li>
              ))}
            </ul>
          )}

          <ol className="mt-2 space-y-1.5">
            {scenario.shots.map((shot) => (
              <li
                key={shot.key}
                className="rounded-md border border-neutral-800 bg-neutral-900/40 px-2 py-1.5"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-neutral-100">
                    {shot.title}
                  </span>
                  <span className="flex-shrink-0 font-mono text-[10px] text-neutral-400">
                    {formatSeconds(shot.seconds)}
                    {shot.requestedSeconds !== shot.seconds && (
                      <span className="text-neutral-600">
                        {' '}
                        (
                        {t('editor.scenario.asked', {
                          seconds: formatSeconds(shot.requestedSeconds)
                        })}
                        )
                      </span>
                    )}
                  </span>
                </div>
                <p className="mt-0.5 text-[10px] leading-snug text-neutral-400">{shot.action}</p>
                {shot.camera && (
                  <p className="mt-0.5 text-[10px] leading-snug text-neutral-500">{shot.camera}</p>
                )}
                {/* The transition contract: what the shot opens and closes on is
                    what makes it read as part of the same sequence. */}
                <div className="mt-1 space-y-0.5 border-t border-neutral-800/80 pt-1 text-[9px] leading-snug text-neutral-500">
                  <div className="flex gap-1">
                    <ArrowRight className="mt-px h-2.5 w-2.5 flex-shrink-0 text-accent-soft" />
                    <span>{shot.opensOn}</span>
                  </div>
                  {shot.closesOn && (
                    <div className="flex gap-1">
                      <ArrowRight className="mt-px h-2.5 w-2.5 flex-shrink-0 rotate-90 text-accent-soft" />
                      <span>{shot.closesOn}</span>
                    </div>
                  )}
                </div>
                {shot.mergedFrom && (
                  <div className="mt-1 text-[9px] text-neutral-600">
                    {t('editor.scenario.mergedFrom', { beats: shot.mergedFrom.join(', ') })}
                  </div>
                )}
              </li>
            ))}
          </ol>

          <p className="mt-2 text-[10px] leading-relaxed text-neutral-600 italic">
            {t('editor.scenario.editHint')}
          </p>
        </div>
      )}

      {scenario !== null && (
        <div className="mt-2 flex-shrink-0 border-t border-neutral-800 pt-2">
          {plan === null ? (
            <>
              <button
                onClick={() =>
                  planGraph.mutate({ videoId }, { onSuccess: (result) => setPlan(result) })
                }
                disabled={busy}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-highlight px-2 py-1.5 text-xs font-medium text-neutral-900 hover:brightness-105 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Workflow className="h-3.5 w-3.5" />
                )}
                {t('editor.scenario.build')}
              </button>
              <p className="mt-1 text-[9px] leading-snug text-neutral-600">
                {t('editor.scenario.buildHint')}
              </p>
            </>
          ) : (
            <div className="max-h-64 overflow-y-auto">
              {plan.build.length === 0 ? (
                <p className="text-[10px] leading-relaxed text-neutral-500 italic">
                  {t('editor.scenario.nothingToBuild')}
                </p>
              ) : (
                <ol className="space-y-1">
                  {plan.build.map((entry) => (
                    <li key={entry.key} className="text-[10px] leading-snug">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 flex-1 truncate text-neutral-300">
                          {entry.title}
                        </span>
                        <span className="flex-shrink-0 font-mono text-[9px] text-accent">
                          {t(`designs.${entry.recipeId}.name` as never)}
                        </span>
                      </div>
                      {/* Why this preset — the user arbitrates the camera, not the wiring. */}
                      <div className="text-[9px] text-neutral-600">
                        {formatSeconds(entry.seconds)} · {entry.reason}
                        {entry.roles.length > 0 &&
                          ` · ${entry.roles.map((r) => r.name).join(', ')}`}
                      </div>
                      {entry.notes.map((note) => (
                        <div key={note} className="text-[9px] text-warning">
                          {note}
                        </div>
                      ))}
                    </li>
                  ))}
                </ol>
              )}

              {plan.alreadyBuilt.length > 0 && (
                <p className="mt-1.5 text-[9px] text-neutral-600">
                  {t('editor.scenario.alreadyBuilt', { count: plan.alreadyBuilt.length })}
                </p>
              )}
              {plan.unknownRoles.length > 0 && (
                <p className="mt-1.5 text-[9px] text-warning">
                  {t('editor.scenario.unknownRoles', { roles: plan.unknownRoles.join(', ') })}
                </p>
              )}
              {plan.skipped.map((entry) => (
                <p key={entry.key} className="mt-1.5 text-[9px] text-warning">
                  {entry.title} — {entry.reason}
                </p>
              ))}

              <div className="mt-2 flex gap-1.5">
                <button
                  onClick={() => setPlan(null)}
                  disabled={busy}
                  className="rounded-md border border-neutral-700 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() =>
                    buildGraph.mutate(
                      { videoId },
                      {
                        onSuccess: () => {
                          setPlan(null)
                          invalidate()
                        }
                      }
                    )
                  }
                  disabled={busy || plan.build.length === 0}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-md bg-highlight px-2 py-1 text-[11px] font-medium text-neutral-900 hover:brightness-105 disabled:opacity-50"
                >
                  {busy && <Loader2 className="h-3 w-3 animate-spin" />}
                  {t('editor.scenario.confirmBuild', { count: plan.build.length })}
                </button>
              </div>
            </div>
          )}

          {error && <p className="mt-1.5 text-[10px] text-danger">{error.message}</p>}
        </div>
      )}
    </aside>
  )
}
