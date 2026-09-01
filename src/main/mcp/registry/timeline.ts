import { CLIP_LOOK_IDS } from '@shared/looks'
import { STILL_MOTION_IDS } from '@shared/stillMotion'
import { TEXT_ANIMATION_IDS, isTextAnimationId } from '@shared/textAnimations'
import { CLIP_TRANSITION_IDS } from '@shared/transitions'
import {
  createFeedbackItem,
  deleteFeedbackItem,
  listFeedback,
  updateFeedbackItem
} from '../../services/feedback'
import * as graph from '../../services/graph'
import {
  createImageLayer,
  deleteImageLayer,
  listImageLayers,
  updateImageLayer
} from '../../services/imageLayers'
import { timelineContactSheet, timelineFrame } from '../../services/mediaPreview'
import {
  createTextLayer,
  deleteTextLayer,
  listTextLayers,
  updateTextLayer
} from '../../services/textLayers'
import { getTimelineInfo } from '../../services/timelineInfo'
import { obj, str, type AgentTool } from './types'

/** Timeline editing: order, trims, splits, per-clip effects, layers, feedback. */
export const timelineTools: AgentTool[] = [
  {
    name: 'get_timeline',
    description:
      'The RESOLVED timeline in FINAL-timeline seconds (media probed for real durations): each clip entry’s start/end/duration (trims, speed and transition overlaps applied), the film’s totalSeconds, and the music/speech lanes with each track’s computed start. This is how you know where shot N starts before syncing audio with set_audio_offset or placing text/image layers.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => getTimelineInfo(String(videoId))
  },
  {
    name: 'get_frame_at',
    description:
      'SEE the final timeline at a timecode: returns the frame under at_sec (trims, speed and transition overlaps applied) as inline image content, plus which clip it lands in. Use it to check a cut, a text/sticker placement or a feedback item’s timecode.',
    inputSchema: obj({ videoId: str(), at_sec: { type: 'number' } }, ['videoId', 'at_sec']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId, at_sec }) => timelineFrame(String(videoId), Number(at_sec))
  },
  {
    name: 'get_timeline_contact_sheet',
    description:
      'Watch the film at a glance: one small frame per timeline entry (its midpoint, in cut order) as inline images, with each entry’s timecodes in the text part. The cheapest way to spot a broken shot, a wrong order or a continuity break before rendering. Entries without local media are listed as missing.',
    inputSchema: obj(
      {
        videoId: str(),
        max_entries: { type: 'number', description: 'Frames to include (default 12, max 16).' }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId, max_entries }) =>
      timelineContactSheet(String(videoId), {
        ...(typeof max_entries === 'number' ? { maxEntries: max_entries } : {})
      })
  },
  {
    name: 'set_timeline_order',
    description:
      'Set the timeline order of a video’s clips explicitly (one undo step). Pass ALL clip node ids in the desired sequence — playback, FCPXML and MP4 render follow it. Image/asset node ids may be included: image assets become STILL slots (duration = trim window) while a VIDEO asset plays as a real clip (docs "timeline"); an image or asset node left out of the list is removed from the timeline.',
    inputSchema: obj(
      {
        videoId: str(),
        nodeIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Every video clip node id, in timeline order.'
        }
      },
      ['videoId', 'nodeIds']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, nodeIds }) => {
      graph.setTimelineOrder(String(videoId), (Array.isArray(nodeIds) ? nodeIds : []).map(String))
      return { ok: true }
    }
  },
  {
    name: 'set_clip_trim',
    description:
      'Trim a clip on the timeline: in/out points in seconds within its media (null clears a bound). Applies to playback, FCPXML and the MP4 render — the generation itself is untouched, so a trim is always reversible. Works on audio nodes too, and on a STILL slot the window IS its hold time (e.g. trimEndSec 8 = 8 s on screen).',
    inputSchema: obj(
      {
        nodeId: str(),
        trimStartSec: { type: ['number', 'null'], description: 'In-point (≥ 0), null = start' },
        trimEndSec: { type: ['number', 'null'], description: 'Out-point (> in), null = end' },
        segmentIndex: {
          type: 'number',
          description: 'On a SPLIT clip: which segment to trim (see get_workflow segments)'
        }
      },
      ['nodeId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, trimStartSec, trimEndSec, segmentIndex }) => {
      graph.setClipTrim(
        String(nodeId),
        {
          trimStartSec: trimStartSec == null ? null : Number(trimStartSec),
          trimEndSec: trimEndSec == null ? null : Number(trimEndSec)
        },
        segmentIndex == null ? undefined : Number(segmentIndex)
      )
      return { ok: true }
    }
  },
  {
    name: 'split_clip',
    description:
      'Razor: cut a video clip in two at a MEDIA-time point (seconds inside the clip’s media, ≥0.2 s from each edge). The halves stay adjacent, each with its own trim/transition (see get_workflow segments; edit them via set_clip_trim/set_clip_transition with segmentIndex). One undo step.',
    inputSchema: obj(
      {
        nodeId: str(),
        atMediaSec: { type: 'number', description: 'Cut point in MEDIA seconds' }
      },
      ['nodeId', 'atMediaSec']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, atMediaSec }) => {
      graph.splitClip(String(nodeId), Number(atMediaSec))
      return { ok: true }
    }
  },
  {
    name: 'remove_clip_segment',
    description:
      'Remove ONE segment of a split clip (e.g. cut out the middle after two split_clip calls). The last two segments collapse back into a plain clip. The node and its generations are untouched.',
    inputSchema: obj(
      {
        nodeId: str(),
        segmentIndex: { type: 'number', description: '0-based segment to remove' }
      },
      ['nodeId', 'segmentIndex']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, segmentIndex }) => {
      graph.removeClipSegment(String(nodeId), Number(segmentIndex))
      return { ok: true }
    }
  },
  {
    name: 'set_clip_transition',
    description:
      'Set the transition from a clip INTO the next one at render time, or null for a plain cut (the default and the doctrine’s preference). Each transition overlaps the two clips by durationSec (default 0.5 s) and shortens the film accordingly. The library ids are the `transition` enum values.',
    inputSchema: obj(
      {
        nodeId: str(),
        transition: { type: ['string', 'null'], enum: [...CLIP_TRANSITION_IDS, null] },
        durationSec: { type: 'number', description: 'Overlap length, 0.1–2 s (default 0.5)' },
        segmentIndex: {
          type: 'number',
          description: 'On a SPLIT clip: which segment’s outgoing cut (default: the last)'
        }
      },
      ['nodeId']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, transition, durationSec, segmentIndex }) => {
      graph.setClipTransition(
        String(nodeId),
        transition == null ? null : String(transition),
        durationSec == null ? null : Number(durationSec),
        segmentIndex == null ? undefined : Number(segmentIndex)
      )
      return { ok: true }
    }
  },
  {
    name: 'set_clip_overlay',
    description:
      'Burn a text layer over a clip at render time (title card, caption, credit): text + numpad alignment (1–9, e.g. 8 = top center, 2 = bottom center) + size (sm/md/lg). Null clears it. Preview shows it in the timeline player.',
    inputSchema: obj(
      {
        nodeId: str(),
        overlay: {
          type: ['object', 'null'],
          properties: {
            text: { type: 'string' },
            align: { type: 'number', description: 'ASS numpad alignment 1–9' },
            size: { type: 'string', enum: ['sm', 'md', 'lg'] }
          },
          required: ['text', 'align', 'size']
        }
      },
      ['nodeId', 'overlay']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, overlay }) => {
      const o = overlay as { text?: unknown; align?: unknown; size?: unknown } | null
      graph.setClipOverlay(
        String(nodeId),
        o == null
          ? null
          : {
              text: String(o.text ?? ''),
              align: Math.min(9, Math.max(1, Number(o.align ?? 2))),
              size: o.size === 'sm' || o.size === 'lg' ? o.size : 'md'
            }
      )
      return { ok: true }
    }
  },
  {
    name: 'set_clip_volume',
    description:
      'Volume gain of an audio track on the timeline (music/speech lanes): 1 = original, 0–2 (e.g. 0.5 = half, 2 = double). Null resets. Applies to the preview player and the MP4 render (per-track ffmpeg volume).',
    inputSchema: obj(
      {
        nodeId: str(),
        volume: { type: ['number', 'null'], description: 'Gain 0–2, null = original (1)' }
      },
      ['nodeId', 'volume']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, volume }) => {
      graph.setClipVolume(String(nodeId), volume == null ? null : Number(volume))
      return { ok: true }
    }
  },
  {
    name: 'set_clip_speed',
    description:
      'Playback speed of a video clip on the timeline: 1 = original, 0.25–4 (0.5 = slow motion, 2 = twice as fast). Null resets. The rendered slot lasts trimmed duration ÷ speed; audio follows (pitch-corrected atempo). Preview plays at the same rate.',
    inputSchema: obj(
      {
        nodeId: str(),
        speed: { type: ['number', 'null'], description: 'Factor 0.25–4, null = original (1)' }
      },
      ['nodeId', 'speed']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, speed }) => {
      graph.setClipSpeed(String(nodeId), speed == null ? null : Number(speed))
      return { ok: true }
    }
  },
  {
    name: 'set_clip_look',
    description:
      'Colour look baked on a clip at render time (the `look` enum lists the library: warm, cool, faded, vivid, mono, noir, vintage). Null removes it. The timeline player previews a CSS approximation live.',
    inputSchema: obj(
      {
        nodeId: str(),
        look: { type: ['string', 'null'], enum: [...CLIP_LOOK_IDS, null] }
      },
      ['nodeId', 'look']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, look }) => {
      graph.setClipLook(String(nodeId), look == null ? null : String(look))
      return { ok: true }
    }
  },
  {
    name: 'set_still_motion',
    description:
      'Ken Burns motion on a STILL timeline slot (image node or image asset placed via set_timeline_order — never a video asset): zoom-in, zoom-out, pan-left or pan-right instead of a frozen frame. Null = static. Applied at render (zoompan).',
    inputSchema: obj(
      {
        nodeId: str(),
        motion: { type: ['string', 'null'], enum: [...STILL_MOTION_IDS, null] }
      },
      ['nodeId', 'motion']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, motion }) => {
      graph.setStillMotion(String(nodeId), motion == null ? null : String(motion))
      return { ok: true }
    }
  },
  {
    name: 'set_audio_offset',
    description:
      'Absolute start of an AUDIO track on the final timeline (seconds). Null restores the default layout (chained after the previous lane track). Overlapping tracks of a lane simply mix. Preview and MP4 render follow the same placement. Read get_timeline first for where the clips start (docs "timeline" for the sync method).',
    inputSchema: obj(
      {
        nodeId: str(),
        offsetSec: { type: ['number', 'null'], description: 'Start in seconds (≥ 0), null = chain' }
      },
      ['nodeId', 'offsetSec']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ nodeId, offsetSec }) => {
      graph.setTimelineOffset(String(nodeId), offsetSec == null ? null : Number(offsetSec))
      return { ok: true }
    }
  },
  {
    name: 'list_image_layers',
    description:
      'The video’s sticker track: image overlays composited over the film at render time — timing (absolute FINAL-timeline seconds), normalized center position, width as % of the output width, and the image source (an image node’s output or a project asset).',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => listImageLayers(String(videoId))
  },
  {
    name: 'add_image_layer',
    description:
      'Add a sticker (image overlay) to the video: pass nodeId (an image node — its best generation is composited) OR assetId (a project asset), never both. Position is the sticker’s CENTER (x/y normalized 0–1); widthPct sizes it as % of the output width.',
    inputSchema: obj(
      {
        videoId: str(),
        nodeId: str('Image node id (exactly one of nodeId/assetId)'),
        assetId: str('Project asset id (exactly one of nodeId/assetId)'),
        startSec: { type: 'number', description: 'Start, in FINAL-timeline seconds' },
        endSec: { type: 'number', description: 'End, in FINAL-timeline seconds (> start)' },
        x: { type: 'number', description: 'Center x, 0–1 (default 0.5)' },
        y: { type: 'number', description: 'Center y, 0–1 (default 0.5)' },
        widthPct: { type: 'number', description: '% of output width, 1–100 (default 25)' }
      },
      ['videoId', 'startSec', 'endSec']
    ),
    scope: 'video',
    risk: 'write',
    execute: (args) =>
      createImageLayer({
        videoId: String(args['videoId']),
        startSec: Number(args['startSec']),
        endSec: Number(args['endSec']),
        ...(args['nodeId'] !== undefined ? { nodeId: String(args['nodeId']) } : {}),
        ...(args['assetId'] !== undefined ? { assetId: String(args['assetId']) } : {}),
        ...(args['x'] !== undefined ? { x: Number(args['x']) } : {}),
        ...(args['y'] !== undefined ? { y: Number(args['y']) } : {}),
        ...(args['widthPct'] !== undefined ? { widthPct: Number(args['widthPct']) } : {})
      })
  },
  {
    name: 'update_image_layer',
    description:
      'Update a sticker’s timing, position or size (list_image_layers gives the ids). The image source is fixed — delete and re-add to change it.',
    inputSchema: obj(
      {
        layerId: str(),
        patch: {
          type: 'object',
          description: 'Fields to change: startSec, endSec, x, y, widthPct'
        }
      },
      ['layerId', 'patch']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ layerId, patch }) =>
      updateImageLayer(String(layerId), (patch ?? {}) as Record<string, never>)
  },
  {
    name: 'delete_image_layer',
    description: 'Remove a sticker from the timeline (easily recreated with add_image_layer).',
    inputSchema: obj({ layerId: str() }, ['layerId']),
    scope: 'global',
    risk: 'write',
    execute: ({ layerId }) => {
      deleteImageLayer(String(layerId))
      return { ok: true }
    }
  },
  {
    name: 'list_text_layers',
    description:
      'The video’s title track: free text layers (titles, captions, credits) with their timing (absolute seconds on the FINAL timeline), frame position (normalized x/y + numpad anchor) and typography. Burned at render.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => listTextLayers(String(videoId))
  },
  {
    name: 'add_text_layer',
    description:
      'Add a text layer to the video’s title track. Position is normalized (x/y in 0–1, anchor = ASS numpad 1–9 saying which point of the text sits on x/y); sizePct is % of the output height; colorHex is #RRGGBB; fontFamily is a system font name (null = default sans).',
    inputSchema: obj(
      {
        videoId: str(),
        content: str('The text (max 500 chars)'),
        startSec: { type: 'number', description: 'Start, in FINAL-timeline seconds' },
        endSec: { type: 'number', description: 'End, in FINAL-timeline seconds (> start)' },
        x: { type: 'number', description: '0–1, default 0.5' },
        y: { type: 'number', description: '0–1, default 0.5' },
        anchor: { type: 'number', description: 'Numpad 1–9, default 5 (centered on x/y)' },
        fontFamily: { type: 'string', description: 'e.g. "Georgia", "Futura", "Impact"' },
        sizePct: { type: 'number', description: '% of output height, 1–30 (default 6)' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        colorHex: { type: 'string', description: '#RRGGBB (default #ffffff)' },
        animation: {
          type: 'string',
          enum: [...TEXT_ANIMATION_IDS],
          description: 'Entrance animation (fade, pop, slide-up); omit for static'
        }
      },
      ['videoId', 'content', 'startSec', 'endSec']
    ),
    scope: 'video',
    risk: 'write',
    execute: (args) =>
      createTextLayer({
        videoId: String(args['videoId']),
        content: String(args['content']),
        startSec: Number(args['startSec']),
        endSec: Number(args['endSec']),
        ...(args['x'] !== undefined ? { x: Number(args['x']) } : {}),
        ...(args['y'] !== undefined ? { y: Number(args['y']) } : {}),
        ...(args['anchor'] !== undefined ? { anchor: Number(args['anchor']) } : {}),
        ...(args['fontFamily'] !== undefined ? { fontFamily: String(args['fontFamily']) } : {}),
        ...(args['sizePct'] !== undefined ? { sizePct: Number(args['sizePct']) } : {}),
        ...(args['bold'] !== undefined ? { bold: Boolean(args['bold']) } : {}),
        ...(args['italic'] !== undefined ? { italic: Boolean(args['italic']) } : {}),
        ...(args['colorHex'] !== undefined ? { colorHex: String(args['colorHex']) } : {}),
        ...(isTextAnimationId(args['animation']) ? { animation: args['animation'] } : {})
      })
  },
  {
    name: 'update_text_layer',
    description:
      'Update any fields of a text layer (list_text_layers gives the ids): content, timing, position, anchor, font, size, bold/italic, colour.',
    inputSchema: obj(
      {
        layerId: str(),
        patch: {
          type: 'object',
          description:
            'Fields to change: content, startSec, endSec, x, y, anchor, fontFamily, sizePct, bold, italic, colorHex, animation (fade | pop | slide-up | null)'
        }
      },
      ['layerId', 'patch']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ layerId, patch }) =>
      updateTextLayer(String(layerId), (patch ?? {}) as Record<string, never>)
  },
  {
    name: 'delete_text_layer',
    description: 'Remove a text layer from the title track (easily recreated with add_text_layer).',
    inputSchema: obj({ layerId: str() }, ['layerId']),
    scope: 'global',
    risk: 'write',
    execute: ({ layerId }) => {
      deleteTextLayer(String(layerId))
      return { ok: true }
    }
  },
  {
    name: 'list_feedback',
    description:
      'The video’s feedback bucket: review notes the user took while watching the timeline. Each item has a comment, a status (open | done), and usually a FINAL-timeline timecodeSec + the node (id + label snapshot) under the playhead. Work through the open items, then mark each one done with update_feedback.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId }) => listFeedback(String(videoId))
  },
  {
    name: 'add_feedback',
    description:
      'Add a note to the video’s feedback bucket (e.g. a follow-up the user asked for). timecodeSec is in FINAL-timeline seconds; nodeId/nodeLabel anchor the note to the shot it is about.',
    inputSchema: obj(
      {
        videoId: str(),
        comment: str('The note (max 2000 chars)'),
        timecodeSec: {
          type: 'number',
          description: 'FINAL-timeline seconds; omit for a general note'
        },
        nodeId: str('Node the note is about'),
        nodeLabel: str('Display name of that node at note time')
      },
      ['videoId', 'comment']
    ),
    scope: 'video',
    risk: 'write',
    execute: (args) =>
      createFeedbackItem({
        videoId: String(args['videoId']),
        comment: String(args['comment']),
        ...(args['timecodeSec'] !== undefined ? { timecodeSec: Number(args['timecodeSec']) } : {}),
        ...(args['nodeId'] !== undefined ? { nodeId: String(args['nodeId']) } : {}),
        ...(args['nodeLabel'] !== undefined ? { nodeLabel: String(args['nodeLabel']) } : {})
      })
  },
  {
    name: 'update_feedback',
    description:
      'Update a feedback item (list_feedback gives the ids) — set status to "done" once a note has been addressed, or amend comment/timecodeSec.',
    inputSchema: obj(
      {
        feedbackId: str(),
        patch: {
          type: 'object',
          description:
            'Fields to change: status ("open" | "done"), comment, timecodeSec, nodeId, nodeLabel'
        }
      },
      ['feedbackId', 'patch']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ feedbackId, patch }) =>
      updateFeedbackItem(String(feedbackId), (patch ?? {}) as Record<string, never>)
  },
  {
    name: 'delete_feedback',
    description:
      'Delete a feedback item. A user note is unrecoverable once deleted — prefer marking it done with update_feedback.',
    inputSchema: obj({ feedbackId: str() }, ['feedbackId']),
    scope: 'global',
    risk: 'destructive',
    execute: ({ feedbackId }) => {
      deleteFeedbackItem(String(feedbackId))
      return { ok: true }
    }
  }
]
