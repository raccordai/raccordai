import {
  fillTemplateSlots,
  getWorkflowTemplate,
  workflowTemplateIds
} from '@shared/templates/registry'
import { createVideo, setVideoStyle } from './videos'
import { importWorkflow } from './graph'

/**
 * create_video_from_template — the new-video template flow, headless: create
 * the video, import the blueprint with the slots filled (the single
 * fillTemplateSlots path, so markers travel with the nodes), then apply the
 * template's style. Blank/omitted slots keep their [TOKEN] in the prompts —
 * still assistant-fillable later — and come back as `unfilledTokens`.
 */
export function createVideoFromTemplate(args: {
  projectId: string
  templateId: string
  name?: string
  slots?: Record<string, string>
}): {
  videoId: string
  name: string
  templateId: string
  styleId: string
  nodeCount: number
  edgeCount: number
  unfilledTokens: string[]
} {
  const template = getWorkflowTemplate(args.templateId)
  if (!template) {
    throw new Error(
      `Unknown templateId "${args.templateId}". Valid ids: ${workflowTemplateIds.join(', ')} (details: docs "templates").`
    )
  }
  const slots = args.slots ?? {}
  const knownTokens = new Set(template.slots.map((s) => s.token))
  for (const token of Object.keys(slots)) {
    if (!knownTokens.has(token)) {
      throw new Error(
        `Template "${template.id}" has no slot "${token}". Its slots: ${template.slots.map((s) => s.token).join(', ') || '(none)'}.`
      )
    }
  }

  const name = args.name?.trim() || template.label
  const video = createVideo(args.projectId, name)
  const { nodeCount, edgeCount } = importWorkflow(
    video.id,
    JSON.stringify(fillTemplateSlots(template.workflow, slots)),
    false
  )
  setVideoStyle(video.id, template.styleId)

  const unfilledTokens = template.slots
    .map((s) => s.token)
    .filter((token) => !(slots[token] ?? '').trim())
  return {
    videoId: video.id,
    name,
    templateId: template.id,
    styleId: template.styleId,
    nodeCount,
    edgeCount,
    unfilledTokens
  }
}
