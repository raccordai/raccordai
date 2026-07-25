import { z } from 'zod'

/**
 * Single source of truth for the renderer <-> main boundary.
 * Every channel declares its input and output schema; the main process
 * validates both sides at runtime, the renderer gets full static typing.
 */

export const localeSchema = z.enum(['fr', 'en'])
export type Locale = z.infer<typeof localeSchema>

/**
 * Session key of the home (project-level) assistant — used as the `videoId`
 * of the chat channels (`projectId` is '' there). It can create projects and
 * videos and build workflows anywhere; video-scoped sessions use real ids.
 */
export const HOME_CHAT_ID = 'home'

/**
 * Models the embedded assistant can run on — all served by kie.ai's market
 * proxies with the same API key. Claude ids go through /claude/v1/messages
 * (Anthropic Messages format); GPT ids go through the OpenAI Responses proxies.
 */
export const assistantModelSchema = z.enum([
  'claude-opus-4-8',
  'claude-sonnet-5',
  'gpt-5-6-sol',
  'gpt-5.4-codex'
])
export type AssistantModel = z.infer<typeof assistantModelSchema>

/**
 * Does the assistant need the user's approval before spending credits?
 * 'ask' (default) gates every run tool behind the same approval card as the
 * destructive ones; 'auto' lets it launch generations on its own.
 */
export const assistantRunApprovalSchema = z.enum(['ask', 'auto'])
export type AssistantRunApproval = z.infer<typeof assistantRunApprovalSchema>

export const releaseChannelSchema = z.enum(['dev', 'beta', 'stable'])
export type ReleaseChannel = z.infer<typeof releaseChannelSchema>

/** Packaged-build channel (dev is implied by an unpackaged run). */
export const updateChannelSchema = z.enum(['stable', 'beta'])
export type UpdateChannel = z.infer<typeof updateChannelSchema>

export const updateStateSchema = z.object({
  status: z.enum([
    'unsupported',
    'idle',
    'checking',
    'downloading',
    'downloaded',
    'up-to-date',
    'error'
  ]),
  version: z.string().nullable(),
  error: z.string().nullable()
})
export type UpdateState = z.infer<typeof updateStateSchema>

export const appInfoSchema = z.object({
  version: z.string(),
  channel: releaseChannelSchema,
  platform: z.string(),
  dbPath: z.string(),
  localApi: z.object({
    running: z.boolean(),
    port: z.number().nullable()
  })
})
export type AppInfo = z.infer<typeof appInfoSchema>

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Project = z.infer<typeof projectSchema>

/** Video-level default aspect ratio — applied to node params only when the model supports the value. */
export const videoAspectRatioSchema = z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
export type VideoAspectRatio = z.infer<typeof videoAspectRatioSchema>

/** Video-level default resolution (video models use Np, image models use NK). */
export const videoResolutionSchema = z.enum(['480p', '720p', '1080p', '1K', '2K', '4K'])
export type VideoResolution = z.infer<typeof videoResolutionSchema>

export const videoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  /** Active style template id (src/shared/styles/registry.ts), null = no style. */
  styleId: z.string().nullable(),
  /** Video-level generation defaults — pre-fill new nodes, never silently rewrite existing ones. */
  defaultAspectRatio: z.string().nullable(),
  defaultResolution: z.string().nullable(),
  /** Draft mode (§6.1): runs substitute each model's draftEquivalent until finalized. */
  draftMode: z.boolean(),
  /** Vision QC (§6.2): successful image generations get one cheap vision check. */
  qcEnabled: z.boolean(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type Video = z.infer<typeof videoSchema>

export const mediaKindSchema = z.enum(['image', 'video', 'audio'])

export const assetSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  kind: mediaKindSchema,
  filePath: z.string().nullable(),
  sourceUrl: z.string().nullable(),
  mimeType: z.string().nullable(),
  size: z.number().nullable(),
  /** Normalized (lowercase, deduplicated) user labels for filtering the library. */
  tags: z.array(z.string()),
  /** Design-recipe category when this asset is a published design sheet (e.g. 'character'). */
  designId: z.string().nullable(),
  /** The subject the design sheet was built from ("Mira, 12, red scarf"). */
  designSubject: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number().nullable()
})
export type Asset = z.infer<typeof assetSchema>

