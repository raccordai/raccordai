import { app } from 'electron'
import { MODELS } from '@shared/models'
import * as generations from '../../services/generations'
import { getChanges } from '../../services/changeFeed'
import { kieGetCredits } from '../../services/kie'
import { queueState } from '../../services/runEngine'
import { searchAll, SEARCH_HIT_TYPES, type SearchHitType } from '../../services/search'
import { elevenLabsKeyStatus, kieApiKeyStatus, nicheKeysStatus } from '../../services/settings'
import { DOC_TOPICS, getDoc } from '../docs'
import { obj, str, type AgentTool } from './types'

/** Documentation, account status and app-wide search. */
export const platformTools: AgentTool[] = [
  // ── Documentation (call this first) ────────────────────────────────────────
  {
    name: 'docs',
    description: `Raccord reference documentation, on demand. Topics: ${DOC_TOPICS}. Start with "overview"; read "prompting:<model id>" BEFORE writing prompts for a model.`,
    inputSchema: obj({ topic: str() }, ['topic']),
    scope: 'global',
    risk: 'read',
    execute: ({ topic }) => getDoc(String(topic))
  },
  {
    name: 'list_models',
    description:
      'List every available AI model: id, kind, use-case tags, input handles (name, accepted media, required, reference alias) and parameter fields. Call this before choosing model ids or param names.',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: () =>
      MODELS.map((m) => ({
        id: m.id,
        kind: m.kind,
        label: m.label,
        description: m.description,
        // Declarative use-case tags — match them against the user's brief.
        recommendedFor: m.recommendedFor,
        inputs: m.inputs.map((h) => ({
          key: h.key,
          accepts: h.accepts,
          required: h.required ?? false,
          multiple: h.multiple ?? false,
          maxCount: h.maxCount,
          // Combined-length budget across the handle (Seedance 2: 15 s).
          maxTotalSeconds: h.maxTotalSeconds,
          // The frame-anchor vs reference distinction, machine-readable.
          frameAnchor: h.frameAnchor ?? false,
          referenceAlias: h.referenceAlias
        })),
        outputs: m.outputs.map((o) => o.key),
        paramFields: m.paramFields.map((f) => ({
          key: f.key,
          type: f.type,
          default: f.defaultValue,
          options: f.options?.map((o) => o.value),
          // Numeric bounds are a hard API contract (a Seedance clip cannot be
          // shorter than 4 s) — without them here an agent has no way to know.
          min: f.min,
          max: f.max,
          step: f.step,
          description: f.description
        })),
        promptingNotes: m.promptingNotes,
        // Cheap stand-in used automatically when the video is in draft mode.
        draftEquivalent: m.draftEquivalent?.modelId,
        // Long-form guide served on demand — read it before writing prompts.
        promptGuideTopic: m.promptGuide ? `prompting:${m.id}` : undefined
      }))
  },

  // ── Account ────────────────────────────────────────────────────────────────
  {
    name: 'get_changes',
    description:
      'Change feed with a cursor: pass the previous call’s latestSeq as `since` to get only what moved — workflow, generations, queue, credits, render progress, niches, voice personas — with videoId/nodeId when applicable. `gapped: true` means the buffer rotated past your cursor: do one full re-read (get_workflow / get_generations) instead. Per app run; a restart resets the sequence.',
    inputSchema: obj({
      since: {
        type: 'number',
        description: 'The latestSeq of your previous call (omit to subscribe from now).'
      },
      limit: { type: 'number', description: 'Max events (default 200, max 500).' }
    }),
    scope: 'global',
    risk: 'read',
    execute: ({ since, limit }) =>
      getChanges(
        typeof since === 'number' ? since : undefined,
        typeof limit === 'number' ? limit : undefined
      )
  },
  {
    name: 'get_credits',
    description: 'Remaining kie.ai account credits (each generation consumes some).',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: async () => ({ credits: await kieGetCredits() })
  },
  {
    name: 'get_app_status',
    description:
      'App health for agents: version, which integrations are configured (kie.ai, ElevenLabs, YouTube, DataForSEO — booleans only, never key values), the generation concurrency limit and the queue occupancy. Read it FIRST when runs fail unexpectedly — a missing key explains more than a stack trace.',
    inputSchema: obj({}),
    scope: 'global',
    risk: 'read',
    execute: () => {
      const queue = queueState()
      return {
        appVersion: app.getVersion(),
        kieConfigured: kieApiKeyStatus().configured,
        elevenLabsConfigured: elevenLabsKeyStatus().configured,
        ...nicheKeysStatus(),
        maxConcurrentGenerations: queue.limit,
        queue: { running: queue.running.length, queued: queue.queued.length }
      }
    }
  },
  {
    name: 'project_credits_usage',
    description: 'Estimated kie.ai credits already spent by a project’s generations.',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId }) => generations.projectCreditsUsage(String(projectId))
  },
  {
    name: 'search',
    description:
      'Search the whole app in one call — project/video names, node labels and prompts, assets, castings, feedback notes, roadmap items, niche video titles/transcripts, voice personas. Returns typed hits with ids and a snippet around the match. Case-insensitive (ASCII); accents are not folded.',
    inputSchema: obj(
      {
        query: str('At least 2 characters.'),
        types: {
          type: 'array',
          items: { type: 'string', enum: [...SEARCH_HIT_TYPES] },
          description: 'Restrict to these hit types (default: all).'
        },
        limit_per_type: { type: 'number', description: 'Max hits per type (default 10, max 50).' }
      },
      ['query']
    ),
    scope: 'global',
    risk: 'read',
    execute: ({ query, types, limit_per_type }) =>
      searchAll(String(query), {
        ...(Array.isArray(types)
          ? {
              types: types.filter((t): t is SearchHitType =>
                (SEARCH_HIT_TYPES as string[]).includes(String(t))
              )
            }
          : {}),
        ...(typeof limit_per_type === 'number' ? { limitPerType: limit_per_type } : {})
      })
  }
]
