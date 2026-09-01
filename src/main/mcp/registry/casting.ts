import { formatTranscript, type SpeechTranscript } from '@shared/speech'
import {
  castRole,
  createCasting,
  deleteCasting,
  listCastings,
  planCastRole,
  updateCasting
} from '../../services/casting'
import { linkShots, planLinkShots } from '../../services/continuity'
import { elevenlabsListVoices } from '../../services/elevenlabs'
import * as generations from '../../services/generations'
import {
  createVoicePersona,
  deleteVoicePersona,
  listVoicePersonas,
  updateVoicePersona
} from '../../services/voicePersonas'
import { obj, str, type AgentTool } from './types'

/** Identity across shots: continuity chains, the cast, and the voice cast (§8). */
export const castingTools: AgentTool[] = [
  {
    name: 'link_shots',
    description:
      'Chain shots for continuity: each clip becomes an @Video reference on the NEXT shot (same look, wardrobe, set, grade), role sentence appended to its prompt, one undo step. It serializes the batch and a re-roll invalidates the shots after it — propose it, never apply it by default. Cuts it cannot wire come back in "skipped". NOT lastFrame chaining. Details: docs "continuity".',
    inputSchema: obj(
      {
        videoId: str(),
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Video shot node ids IN TIMELINE ORDER (at least two).'
        },
        plan_only: {
          type: 'boolean',
          description: 'Dry run: report what would be chained without touching the graph.'
        }
      },
      ['videoId', 'nodeIds']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, nodeIds, plan_only }) => {
      const ids = (Array.isArray(nodeIds) ? nodeIds : []).map(String)
      return plan_only === true
        ? planLinkShots(String(videoId), ids)
        : linkShots(String(videoId), ids)
    }
  },
  {
    name: 'list_castings',
    description:
      'The project’s cast: the named identities of the film ("Léa" = this published sheet) with their subject and standing notes. Check it BEFORE generating a sheet for a character/décor/prop that already has a role.',
    inputSchema: obj({ projectId: str() }, ['projectId']),
    scope: 'project',
    risk: 'read',
    execute: ({ projectId }) =>
      listCastings(String(projectId)).map((c) => ({
        id: c.id,
        name: c.name,
        assetId: c.assetId,
        sheet: c.assetName,
        designId: c.designId,
        subject: c.designSubject,
        notes: c.notes
      }))
  },
  {
    name: 'create_casting',
    description:
      'Name a published design sheet as a role of the film ("Léa is this character sheet"), project-wide. Do it once the user approves a sheet — the name is what later prompts carry. Notes are standing direction folded into every role sentence.',
    inputSchema: obj(
      {
        projectId: str(),
        name: str('The name the film calls this role, e.g. "Léa" — unique in the project.'),
        assetId: str('A published design sheet of the project (image asset).'),
        notes: str('Standing direction, e.g. "always wears the red scarf".')
      },
      ['projectId', 'name', 'assetId']
    ),
    scope: 'project',
    risk: 'write',
    execute: ({ projectId, name, assetId, notes }) =>
      createCasting({
        projectId: String(projectId),
        name: String(name),
        assetId: String(assetId),
        ...(notes !== undefined ? { notes: String(notes) } : {})
      })
  },
  {
    name: 'update_casting',
    description:
      'Rename a role, re-point it at a regenerated sheet, or change its standing notes. Re-pointing does NOT rewire the shots already cast — re-run cast_role for that.',
    inputSchema: obj({ castingId: str(), name: str(), assetId: str(), notes: str() }, [
      'castingId'
    ]),
    scope: 'global',
    risk: 'write',
    execute: ({ castingId, name, assetId, notes }) =>
      updateCasting(String(castingId), {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(assetId !== undefined ? { assetId: String(assetId) } : {}),
        ...(notes !== undefined ? { notes: String(notes) } : {})
      })
  },
  {
    name: 'cast_role',
    description:
      'Cast a role onto a video: its sheet is wired as a reference on every shot and its identity sentence written into each prompt, in ONE undo step. Idempotent — a second call reports "alreadyCast" instead of double-wiring. Shots it cannot wire come back in "skipped". Pass plan_only first to show the user what it would touch. Details: docs "casting".',
    inputSchema: obj(
      {
        videoId: str(),
        castingId: str(),
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Defaults to every shot of the video. Name stills explicitly (a storyboard).'
        },
        plan_only: {
          type: 'boolean',
          description: 'Dry run: report what would be wired without touching the graph.'
        }
      },
      ['videoId', 'castingId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, castingId, nodeIds, plan_only }) => {
      const args = {
        videoId: String(videoId),
        castingId: String(castingId),
        ...(Array.isArray(nodeIds) ? { nodeIds: nodeIds.map(String) } : {})
      }
      return plan_only === true ? planCastRole(args) : castRole(args)
    }
  },
  {
    name: 'remove_casting',
    description:
      'Forget a role. Shots already cast keep their reference and their prompt — this only removes the name from the project’s cast.',
    inputSchema: obj({ castingId: str() }, ['castingId']),
    scope: 'global',
    risk: 'write',
    execute: ({ castingId }) => {
      deleteCasting(String(castingId))
      return { ok: true }
    }
  },
  // ── Speech (§8): ElevenLabs voices + the channel's voice personas ─────────
  {
    name: 'list_voice_personas',
    description:
      'The channel’s named voice identities ("Narrateur" = this ElevenLabs voice id), app-wide, optionally filtered to one niche. Check it BEFORE writing a speech node’s voice — recurring characters must keep their voice across videos. Details: docs "speech".',
    inputSchema: obj({
      niche_id: str('Only this niche’s personas plus the unpinned ones.')
    }),
    scope: 'global',
    risk: 'read',
    execute: ({ niche_id }) =>
      listVoicePersonas(niche_id !== undefined ? String(niche_id) : undefined)
  },
  {
    name: 'create_voice_persona',
    description:
      'Name an ElevenLabs voice as a persona of the channel ("Narrateur is this voice id"). The name is what dialogue scripts and future videos reuse — one persona per recurring character/narrator.',
    inputSchema: obj(
      {
        name: str('Unique name, e.g. "Narrateur" or "Léa".'),
        voice_id: str('ElevenLabs voice id (custom clone or premade).'),
        description: str('Delivery notes, e.g. "calm, warm, slightly amused".'),
        niche_id: str('Pin the persona to a niche/channel (omit = available everywhere).')
      },
      ['name', 'voice_id']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ name, voice_id, description, niche_id }) =>
      createVoicePersona({
        name: String(name),
        voiceId: String(voice_id),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(niche_id !== undefined ? { nicheId: String(niche_id) } : {})
      })
  },
  {
    name: 'update_voice_persona',
    description:
      'Rename a voice persona, re-point it at another ElevenLabs voice id, or change its notes/niche. Existing speech nodes keep their already-written voice ids.',
    inputSchema: obj(
      {
        persona_id: str(),
        name: str(),
        voice_id: str(),
        description: str(),
        niche_id: str('"" unpins the persona from its niche.')
      },
      ['persona_id']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ persona_id, name, voice_id, description, niche_id }) =>
      updateVoicePersona(String(persona_id), {
        ...(name !== undefined ? { name: String(name) } : {}),
        ...(voice_id !== undefined ? { voiceId: String(voice_id) } : {}),
        ...(description !== undefined ? { description: String(description) } : {}),
        ...(niche_id !== undefined ? { nicheId: String(niche_id) || null } : {})
      })
  },
  {
    name: 'delete_voice_persona',
    description:
      'Forget a voice persona. Speech nodes keep their voice ids — this only removes the name from the channel’s cast of voices.',
    inputSchema: obj({ persona_id: str() }, ['persona_id']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ persona_id }) => {
      deleteVoicePersona(String(persona_id))
      return { ok: true }
    }
  },
  {
    name: 'list_elevenlabs_voices',
    description:
      'Search the ElevenLabs voice library of the configured account (name, category, voice id, preview URL) — the source of ids for voice personas and speech nodes.',
    inputSchema: obj({ search: str('Filter by name/description/labels.') }),
    scope: 'global',
    risk: 'read',
    execute: ({ search }) =>
      elevenlabsListVoices({ ...(search !== undefined ? { search: String(search) } : {}) })
  },
  {
    name: 'get_transcript',
    description:
      'The timed transcript of a speech node’s output: `segments` carry the raw float start/end seconds (MEDIA time of the audio file — the precision sub-second sync with set_audio_offset needs), `formatted` renders them as [m:ss] lines with speaker labels. Pass generation_id for a specific take.',
    inputSchema: obj({ nodeId: str(), generation_id: str('Defaults to the node’s best output.') }, [
      'nodeId'
    ]),
    scope: 'global',
    risk: 'read',
    execute: ({ nodeId, generation_id }) => {
      const rows = generations.listGenerationsForNode(String(nodeId))
      const row =
        generation_id !== undefined
          ? rows.find((g) => g.id === String(generation_id))
          : (rows.find((g) => g.status === 'success' && g.transcript) ?? rows[0])
      if (!row) throw new Error('No generation on this node.')
      const transcript = (row.transcript ?? null) as SpeechTranscript | null
      if (!transcript) {
        throw new Error('No transcript on this generation (only ElevenLabs speech runs carry one).')
      }
      return {
        generationId: row.id,
        text: transcript.text,
        segments: transcript.segments,
        formatted: formatTranscript(transcript)
      }
    }
  }
]