/** Display URL: media://asset/<id> for managed files, else the referenced sourceUrl. */
export const assetWithUrlSchema = assetSchema.extend({ url: z.string().nullable() })
export type AssetWithUrl = z.infer<typeof assetWithUrlSchema>

export const positionSchema = z.object({ x: z.number(), y: z.number() })

export const graphNodeSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  key: z.string(),
  modelId: z.string(),
  label: z.string().nullable(),
  intent: z.string().nullable(),
  position: positionSchema,
  params: z.unknown(),
  selectedGenerationId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type GraphNode = z.infer<typeof graphNodeSchema>

export const graphEdgeSchema = z.object({
  id: z.string(),
  videoId: z.string(),
  sourceNodeId: z.string(),
  sourceHandle: z.string(),
  targetNodeId: z.string(),
  targetHandle: z.string(),
  createdAt: z.number()
})
export type GraphEdge = z.infer<typeof graphEdgeSchema>

export const generationStatusSchema = z.enum(['pending', 'running', 'success', 'failed'])

/** Vision-QC verdict (§6.2): 'error' means the QC call itself failed. */
export const qcVerdictSchema = z.enum(['pass', 'warn', 'error'])
export type QcVerdict = z.infer<typeof qcVerdictSchema>

export const generationSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  videoId: z.string(),
  status: generationStatusSchema,
  kieTaskId: z.string().nullable(),
  inputSnapshot: z.unknown(),
  /** Display URL: media://generation/<id>/result once local, else the remote kie.ai URL. */
  url: z.string().nullable(),
  lastFrameUrl: z.string().nullable(),
  resultMimeType: z.string().nullable(),
  /** True when the run was substituted to the model's draftEquivalent (§6.1). */
  draft: z.boolean(),
  /** Vision-QC verdict (§6.2) — 'pass' | 'warn' | 'error', null = not checked. */
  qcVerdict: qcVerdictSchema.nullable(),
  qcNotes: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.number(),
  completedAt: z.number().nullable()
})
export type Generation = z.infer<typeof generationSchema>

/** The portable workflow JSON (version 1) — same interchange format as video-studio. */
export const workflowExportSchema = z.object({
  version: z.literal(1),
  assets: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      kind: mediaKindSchema,
      mimeType: z.string().optional(),
      description: z.string()
    })
  ),
  nodes: z.array(
    z.object({
      key: z.string(),
      modelId: z.string(),
      label: z.string().optional(),
      intent: z.string().optional(),
      position: positionSchema,
      params: z.record(z.string(), z.unknown())
    })
  ),
  edges: z.array(
    z.object({
      from: z.string().optional(),
      to: z.string().optional(),
      input: z.string(),
      output: z.string()
    })
  )
})
export type WorkflowExport = z.infer<typeof workflowExportSchema>

/**
 * A structured production plan presented by the assistant before building or
 * running (§4.7): per-shot model + estimated cost, rendered as an approval
 * card in the chat panel.
 */
export const chatPlanSchema = z.object({
  shots: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      modelId: z.string(),
      estCredits: z.number().nullable(),
      /** Storyboard panels this shot covers (e.g. "1-3"), when relevant. */
      panels: z.string().optional()
    })
  ),
  /** Style template id or label the plan commits to, when one was chosen. */
  style: z.string().nullable(),
  totalCredits: z.number().nullable()
})
export type ChatPlan = z.infer<typeof chatPlanSchema>

/**
 * Snapshot of what the user is looking at, attached to a chat send (§4.10
 * phase 2). All-optional: the renderer fills what it cheaply knows; the chat
 * service renders it as an <app-context> block for the model (never shown in
 * the transcript).
 */
export const appContextSchema = z.object({
  route: z.string().optional(),
  projectId: z.string().optional(),
  videoId: z.string().optional(),
  selectedNodeId: z.string().optional(),
  selectedGenerationId: z.string().optional(),
  /** Last generation error surfaced to the user (toast), if any. */
  lastError: z.string().optional()
})
export type AppContext = z.infer<typeof appContextSchema>

/** An image attached to a chat message (base64, no data: prefix). */
export const chatImageSchema = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: z.string().min(1)
})
export type ChatImage = z.infer<typeof chatImageSchema>

