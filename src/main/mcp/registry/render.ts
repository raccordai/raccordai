import { CAPTION_PRESET_IDS, isCaptionPresetId } from '@shared/captions'
import { exportFcpxmlBundle } from '../../services/fcpxmlExport'
import { exportPublishKit } from '../../services/publishKit'
import * as renderService from '../../services/render'
import { obj, str, type AgentTool } from './types'

/** MP4 render, FCPXML hand-off and the publish kit. */
export const renderTools: AgentTool[] = [
  {
    name: 'render_video',
    description:
      'Render a video’s timeline into a single MP4 file (local ffmpeg, no credits): clips concatenated in shot order, music lane muxed over. Synchronous — returns the output path. Optional fps/resolution override the first clip’s probed spec.',
    inputSchema: obj(
      {
        videoId: str(),
        outputPath: str('Absolute .mp4 destination (default: Downloads folder)'),
        fps: { type: 'number', description: 'Output frame rate (default: probed)' },
        resolution: obj(
          {
            width: { type: 'number' },
            height: { type: 'number' }
          },
          ['width', 'height']
        ),
        burnSubtitles: {
          type: 'boolean',
          description: 'Burn the scenario’s quoted dialogue as subtitles'
        },
        captionsPreset: {
          type: 'string',
          enum: [...CAPTION_PRESET_IDS],
          description:
            'Burn dynamic captions from the speech lane’s transcripts (real ElevenLabs timings): classic line, pop-in, or karaoke word highlight. Omit for none.'
        },
        duckMusic: {
          type: 'boolean',
          description: 'Duck the music bed under the voice-over (transcript-timed windows)'
        },
        quality: {
          type: 'string',
          enum: ['draft', 'standard', 'high'],
          description: 'Encoder quality (default standard)'
        },
        codec: {
          type: 'string',
          enum: ['h264', 'hevc'],
          description: 'Output codec (default h264; hevc = smaller files, forces re-encode)'
        },
        watermarkText: {
          type: 'string',
          description: 'Translucent corner text over the whole film (max 80 chars)'
        },
        watermarkPosition: {
          type: 'string',
          enum: ['top-left', 'top-right', 'bottom-left', 'bottom-right'],
          description: 'Watermark corner (default bottom-right)'
        }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'write',
    execute: async ({
      videoId,
      outputPath,
      fps,
      resolution,
      burnSubtitles,
      captionsPreset,
      duckMusic,
      quality,
      codec,
      watermarkText,
      watermarkPosition
    }) => {
      const target = outputPath
        ? String(outputPath)
        : renderService.defaultOutputPath(String(videoId))
      const res = resolution as { width?: unknown; height?: unknown } | undefined
      const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const
      const corner = corners.find((c) => c === watermarkPosition)
      const { durationSeconds, skipped, cachedArtifacts } = await renderService.renderVideo({
        videoId: String(videoId),
        outputPath: target,
        ...(fps !== undefined ? { fps: Number(fps) } : {}),
        ...(res ? { resolution: { width: Number(res.width), height: Number(res.height) } } : {}),
        ...(burnSubtitles !== undefined ? { burnSubtitles: Boolean(burnSubtitles) } : {}),
        ...(isCaptionPresetId(captionsPreset) ? { captionsPreset } : {}),
        ...(duckMusic !== undefined ? { duckMusic: Boolean(duckMusic) } : {}),
        ...(quality === 'draft' || quality === 'standard' || quality === 'high' ? { quality } : {}),
        ...(codec === 'h264' || codec === 'hevc' ? { codec } : {}),
        ...(watermarkText
          ? { watermark: { text: String(watermarkText), ...(corner ? { position: corner } : {}) } }
          : {})
      })
      return { path: target, durationSeconds, skipped, cachedArtifacts }
    }
  },
  {
    name: 'plan_render',
    description:
      'Free dry run of render_video: per-slot source (video / still / fallback-still / remote / skipped), the sequence spec, lossless-vs-normalize, rendered duration and the audio lanes — the `skipped` list a real render would only reveal after the fact. No download, no ffmpeg run, no credits.',
    inputSchema: obj(
      {
        videoId: str(),
        fps: { type: 'number', description: 'Output frame rate override (default: probed)' },
        resolution: obj({ width: { type: 'number' }, height: { type: 'number' } }, [
          'width',
          'height'
        ]),
        codec: { type: 'string', enum: ['h264', 'hevc'] }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'read',
    execute: ({ videoId, fps, resolution, codec }) => {
      const res = resolution as { width?: unknown; height?: unknown } | undefined
      return renderService.planRender(String(videoId), {
        ...(fps !== undefined ? { fps: Number(fps) } : {}),
        ...(res ? { resolution: { width: Number(res.width), height: Number(res.height) } } : {}),
        ...(codec === 'h264' || codec === 'hevc' ? { codec } : {})
      })
    }
  },
  {
    name: 'export_publish_kit',
    description:
      'Everything needed to upload, in ONE folder: the rendered MP4, the exported thumbnail (the workflow’s thumbnail recipe node) and metadata.md with the roadmap item’s packaging (title, variants, description draft). Default folder: Downloads/<video>-publish. Synchronous render — then upload and close the loop with mark_roadmap_published.',
    inputSchema: obj(
      {
        videoId: str(),
        outputDir: str('Absolute folder (default: Downloads/<video>-publish)'),
        quality: { type: 'string', enum: ['draft', 'standard', 'high'] },
        codec: { type: 'string', enum: ['h264', 'hevc'] },
        captionsPreset: { type: 'string', enum: [...CAPTION_PRESET_IDS] },
        burnSubtitles: { type: 'boolean' },
        duckMusic: { type: 'boolean' }
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, outputDir, quality, codec, captionsPreset, burnSubtitles, duckMusic }) =>
      exportPublishKit(String(videoId), {
        ...(outputDir ? { outputDir: String(outputDir) } : {}),
        ...(quality === 'draft' || quality === 'standard' || quality === 'high' ? { quality } : {}),
        ...(codec === 'h264' || codec === 'hevc' ? { codec } : {}),
        ...(isCaptionPresetId(captionsPreset) ? { captionsPreset } : {}),
        ...(burnSubtitles !== undefined ? { burnSubtitles: Boolean(burnSubtitles) } : {}),
        ...(duckMusic !== undefined ? { duckMusic: Boolean(duckMusic) } : {})
      })
  },
  {
    name: 'export_fcpxml',
    description:
      'Hand the cut to a human editor: writes a folder with <video>.fcpxml (FCPXML 1.8 timeline — trims, both audio lanes, per-track volume) plus its media/ files, ready for Final Cut or DaVinci. Local media only; slots without a usable output become placeholder gaps (returned in `gaps`). Default folder: Downloads/<video>-fcpxml.',
    inputSchema: obj(
      {
        videoId: str(),
        outputDir: str('Absolute folder (default: Downloads/<video>-fcpxml)')
      },
      ['videoId']
    ),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId, outputDir }) =>
      exportFcpxmlBundle(String(videoId), {
        ...(outputDir ? { outputDir: String(outputDir) } : {})
      })
  },
  {
    name: 'cancel_render',
    description: 'Cancel a video’s in-flight MP4 render. Returns whether one was running.',
    inputSchema: obj({ videoId: str() }, ['videoId']),
    scope: 'video',
    risk: 'write',
    execute: ({ videoId }) => ({ cancelled: renderService.cancelRender(String(videoId)) })
  }
]
