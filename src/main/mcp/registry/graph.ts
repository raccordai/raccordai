import { SCREEN_DIRECTIONS, planScenario, type ScenarioBeat } from '@shared/scenario'
import { getStyle } from '@shared/styles/registry'
import { refineNodeImagePrompt } from '../../services/ai'
import * as assets from '../../services/assets'
import * as generations from '../../services/generations'
import * as graph from '../../services/graph'
import * as graphHistory from '../../services/graphHistory'
import * as projects from '../../services/projects'
import { createRecipeNode } from '../../services/recipes'
import * as scenarioGraph from '../../services/scenarioGraph'
import * as videos from '../../services/videos'
import { assetRow, obj, str, type AgentTool } from './types'

/** The workflow graph: nodes, edges, scenario and the undo journal. */
export const graphTools: AgentTool[] = [
  {
    name: 'get_workflow',
    description:
      'Read a video’s graph: active style (art direction), nodes (id, key, modelId, label, intent, params, hasSuccessfulOutput), edges, and the project’s asset library.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => {
      const video = videos.getVideo(String(videoId))
      if (!video) throw new Error(`Unknown videoId "${String(videoId)}".`)
      const { nodes, edges } = graph.listGraph(video.id)
      const gens = generations.listGenerationsForVideo(video.id)
      const style = video.styleId ? getStyle(video.styleId) : undefined
      return {
        // The video's active art direction — appended at run time to prompts of
        // nodes whose params carry applyVideoStyle: true (never baked into prompts).
        style: style
          ? {
              id: style.id,
              label: style.label,
              styleBible: style.styleBible,
              imageFragment: style.imageFragment,
              videoFragment: style.videoFragment,
              musicHint: style.musicHint,
              avoid: style.avoid,
              recommendedParams: style.recommendedParams
            }
          : null,
        defaults: {
          aspectRatio: video.defaultAspectRatio ?? null,
          resolution: video.defaultResolution ?? null
        },
        // §6 iteration loop: cheap-substitution runs / vision checks on settle.
        draftMode: video.draftMode,
        qcEnabled: video.qcEnabled,
        // The project's methodology exists — read it with get_project_instructions
        // before planning work when true.
        hasProjectInstructions: Boolean(projects.getProject(video.projectId)?.instructions),
        // §6.7 — the shot list this graph is meant to realize. Summary only:
        // get_scenario returns the shots with their prompt scaffolds.
        scenario: video.scenario
          ? {
              brief: video.scenario.brief,
              shotCount: video.scenario.shots.length,
              totalSeconds: video.scenario.totalSeconds,
              warnings: video.scenario.warnings.length
            }
          : null,
        nodes: nodes.map((n) => ({
          id: n.id,
          key: n.key,
          modelId: n.modelId,
          label: n.label,
          intent: n.intent,
          position: n.position,
          params: n.params,
          // On studio/asset nodes: the referenced asset's kind (derived) — a
          // 'video' asset placed on the timeline plays as a real clip.
          ...(n.modelId === 'studio/asset' ? { assetKind: n.assetKind ?? null } : {}),
          // Timeline editing state (set_timeline_order / set_clip_trim /
          // set_clip_transition / set_clip_overlay).
          timelineOrder: n.timelineOrder ?? null,
          trimStartSec: n.trimStartSec ?? null,
          trimEndSec: n.trimEndSec ?? null,
          transitionAfter: n.transitionAfter ?? null,
          transitionDurationSec: n.transitionDurationSec ?? null,
          // Split clip (§6.12e): non-null once split_clip ran — each segment
          // has its own trim/transition, addressed by segmentIndex.
          segments: n.segments ?? null,
          overlay: n.overlay ?? null,
          // Baked per-clip effects + audio placement — what set_clip_speed /
          // set_clip_look / set_clip_framing / set_still_motion /
          // set_clip_volume / set_audio_offset wrote (null = untouched).
          // get_timeline returns the RESOLVED placement these produce.
          speed: n.speed ?? null,
          look: n.look ?? null,
          framing: n.framing ?? null,
          stillMotion: n.stillMotion ?? null,
          volume: n.volume ?? null,
          timelineOffsetSec: n.timelineOffsetSec ?? null,
          hasSuccessfulOutput: gens.some((g) => g.nodeId === n.id && g.status === 'success')
        })),
        edges: edges.map((e) => ({
          id: e.id,
          from: e.sourceNodeId,
          to: e.targetNodeId,
          input: e.targetHandle,
          output: e.sourceHandle
        })),
        assets: assets.listAssets(video.projectId).map(assetRow)
      }
    }
  },
  {
    name: 'write_scenario',
    description:
      'Turn a brief into the video\'s scenario, BEFORE present_plan: you write the beats, it returns shots with durations the model accepts, chained by their opening/closing frames, each carrying a promptScaffold to write the shot prompt on top of. Always report its `warnings` to the user — stretched or merged beats, a total that drifts from the brief, a cut with no exit frame. Details: docs "scenario".',
    inputSchema: obj(
      {
        videoId: str(),
        brief: str('The user’s brief, verbatim — what the film has to deliver'),
        modelId: str('Video model the shot durations must be legal for'),
        targetSeconds: {
          type: 'number',
          description: 'Total length the brief asks for, when it names one'
        },
        shortBeatPolicy: {
          type: 'string',
          enum: ['stretch', 'merge'],
          description:
            'Beats under the model floor: "stretch" (default) runs them at the floor and keeps the cut list; "merge" folds them into a neighbour and keeps the film length.'
        },
        beats: {
          type: 'array',
          description: 'The script, in order.',
          items: {
            type: 'object',
            properties: {
              title: str('Short beat title, e.g. "Le départ"'),
              action: str('What happens — the raw material of the shot prompt'),
              seconds: { type: 'number', description: 'Length the script asks for' },
              camera: str('Camera intent, e.g. "low-angle tracking"'),
              sound: str('Dialogue and sound design'),
              opensOn: str('Frame this beat opens on (derived from the previous one if omitted)'),
              closesOn: str('Frame this beat closes on — what the NEXT shot opens on'),
              screenDirection: {
                type: 'string',
                enum: [...SCREEN_DIRECTIONS],
                description: 'Which way the subject travels — continuity across the cut'
              },
              roles: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Cast roles appearing in this beat, by name (list_castings). WHO is in a shot cannot be derived from the script — name them here and build_graph_from_scenario wires each sheet on exactly the shots it belongs to.'
              },
              boardDriven: {
                type: 'boolean',
                description: 'True if a storyboard/shot board will be wired on this shot'
              },
              mergeWithNext: {
                type: 'boolean',
                description: 'Fold this beat into the next one whatever the policy'
              }
            },
            required: ['title', 'action', 'seconds']
          }
        }
      },
      ['videoId', 'brief', 'modelId', 'beats']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, brief, modelId, targetSeconds, shortBeatPolicy, beats }) => {
      const scenario = planScenario({
        brief: String(brief),
        modelId: String(modelId),
        ...(typeof targetSeconds === 'number' ? { targetSeconds } : {}),
        ...(shortBeatPolicy === 'merge' || shortBeatPolicy === 'stretch'
          ? { shortBeatPolicy }
          : {}),
        beats: (Array.isArray(beats) ? beats : []) as ScenarioBeat[]
      })
      videos.setVideoScenario(String(videoId), scenario)
      return scenario
    }
  },
  {
    name: 'get_scenario',
    description:
      "The video's scenario: the shot list, each shot's legal duration, its opening and closing frames, and the promptScaffold to write its prompt on top of. Null when none was written yet.",
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => videos.getVideoScenario(String(videoId))
  },
  {
    name: 'build_graph_from_scenario',
    description:
      'Realize the video’s scenario as a graph: one shot-preset node per shot, camera move read from the shot’s own `camera` line, duration, frames and screen direction filled in, and the scenario’s roles cast onto the shots naming them — ONE undo step. Prefer it to hand-writing an import_workflow. Re-running only adds new shots; plan_only is free. Details: docs "scenario".',
    inputSchema: obj(
      {
        videoId: str(),
        shotKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Scenario shot keys to build. Defaults to every shot not built yet.'
        },
        plan_only: {
          type: 'boolean',
          description: 'Dry run: report what would be created without touching the graph.'
        }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, shotKeys, plan_only }) => {
      const args = {
        videoId: String(videoId),
        ...(Array.isArray(shotKeys) ? { shotKeys: shotKeys.map(String) } : {})
      }
      return plan_only === true
        ? scenarioGraph.planScenarioGraph(args)
        : scenarioGraph.buildGraphFromScenario(args)
    }
  },
  {
    name: 'export_workflow',
    description: 'Export a video’s graph as portable workflow JSON (see docs "workflow-json").',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => graph.exportWorkflow(String(videoId))
  },
  {
    name: 'import_workflow',
    description:
      'Bulk-create a graph from workflow JSON (docs "workflow-json"). replace=true ERASES the current graph — needs explicit user consent.',
    inputSchema: obj(
      { videoId: str(), json: str('Workflow JSON as a string'), replace: { type: 'boolean' } },
      ['videoId', 'json', 'replace']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, json, replace }) =>
      graph.importWorkflow(String(videoId), String(json), Boolean(replace))
  },
  {
    name: 'add_node',
    description:
      'Create a node. Read docs "model:<id>" first for valid params; "studio/asset" nodes take params {"assetId"}.',
    inputSchema: obj(
      {
        videoId: str(),
        modelId: str(),
        label: str('Short display label, e.g. "Shot 01 — The harbor"'),
        intent: str('Expected result, shown to the user'),
        params: { type: 'object' },
        x: {
          type: 'number',
          description:
            'Canvas x. Omit BOTH x and y to drop the node in the next free slot — never pass 0/0 to mean "anywhere", it stacks nodes on top of each other. Left-to-right flow: 0, 420, 840…'
        },
        y: { type: 'number', description: 'Canvas y. Rows are spaced ~350 apart.' }
      },
      ['videoId', 'modelId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, modelId, label, intent, params, x, y }) =>
      graph.createNode({
        videoId: String(videoId),
        modelId: String(modelId),
        ...(x === undefined && y === undefined
          ? {}
          : { position: { x: Number(x ?? 0), y: Number(y ?? 0) } }),
        label: label ? String(label) : undefined,
        intent: intent ? String(intent) : undefined,
        params
      })
  },
  {
    name: 'add_recipe_node',
    description:
      'Create a PRE-CONFIGURED node from a recipe: a design sheet (docs "designs") or a shot preset (docs "shots"). Builds the prompt for the model and the video’s style, sets the markers, and wires the source of a from-image/from-video mode in ONE undo step. Prefer it over add_node whenever a recipe fits.',
    inputSchema: obj(
      {
        videoId: str(),
        recipeId: str('Recipe id — docs "designs" / docs "shots"'),
        modeId: str(
          '"text" (default), "from-image" or "from-video" — a source mode needs `source`'
        ),
        modelId: str('Override the mode’s model; must be one of the recipe’s supported models'),
        values: {
          type: 'object',
          description:
            'Field values keyed by field id, e.g. {"description":"Léa, pink hair","views":"turnaround"}. "description" is required; unknown keys are ignored and blank selects fall back to their default.'
        },
        source: {
          type: 'object',
          description:
            'The media a from-image/from-video mode is built on: {"assetId"} (a library asset — an asset node is created and wired) or {"nodeId"} (an existing node of this video).',
          properties: { assetId: str(), nodeId: str() }
        },
        x: { type: 'number', description: 'Canvas x. Omit BOTH x and y for the next free slot.' },
        y: { type: 'number', description: 'Canvas y.' }
      },
      ['videoId', 'recipeId', 'values']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, recipeId, modeId, modelId, values, source, x, y }) => {
      const raw = (values ?? {}) as Record<string, unknown>
      const src = (source ?? {}) as { assetId?: unknown; nodeId?: unknown }
      return createRecipeNode({
        videoId: String(videoId),
        recipeId: String(recipeId),
        ...(modeId === undefined ? {} : { modeId: String(modeId) }),
        ...(modelId === undefined ? {} : { modelId: String(modelId) }),
        values: Object.fromEntries(
          Object.entries(raw).map(([key, value]) => [key, value == null ? '' : String(value)])
        ),
        ...(src.assetId || src.nodeId
          ? {
              source: {
                ...(src.assetId ? { assetId: String(src.assetId) } : {}),
                ...(src.nodeId ? { nodeId: String(src.nodeId) } : {})
              }
            }
          : {}),
        ...(x === undefined && y === undefined
          ? {}
          : { position: { x: Number(x ?? 0), y: Number(y ?? 0) } })
      })
    }
  },
  {
    name: 'update_node',
    description: 'Update a node’s label, intent and/or params (params replace the whole object).',
    inputSchema: obj({ nodeId: str(), label: str(), intent: str(), params: { type: 'object' } }, [
      'nodeId'
    ]),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, label, intent, params }) => {
      const id = String(nodeId)
      if (label !== undefined) graph.updateNodeLabel(id, String(label))
      if (intent !== undefined) graph.updateNodeIntent(id, String(intent))
      if (params !== undefined) graph.updateNodeParams(id, params)
      return { ok: true }
    }
  },
  {
    name: 'refine_image_prompt',
    description:
      'Rewrite an image node’s prompt from what its current output actually shows: pass the adjustment ("fix the hands", "warmer light") and get back a full new prompt that keeps style, language and @references — then apply it with update_node. Uses the node’s selected output image; costs a small amount of credits.',
    inputSchema: obj({ nodeId: str(), instruction: str('The adjustment to incorporate.') }, [
      'nodeId',
      'instruction'
    ]),
    scope: 'global',
    risk: 'spending',
    execute: ({ nodeId, instruction }) => refineNodeImagePrompt(String(nodeId), String(instruction))
  },
  {
    name: 'update_node_position',
    description:
      'Move a node on the canvas (left-to-right flow, x: 0, 420, 840…, y spaced ~350). get_workflow returns the current positions.',
    inputSchema: obj(
      {
        nodeId: str(),
        position: obj({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y'])
      },
      ['nodeId', 'position']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, position }) => {
      const p = position as { x?: unknown; y?: unknown }
      graph.updateNodePosition(String(nodeId), { x: Number(p?.x ?? 0), y: Number(p?.y ?? 0) })
      return { ok: true }
    }
  },
  {
    name: 'replace_node_model',
    description:
      'Swap a node’s model in place (e.g. Grok → Seedance): compatible params are kept, edges re-land on matching handles — but the node’s GENERATIONS are deleted (a new model can’t reuse them). Destructive.',
    inputSchema: obj({ nodeId: str(), modelId: str('The new model id (list_models)') }, [
      'nodeId',
      'modelId'
    ]),
    scope: 'global',
    risk: 'destructive',
    execute: ({ nodeId, modelId }) => {
      graph.replaceNodeModel(String(nodeId), String(modelId))
      return { ok: true }
    }
  },
  {
    name: 'connect_nodes',
    description:
      'Wire a source node output into a target node input. "input" must be a valid input field of the target model (docs "model:<id>").',
    inputSchema: obj(
      {
        videoId: str(),
        sourceNodeId: str(),
        targetNodeId: str(),
        input: str('Target model input field'),
        output: str('"output" (default) or "lastFrame"')
      },
      ['videoId', 'sourceNodeId', 'targetNodeId', 'input']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, sourceNodeId, targetNodeId, input, output }) =>
      graph.connectNodes({
        videoId: String(videoId),
        sourceNodeId: String(sourceNodeId),
        sourceHandle: output ? String(output) : 'output',
        targetNodeId: String(targetNodeId),
        targetHandle: String(input)
      })
  },
  {
    name: 'disconnect_edge',
    description:
      'Remove ONE connection by its edge id (get_workflow lists them) — the nodes on both sides stay. Undoable.',
    inputSchema: obj({ edgeId: str('Edge id from get_workflow') }, ['edgeId']),
    scope: 'global',
    risk: 'write',
    execute: ({ edgeId }) => {
      graph.disconnectEdge(String(edgeId))
      return { ok: true }
    }
  },
  {
    name: 'reorder_edges',
    description:
      'Reorder the connections of ONE input handle — the order is semantic (@Image1/@Image2 numbering, Seedance 1.5 first/last frame). Pass every edge of that handle in the desired order.',
    inputSchema: obj(
      {
        videoId: str(),
        targetNodeId: str(),
        input: str('The input handle whose connections to reorder'),
        edgeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'ALL edge ids currently on that handle, in the desired order.'
        }
      },
      ['videoId', 'targetNodeId', 'input', 'edgeIds']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, targetNodeId, input, edgeIds }) => {
      graph.reorderEdges({
        videoId: String(videoId),
        targetNodeId: String(targetNodeId),
        targetHandle: String(input),
        edgeIds: (Array.isArray(edgeIds) ? edgeIds : []).map(String)
      })
      return { ok: true }
    }
  },
  {
    name: 'remove_node',
    description:
      'Delete a node, its connections and its generations (generations are NOT restored by undo). Destructive.',
    inputSchema: obj({ nodeId: str() }, ['nodeId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ nodeId }) => {
      graph.removeNode(String(nodeId))
      return { ok: true }
    }
  },
  {
    name: 'undo',
    description: 'Undo the last graph mutation on a video (deleted generations are not restored).',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId }) => graphHistory.undoGraph(String(videoId))
  },
  {
    name: 'redo',
    description: 'Redo the last undone graph mutation on a video.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId }) => graphHistory.redoGraph(String(videoId))
  },
  {
    name: 'get_history',
    description:
      'The video’s undo/redo stacks: depths plus a summary of the next entries on each side (nodes/edges added, removed, changed, and which node labels are touched) — read it before undoing blind. Newest first; free.',
    inputSchema: obj(
      {
        videoId: str(),
        limit: { type: 'number', description: 'Entries summarized per side (default 5).' }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId, limit }) =>
      graphHistory.historyDetails(
        String(videoId),
        typeof limit === 'number' && limit > 0 ? Math.min(20, Math.floor(limit)) : undefined
      )
  }
]