/** One rendered entry of the assistant conversation (Claude-style transcript). */
export const chatItemSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('user'),
    text: z.string(),
    /** Data URLs of the images attached to this message (thumbnail display). */
    images: z.array(z.string()).optional()
  }),
  z.object({ type: z.literal('assistant'), text: z.string() }),
  z.object({
    type: z.literal('tool'),
    name: z.string(),
    label: z.string(),
    ok: z.boolean()
  }),
  z.object({ type: z.literal('plan'), plan: chatPlanSchema }),
  /** Destructive-approval action card (§4.10 phase 3): shown when a destructive
   *  tool was called without confirm — Approve / Request changes post back. */
  z.object({ type: z.literal('action'), name: z.string(), label: z.string() })
])
export type ChatItem = z.infer<typeof chatItemSchema>

export const chatStateSchema = z.object({
  items: z.array(chatItemSchema),
  busy: z.boolean(),
  error: z.string().nullable(),
  /** Streaming text of the in-flight assistant turn (§4.10 phase 6). */
  partialText: z.string().nullable()
})
export type ChatState = z.infer<typeof chatStateSchema>

/**
 * Live view of the generation queue (ids are generation ids). `queued` is in
 * start order — a node's queue position is its index + 1. `retrying` maps a
 * generation to its current automatic-retry attempt (1-based, max 3).
 */
export const queueStateSchema = z.object({
  running: z.array(z.string()),
  queued: z.array(z.string()),
  limit: z.number().int().min(1),
  retrying: z.record(z.string(), z.number())
})
export type QueueState = z.infer<typeof queueStateSchema>

