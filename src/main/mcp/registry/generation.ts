import { MAX_VARIANTS } from '@shared/config'
import {
  addAnnotation,
  createEditNodeFromAnnotations,
  deleteAnnotation,
  listAnnotations
} from '../../services/annotations'
import {
  createCheckpoint,
  deleteCheckpoint,
  diffAgainstCurrent,
  listCheckpoints,
  restoreCheckpoint
} from '../../services/checkpoints'
import * as generations from '../../services/generations'
import { waitForGenerations } from '../../services/generationWait'
import * as graph from '../../services/graph'
import { lintNodeById } from '../../services/lint'
import { generationMediaPreview } from '../../services/mediaPreview'
import { reviewClipGeneration, reviewGeneration } from '../../services/qc'
import { finalizeVideo, planFinalize, startBatch, videoNodeTargets } from '../../services/runBatch'
import {
  cancelGeneration,
  dequeueGeneration,
  previewRunPayload,
  queueState,
  refreshStatus,
  runNode
} from '../../services/runEngine'
import { clampVariants } from '../../services/runPlanner'
import { obj, str, type AgentTool } from './types'

/** Running nodes, the queue, QC, checkpoints (§6.4) and annotations (§6.3). */
export const generationTools: AgentTool[] = [
  // ── §6.4 checkpoints ───────────────────────────────────────────────────────
  {
    name: 'create_checkpoint',
    description:
      'Capture the video’s graph under a name (nodes, edges, params and the selected output per node) so a risky change can be walked back. Free.',
    inputSchema: obj({ videoId: str(), name: str('Short name, e.g. "before restructuring"') }, [
      'videoId',
      'name'
    ]),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, name }) => createCheckpoint(String(videoId), String(name))
  },
  {
    name: 'list_checkpoints',
    description: 'List the video’s checkpoints (newest first): id, name, node count, date.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => listCheckpoints(String(videoId))
  },
  {
    name: 'diff_checkpoint',
    description:
      'What restoring a checkpoint would change: nodes added/removed, params (prompt first) and labels changed, edges added/removed, selected outputs changed. Free — read this before proposing a restore.',
    inputSchema: obj({ checkpointId: str() }, ['checkpointId']),
    scope: 'global',
    risk: 'read',
    execute: ({ checkpointId }) => diffAgainstCurrent(String(checkpointId))
  },
  {
    name: 'restore_checkpoint',
    description:
      'Roll the graph back to a checkpoint (ONE undo step). Nodes created since are deleted with their generations; outputs deleted since are not resurrected.',
    inputSchema: obj({ checkpointId: str() }, ['checkpointId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ checkpointId }) => restoreCheckpoint(String(checkpointId))
  },
  {
    name: 'delete_checkpoint',
    description:
      'Delete a checkpoint. The graph is untouched, but the captured state can never be restored again. Destructive.',
    inputSchema: obj({ checkpointId: str() }, ['checkpointId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ checkpointId }) => {
      deleteCheckpoint(String(checkpointId))
      return { ok: true }
    }
  },

  // ── §6.3 regional feedback ────────────────────────────────────────────────
  {
    name: 'get_annotations',
    description:
      'The user’s notes on one generation: a region of the frame or a timecode, plus what they said is wrong. This is their judgment — read it before proposing a fix.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'read',
    execute: ({ generationId }) => listAnnotations(String(generationId))
  },
  {
    name: 'create_edit_node',
    description:
      'Build the fix node from a generation’s notes: a gpt-image-2-image-to-image node wired to it, prompt composed from the regions and comments (image outputs only — for a clip, use the notes to rewrite the shot prompt). Creates nothing else and runs nothing.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'write',
    execute: ({ generationId }) => createEditNodeFromAnnotations(String(generationId))
  },
  {
    name: 'add_annotation',
    description:
      'Leave a note on a generation: a normalized region of the frame (image) or a timecode in seconds (clip), plus the comment. Shows up in the app’s feedback layer like a user note.',
    inputSchema: obj(
      {
        generationId: str(),
        comment: str('What is wrong (or right) there'),
        region: obj(
          {
            x: { type: 'number', description: '0–1, left edge' },
            y: { type: 'number', description: '0–1, top edge' },
            w: { type: 'number', description: '0–1' },
            h: { type: 'number', description: '0–1' }
          },
          ['x', 'y', 'w', 'h']
        ),
        timecodeSec: { type: 'number', description: 'Clip outputs: the moment the note is about' }
      },
      ['generationId', 'comment']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ generationId, comment, region, timecodeSec }) =>
      addAnnotation({
        generationId: String(generationId),
        comment: String(comment),
        region: region ? (region as { x: number; y: number; w: number; h: number }) : null,
        timecodeSec: timecodeSec === undefined ? null : Number(timecodeSec)
      })
  },
  {
    name: 'delete_annotation',
    description:
      'Delete one note from a generation (get_annotations lists their ids). Destructive.',
    inputSchema: obj({ annotationId: str() }, ['annotationId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ annotationId }) => {
      deleteAnnotation(String(annotationId))
      return { ok: true }
    }
  },
  {
    name: 'lint_node',
    description:
      'Check a node BEFORE running it: empty prompt, missing required input, reference wired but never addressed in the prompt, design sheet on a frame anchor, storyboard shot without the anti-grid guard, param outside the model’s enums or numeric bounds (a clip shorter than the model accepts), reference handle over its combined-length budget. Free — no kie.ai call.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId }) => {
      const findings = lintNodeById(String(nodeId))
      return {
        ok: findings.length === 0,
        findings: findings.map((f) => ({
          rule: f.rule,
          severity: f.severity,
          message: f.message,
          subject: f.subject ?? null,
          // The fix an agent can apply itself (update_node / connect_nodes).
          fix: f.fix ?? null
        }))
      }
    }
  },
  {
    name: 'preview_prompt',
    description:
      'The EXACT payload a run would submit, without running: final model id (draft-mode substitution applied), validated params, and the prompt with the video’s style sandwich composed in (§6.9). Free and deterministic — read it before spending credits when the wording matters. final: true previews the finalize path (draft substitution off).',
    inputSchema: obj(
      {
        nodeId: str(),
        final: {
          type: 'boolean',
          description: 'Preview the finalize (non-draft) payload.'
        }
      },
      ['nodeId']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId, final }) =>
      previewRunPayload(String(nodeId), { forceFinal: final === true })
  },
  {
    name: 'run_node',
    description:
      'Launch a node’s generation (calls kie.ai — COSTS MONEY; upstream inputs must already have outputs). Asynchronous: returns a generationId; completion is reported via get_generations (the embedded assistant is woken automatically instead). Pass variants: N to explore N parallel candidates of the SAME node (cost ×N) and let the user pick.',
    inputSchema: obj(
      {
        nodeId: str(),
        variants: {
          type: 'number',
          description: `Parallel candidates to generate for this node (1–${MAX_VARIANTS}, default 1 — the cost is multiplied accordingly)`
        }
      },
      ['nodeId']
    ),
    scope: 'global',
    risk: 'spending',
    execute: ({ nodeId, variants }) =>
      runNode(String(nodeId), false, { variants: clampVariants(variants ?? 1) })
  },
  {
    name: 'run_batch',
    description:
      'Run several nodes (or every video node) dependency-aware: shared upstreams generate once, independent branches in parallel, already-satisfied nodes are reused. COSTS MONEY. Returns the planned nodes; generations start and settle asynchronously (get_generations per node). variants: N generates N candidates per TARGET (dependencies still run once).',
    inputSchema: obj(
      {
        videoId: str(),
        targetNodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicit target nodes (their upstream dependencies run automatically)'
        },
        all_videos: {
          type: 'boolean',
          description: 'Target every video-model node of the graph instead'
        },
        variants: {
          type: 'number',
          description: `Parallel candidates per target node (1–${MAX_VARIANTS}, default 1 — each candidate is a separate paid run)`
        }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'spending',
    execute: ({ videoId, targetNodeIds, all_videos, variants }, ctx) => {
      const targets = all_videos
        ? videoNodeTargets(String(videoId))
        : Array.isArray(targetNodeIds)
          ? targetNodeIds.map(String)
          : []
      if (targets.length === 0) {
        throw new Error('Pass targetNodeIds, or all_videos: true on a graph with video nodes.')
      }
      const count = clampVariants(variants ?? 1)
      const { planned, done } = startBatch({
        videoId: String(videoId),
        targetNodeIds: targets,
        // Exploring variants means regenerating on purpose — reusing the
        // satisfied target would return zero candidates.
        reuseTargets: count === 1,
        variants: count,
        onGenerationStarted: ctx?.onGenerationStarted
      })
      void done
      return { planned }
    }
  },
  {
    name: 'finalize_video',
    description:
      'Re-run every node whose selected generation is a draft on the REAL models (COSTS MONEY — draft substitution bypassed) and promote each result to the node’s selection. Pass plan_only: true to list the nodes it would re-run without running anything.',
    inputSchema: obj(
      {
        videoId: str(),
        plan_only: { type: 'boolean', description: 'Only return the nodes that would be re-run' }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'spending',
    execute: ({ videoId, plan_only }, ctx) => {
      const plan = planFinalize(String(videoId))
      if (plan_only || plan.rows.length === 0) return plan
      const { planned, done } = finalizeVideo(String(videoId), ctx?.onGenerationStarted)
      void done
      return { planned }
    }
  },
  {
    name: 'review_generation',
    description:
      'Vision QC on a successful image generation: does it fulfill the prompt, any defects, consistent with its wired reference sheets? Verdict pass/warn + notes, persisted on the generation. Costs a small amount of credits.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'spending',
    execute: ({ generationId }) => reviewGeneration(String(generationId))
  },
  {
    name: 'review_clip',
    description:
      'Vision QC on a successful VIDEO generation: first/middle/last frames are sampled locally and judged against the prompt and the wired reference sheets (defects, identity drift, camera move). Verdict pass/warn + notes, persisted on the generation. Costs a small amount of credits.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'spending',
    execute: ({ generationId }) => reviewClipGeneration(String(generationId))
  },
  {
    name: 'get_generations',
    description:
      'List a node’s generations: status (pending/running/success/failed), media URL, local file path, draft flag, vision-QC verdict, error. Look at a result with get_generation_media (or read localPath directly when you run on this machine).',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId }) =>
      generations.listGenerationsForNode(String(nodeId)).map((g) => ({
        id: g.id,
        status: g.status,
        url: g.resultUrl,
        // Absolute path of the cached media on this machine — a local agent
        // can open it with its own file tools instead of fetching the URL.
        localPath: g.resultPath,
        draft: g.draft ?? false,
        qcVerdict: g.qcVerdict,
        qcNotes: g.qcNotes,
        // Speech runs only — read it with get_transcript.
        hasTranscript: g.transcript != null,
        error: g.errorMessage,
        createdAt: g.createdAt
      }))
  },
  {
    name: 'get_generation_media',
    description:
      'Look at a generation with your own eyes: returns a downscaled JPEG of the result as inline image content (for a video: one frame — position first|middle|last, or at_sec in media time). Judge results before spending more credits.',
    inputSchema: obj(
      {
        generationId: str(),
        position: {
          type: 'string',
          enum: ['first', 'middle', 'last'],
          description: 'Video only: which frame to grab (default middle).'
        },
        at_sec: { type: 'number', description: 'Video only: grab the frame at this media time.' }
      },
      ['generationId']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({ generationId, position, at_sec }) =>
      generationMediaPreview(String(generationId), {
        position:
          position === 'first' || position === 'middle' || position === 'last'
            ? position
            : undefined,
        atSec: typeof at_sec === 'number' ? at_sec : undefined
      })
  },
  {
    name: 'select_generation',
    description:
      'Mark one of a node’s successful generations as its output ("Use this"); "" resets to the newest.',
    inputSchema: obj(
      { nodeId: str(), generationId: str('A generation of this node, or "" to reset') },
      ['nodeId', 'generationId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, generationId }) => {
      graph.setSelectedGeneration(String(nodeId), generationId ? String(generationId) : null)
      return { ok: true }
    }
  },
  {
    name: 'export_image',
    description:
      'Copy an image generation’s downloaded file to disk (e.g. the roadmap thumbnail, ready to upload): explicit outputPath, or Downloads/<file_name>.<ext> — never overwrites, suffixes instead. Returns the written path. Images only.',
    inputSchema: obj(
      {
        generationId: str(),
        outputPath: str('Absolute destination path (default: Downloads folder)'),
        file_name: str('Base file name used with the default folder (default "thumbnail").')
      },
      ['generationId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ generationId, outputPath, file_name }) =>
      generations.exportGenerationImage(String(generationId), {
        ...(outputPath ? { outputPath: String(outputPath) } : {}),
        ...(file_name ? { fileName: String(file_name) } : {})
      })
  },
  {
    name: 'cancel_generation',
    description: 'Cancel a node’s in-flight generation (queued or polling). No smart retry after.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId }) => cancelGeneration(String(nodeId))
  },
  {
    name: 'dequeue_generation',
    description:
      'Remove ONE queued-but-unsubmitted generation from the run queue (row deleted — nothing was spent). Ids via queue_state/get_generations; a running generation needs cancel_generation.',
    inputSchema: obj({ generationId: str() }, ['generationId']),
    scope: 'global',
    risk: 'write',
    execute: ({ generationId }) => dequeueGeneration(String(generationId))
  },
  {
    name: 'refresh_generation_status',
    description:
      'Force one immediate status poll of a node’s latest generation (instead of waiting for the next scheduled poll).',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId }) => refreshStatus(String(nodeId))
  },
  {
    name: 'queue_state',
    description:
      'The generation queue right now: running and queued generation ids, the concurrency limit, and per-generation smart-retry counts. Not a completion signal — the settle wake-up is.',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: () => queueState()
  },
  {
    name: 'wait_for_generations',
    description:
      'Long-poll: blocks until the listed generations (and/or every in-flight generation of the listed nodes) settle — success or failure — or timeout_sec elapses (default 120, max 600; a timeout returns stillPending instead of throwing). For external agents; the embedded assistant is woken automatically and never needs this.',
    inputSchema: obj({
      generationIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Generation ids to wait on (already-settled ids report immediately).'
      },
      nodeIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Wait on every pending/running generation of these nodes.'
      },
      timeout_sec: { type: 'number' }
    }),
    scope: 'global',
    risk: 'read',
    execute: ({ generationIds, nodeIds, timeout_sec }) =>
      waitForGenerations({
        generationIds: Array.isArray(generationIds) ? generationIds.map(String) : undefined,
        nodeIds: Array.isArray(nodeIds) ? nodeIds.map(String) : undefined,
        timeoutSec: typeof timeout_sec === 'number' ? timeout_sec : undefined
      })
  }
]