export const ipcContracts = {
  'app:getInfo': { input: z.void(), output: appInfoSchema },
  'settings:getLocale': { input: z.void(), output: localeSchema },
  'settings:setLocale': { input: localeSchema, output: z.void() },
  'projects:list': { input: z.void(), output: z.array(projectSchema) },
  'projects:get': { input: z.object({ id: z.string() }), output: projectSchema.nullable() },
  'projects:create': { input: z.object({ name: z.string().trim().min(1) }), output: projectSchema },
  'projects:delete': { input: z.object({ id: z.string() }), output: z.void() },

  'projects:overview': {
    input: z.void(),
    output: z.array(
      projectSchema.extend({
        videoCount: z.number(),
        thumbnailUrl: z.string().nullable(),
        thumbnailKind: mediaKindSchema.nullable()
      })
    )
  },
  'projects:rename': {
    input: z.object({ id: z.string(), name: z.string().trim().min(1) }),
    output: z.void()
  },

  'videos:listByProject': {
    input: z.object({ projectId: z.string() }),
    output: z.array(videoSchema)
  },
  'videos:overview': {
    input: z.object({ projectId: z.string() }),
    output: z.array(
      videoSchema.extend({
        clipCount: z.number(),
        nodeCount: z.number(),
        thumbnailUrl: z.string().nullable(),
        thumbnailKind: mediaKindSchema.nullable()
      })
    )
  },
  'videos:get': { input: z.object({ videoId: z.string() }), output: videoSchema.nullable() },
  'videos:create': {
    input: z.object({ projectId: z.string(), name: z.string().trim().min(1) }),
    output: videoSchema
  },
  'videos:rename': {
    input: z.object({ videoId: z.string(), name: z.string().trim().min(1) }),
    output: z.void()
  },
  'videos:remove': { input: z.object({ videoId: z.string() }), output: z.void() },
  'videos:setStyle': {
    input: z.object({ videoId: z.string(), styleId: z.string().nullable() }),
    output: z.void()
  },
  /** Video-level generation defaults (null clears; omitted fields are untouched). */
  'videos:setDefaults': {
    input: z.object({
      videoId: z.string(),
      defaultAspectRatio: videoAspectRatioSchema.nullable().optional(),
      defaultResolution: videoResolutionSchema.nullable().optional()
    }),
    output: z.void()
  },
  /** Bulk-apply the video defaults to every compatible existing node — one undoable step. */
  'nodes:applyVideoDefaults': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ updated: z.number() })
  },
  /** Draft mode (§6.1): while on, runs substitute each model's draftEquivalent. */
  'videos:setDraftMode': {
    input: z.object({ videoId: z.string(), enabled: z.boolean() }),
    output: z.void()
  },
  /** Vision QC (§6.2): while on, successful image generations get one cheap vision check. */
  'videos:setQcEnabled': {
    input: z.object({ videoId: z.string(), enabled: z.boolean() }),
    output: z.void()
  },

  'assets:listByProject': {
    input: z.object({ projectId: z.string() }),
    output: z.array(assetWithUrlSchema)
  },
  'assets:get': {
    input: z.object({ assetId: z.string() }),
    output: assetWithUrlSchema.nullable()
  },
  /** Opens the native file picker and imports the selected media files. */
  'assets:importFromDialog': {
    input: z.object({ projectId: z.string() }),
    output: z.array(assetWithUrlSchema)
  },
  /**
   * Import local media files by absolute path (canvas drag-and-drop — paths
   * come from the preload's getPathForFile). Unsupported files are skipped;
   * only the imported assets are returned.
   */
  'assets:importFromPaths': {
    input: z.object({ projectId: z.string(), paths: z.array(z.string()).min(1) }),
    output: z.array(assetWithUrlSchema)
  },
  'assets:update': {
    input: z.object({
      assetId: z.string(),
      name: z.string().trim().min(1).optional(),
      description: z.string().nullable().optional(),
      designSubject: z.string().nullable().optional()
    }),
    output: z.void()
  },
  'assets:remove': { input: z.object({ assetId: z.string() }), output: z.void() },
  /** Videos whose workflow references this asset through a studio/asset node (delete guard). */
  'assets:references': {
    input: z.object({ assetId: z.string() }),
    output: z.array(z.object({ videoId: z.string(), videoName: z.string(), nodeCount: z.number() }))
  },
  'assets:setTags': {
    input: z.object({ assetId: z.string(), tags: z.array(z.string()) }),
    output: z.void()
  },
  /** Groups (2+) of asset ids whose file content is byte-identical. */
  'assets:duplicateGroups': {
    input: z.object({ projectId: z.string() }),
    output: z.array(z.array(z.string()))
  },

  'graph:get': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ nodes: z.array(graphNodeSchema), edges: z.array(graphEdgeSchema) })
  },
  'graph:timelineFallbackImages': {
    input: z.object({ videoId: z.string() }),
    output: z.record(z.string(), z.string())
  },
  'nodes:create': {
    input: z.object({
      videoId: z.string(),
      modelId: z.string(),
      position: positionSchema,
      key: z.string().optional(),
      params: z.unknown().optional(),
      label: z.string().optional(),
      intent: z.string().optional()
    }),
    output: graphNodeSchema
  },
  'nodes:updateParams': {
    input: z.object({ nodeId: z.string(), params: z.unknown() }),
    output: z.void()
  },
  'nodes:updateLabel': {
    input: z.object({ nodeId: z.string(), label: z.string() }),
    output: z.void()
  },
  'nodes:updateIntent': {
    input: z.object({ nodeId: z.string(), intent: z.string() }),
    output: z.void()
  },
  'nodes:updatePosition': {
    input: z.object({ nodeId: z.string(), position: positionSchema }),
    output: z.void()
  },
  'nodes:updatePositions': {
    input: z.object({
      updates: z.array(z.object({ nodeId: z.string(), position: positionSchema }))
    }),
    output: z.void()
  },
  'nodes:replaceModel': {
    input: z.object({ nodeId: z.string(), modelId: z.string() }),
    output: z.void()
  },
  'nodes:remove': { input: z.object({ nodeId: z.string() }), output: z.void() },
  'edges:connect': {
    input: z.object({
      videoId: z.string(),
      sourceNodeId: z.string(),
      sourceHandle: z.string(),
      targetNodeId: z.string(),
      targetHandle: z.string()
    }),
    output: graphEdgeSchema
  },
  'edges:disconnect': { input: z.object({ edgeId: z.string() }), output: z.void() },
  /**
   * Reorder the connections of one input handle (§4.6): reference numbering
   * (@Image1, @Image2…) follows edge creation order, so `edgeIds` — a
   * permutation of the handle's current connections — becomes the new order.
   * One journaled (undoable) step.
   */
  'edges:reorder': {
    input: z.object({
      videoId: z.string(),
      targetNodeId: z.string(),
      targetHandle: z.string(),
      edgeIds: z.array(z.string()).min(1)
    }),
    output: z.void()
  },

  'history:state': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ canUndo: z.boolean(), canRedo: z.boolean() })
  },
  'history:undo': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ canUndo: z.boolean(), canRedo: z.boolean() })
  },
  'history:redo': {
    input: z.object({ videoId: z.string() }),
    output: z.object({ canUndo: z.boolean(), canRedo: z.boolean() })
  },

  'workflow:export': { input: z.object({ videoId: z.string() }), output: workflowExportSchema },
  'workflow:import': {
    input: z.object({ videoId: z.string(), json: z.string(), replace: z.boolean() }),
    output: z.object({ nodeCount: z.number(), edgeCount: z.number() })
  },

  'generations:listForNode': {
    input: z.object({ nodeId: z.string() }),
    output: z.array(generationSchema)
  },
  'generations:listForVideo': {
    input: z.object({ videoId: z.string() }),
    output: z.array(generationSchema)
  },
  'generations:get': {
    input: z.object({ generationId: z.string() }),
    output: generationSchema.nullable()
  },
  'generations:historyForVideo': {
    input: z.object({ videoId: z.string() }),
    output: z.array(
      generationSchema.extend({
        nodeLabel: z.string().nullable(),
        modelId: z.string(),
        isSelected: z.boolean(),
        nodeExists: z.boolean()
      })
    )
  },
  'generations:select': {
    input: z.object({ nodeId: z.string(), generationId: z.string().nullable() }),
    output: z.void()
  },

  'generations:run': {
    input: z.object({ nodeId: z.string(), reuseSatisfied: z.boolean().optional() }),
    output: z.object({ generationId: z.string(), kieTaskId: z.string() })
  },
  'generations:refreshStatus': {
    input: z.object({ nodeId: z.string() }),
    output: z.object({ status: z.string() })
  },
  'generations:cancel': {
    input: z.object({ nodeId: z.string() }),
    output: z.object({ cancelled: z.boolean() })
  },
  'generations:setLastFrame': {
    input: z.object({ generationId: z.string(), jpegBase64: z.string() }),
    output: z.void()
  },
  /** Read-only snapshot of the run queue — pushed fresh via event:queueChanged. */
  'generations:queueState': { input: z.void(), output: queueStateSchema },
  /** OS notification summarizing a finished batch run ("4 succeeded, 1 failed"). */
  'notifications:batchSummary': {
    input: z.object({ succeeded: z.number().int().min(0), failed: z.number().int().min(0) }),
    output: z.void()
  },
  /** Indicative credit cost of running this node now (null = no rates declared). */
  'generations:estimateCost': {
    input: z.object({ nodeId: z.string() }),
    output: z.object({ credits: z.number().nullable() })
  },
  /** §4.10 phase 4 — smart-run planning in the main process: nodes that will
   *  claim a generation (deps always reuse; targets only with reuseTargets)
   *  + per-node credit estimates. Feeds the §4.4 cost modal. */
  'generations:planRun': {
    input: z.object({
      videoId: z.string(),
      targetNodeIds: z.array(z.string()).min(1),
      reuseTargets: z.boolean()
    }),
    output: z.object({
      rows: z.array(
        z.object({ nodeId: z.string(), label: z.string(), credits: z.number().nullable() })
      ),
      total: z.number()
    })
  },
  /** Runs the same plan dependency-aware (shared upstreams once, independent
   *  branches parallel, settle-aware sequencing) and resolves when the whole
   *  batch settled. One failing branch doesn't abort the others. */
  'generations:runBatch': {
    input: z.object({
      videoId: z.string(),
      targetNodeIds: z.array(z.string()).min(1),
      reuseTargets: z.boolean()
    }),
    output: z.object({
      succeeded: z.number().int().min(0),
      failed: z.number().int().min(0),
      /** nodeId → generationId for every node that claimed one. */
      generations: z.record(z.string(), z.string())
    })
  },
  /** §6.1 finalize — nodes whose selected generation is a draft, with the
   *  draft cost already spent vs the estimated cost on the real models. */
  'generations:planFinalize': {
    input: z.object({ videoId: z.string() }),
    output: z.object({
      rows: z.array(
        z.object({
          nodeId: z.string(),
          label: z.string(),
          draftCredits: z.number().nullable(),
          finalCredits: z.number().nullable()
        })
      ),
      totalDraft: z.number(),
      totalFinal: z.number()
    })
  },
  /** Re-runs every draft-selected node on the real models (draft substitution
   *  bypassed for these runs; draft mode itself stays on for exploration). */
  'generations:finalizeVideo': {
    input: z.object({ videoId: z.string() }),
    output: z.object({
      succeeded: z.number().int().min(0),
      failed: z.number().int().min(0),
      generations: z.record(z.string(), z.string())
    })
  },
  /** §6.2 — run (or re-run) the vision QC on one successful generation. */
  'generations:reviewGeneration': {
    input: z.object({ generationId: z.string() }),
    output: z.object({ verdict: qcVerdictSchema, notes: z.string() })
  },
  /** Estimated credits spent + attempt count across a whole project. */
  'projects:creditsUsage': {
    input: z.object({ projectId: z.string() }),
    output: z.object({ estimatedCredits: z.number(), generationCount: z.number() })
  },
  /** Remaining kie.ai account credits (live query against the kie API). */
  'kie:credits': {
    input: z.void(),
    output: z.object({ credits: z.number() })
  },
  'ai:refineImagePrompt': {
    input: z.object({
      currentPrompt: z.string(),
      imageUrl: z.string(),
      instruction: z.string()
    }),
    output: z.object({ prompt: z.string() })
  },
  'assets:promoteGeneration': {
    input: z.object({
      generationId: z.string(),
      name: z.string().trim().min(1),
      description: z.string().optional()
    }),
    output: assetWithUrlSchema
  },
  'settings:localApiInfo': {
    input: z.void(),
    output: z.object({
      running: z.boolean(),
      url: z.string().nullable(),
      token: z.string()
    })
  },
  'settings:setKieApiKey': { input: z.object({ key: z.string() }), output: z.void() },
  'settings:getGenerationConcurrency': { input: z.void(), output: z.number() },
  'settings:setGenerationConcurrency': {
    input: z.object({ value: z.number().int().min(1).max(8) }),
    output: z.void()
  },
  'settings:kieApiKeyStatus': {
    input: z.void(),
    output: z.object({ configured: z.boolean(), encryptionAvailable: z.boolean() })
  },
  /** Live validation of the stored kie key (cheap authenticated balance call). */
  'settings:testKieApiKey': {
    input: z.void(),
    output: z.object({ status: z.enum(['ok', 'unauthorized', 'network', 'missing']) })
  },
  'settings:getOnboardingCompleted': { input: z.void(), output: z.boolean() },
  'settings:setOnboardingCompleted': { input: z.void(), output: z.void() },
  'settings:getNotifyOnCompletion': { input: z.void(), output: z.boolean() },
  'settings:setNotifyOnCompletion': {
    input: z.object({ enabled: z.boolean() }),
    output: z.void()
  },
  'settings:getAssistantModel': { input: z.void(), output: assistantModelSchema },
  'settings:setAssistantModel': {
    input: z.object({ model: assistantModelSchema }),
    output: z.void()
  },
  'settings:getAssistantRunApproval': { input: z.void(), output: assistantRunApprovalSchema },
  'settings:setAssistantRunApproval': {
    input: z.object({ mode: assistantRunApprovalSchema }),
    output: z.void()
  },

  'settings:getUpdateChannel': { input: z.void(), output: updateChannelSchema },
  'settings:setUpdateChannel': {
    input: z.object({ channel: updateChannelSchema }),
    output: z.void()
  },

  // Auto-update (electron-updater). 'unsupported' = dev build, no feed.
  'update:getState': { input: z.void(), output: updateStateSchema },
  'update:check': { input: z.void(), output: updateStateSchema },
  'update:install': { input: z.void(), output: z.void() },

  // Full-app backup (.raccord = db + media). Outputs are nullable: null means
  // the user cancelled the native file dialog.
  'backup:export': {
    input: z.void(),
    output: z.object({ path: z.string(), files: z.number(), bytes: z.number() }).nullable()
  },
  // On success the main process relaunches the app right after responding.
  'backup:import': {
    input: z.void(),
    output: z.object({ mediaFiles: z.number() }).nullable()
  },

  // Rendered MP4 export of the timeline (ffmpeg in main). Output is nullable:
  // null means the user cancelled the native save dialog. Progress is pushed
  // via event:renderProgress; the promise resolves when the file is written.
  'render:export': {
    input: z.object({
      videoId: z.string(),
      // Optional overrides — default: probed from the first clip.
      fps: z.number().int().min(1).max(120).optional(),
      resolution: z
        .object({ width: z.number().int().min(2), height: z.number().int().min(2) })
        .optional()
    }),
    output: z
      .object({
        path: z.string(),
        durationSeconds: z.number(),
        /** Labels of timeline slots that had no usable media and were skipped. */
        skipped: z.array(z.string())
      })
      .nullable()
  },
  // Resolves true if a render was in flight and got cancelled.
  'render:cancel': { input: z.object({ videoId: z.string() }), output: z.boolean() },

  'chat:get': { input: z.object({ threadId: z.string() }), output: chatStateSchema },
  'chat:send': {
    input: z.object({
      threadId: z.string(),
      projectId: z.string().optional(),
      text: z.string().trim().min(1),
      images: z.array(chatImageSchema).max(4).optional(),
      context: appContextSchema.optional()
    }),
    output: chatStateSchema
  },
  /** Empties a thread's transcript, keeping the thread. */
  'chat:clear': { input: z.object({ threadId: z.string() }), output: z.void() },
  /** Conversation threads for the sidebar switcher, most recent first. */
  'chat:listThreads': {
    input: z.void(),
    output: z.array(
      z.object({
        id: z.string(),
        title: z.string().nullable(),
        projectId: z.string(),
        videoId: z.string().nullable(),
        videoName: z.string().nullable(),
        createdAt: z.number(),
        updatedAt: z.number()
      })
    )
  },
  /** Opens an empty conversation; returns its id. */
  'chat:newThread': {
    input: z.object({ projectId: z.string().optional() }),
    output: z.object({ threadId: z.string() })
  },
  'chat:renameThread': {
    input: z.object({ threadId: z.string(), title: z.string().trim().min(1).max(120) }),
    output: z.void()
  },
  'chat:deleteThread': { input: z.object({ threadId: z.string() }), output: z.void() },
  /** Assistant capabilities for the chat input's "/" action menu — name +
   *  first sentence of the tool description (product data, English). */
  'chat:listTools': {
    input: z.void(),
    output: z.array(z.object({ name: z.string(), description: z.string() }))
  }
} as const satisfies Record<string, { input: z.ZodType; output: z.ZodType }>

/** Main→renderer push events the preload is allowed to subscribe to. */
export const ipcEvents = [
  'event:generationsChanged',
  'event:workflowChanged',
  'event:chatUpdate',
  'event:creditsChanged',
  'event:renderProgress',
  'event:queueChanged',
  'event:focusNode',
  'event:navigate'
] as const
export type IpcEvent = (typeof ipcEvents)[number]

export interface GenerationsChangedPayload {
  videoId: string
  nodeId: string
}

/** Clicking a completion notification asks the editor to center this node. */
export interface FocusNodePayload {
  videoId: string
  nodeId: string
}

/** The assistant (open_video tool) asks the app to navigate to a route. */
export interface NavigatePayload {
  path: string
}

/** Progress of an MP4 render. One terminal event is always sent: done or error. */
export interface RenderProgressPayload {
  videoId: string
  /** 0–100 across the whole pipeline (probe → normalize → concat → mux). */
  percent: number
  step: 'probe' | 'normalize' | 'concat' | 'mux'
  done?: boolean
  /** Set on the terminal event when the render failed (or was cancelled). */
  error?: string
}

export type IpcContracts = typeof ipcContracts
export type IpcChannel = keyof IpcContracts
export type IpcInput<C extends IpcChannel> = z.infer<IpcContracts[C]['input']>
export type IpcOutput<C extends IpcChannel> = z.infer<IpcContracts[C]['output']>

export const ipcChannels = Object.keys(ipcContracts) as IpcChannel[]

export function isIpcChannel(channel: string): channel is IpcChannel {
  return channel in ipcContracts
}
