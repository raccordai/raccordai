import { readFileSync } from 'node:fs'
import { eq } from 'drizzle-orm'
import { getDb } from '../db/client'
import { assets, generations, nodes } from '../db/schema'
import { mimeTypeFor } from '../media/files'
import { kieClaudeMessage } from './kie'
import { resolveSelectedOutputUrl } from './generations'

/** Claude model used for prompt refinement (via kie.ai's Anthropic proxy). */
const REFINE_MODEL = 'claude-opus-4-8'

const SYSTEM = `You are an expert prompt engineer for AI image generation (models like GPT Image, Seedance, etc.).
You are given: (1) an already-generated image, (2) the prompt that produced it, (3) the user's adjustment request (fix a defect, change framing, lighting, color, etc.).
Your task: rewrite the prompt so it produces an image matching the request, while keeping everything that was already correct.
Rules:
- Preserve the style, the language, and the level of detail of the original prompt.
- Incorporate the requested adjustment precisely; if the image shows a visible defect the user mentions, add wording that corrects it.
- Keep any @-references (e.g. @Image1) intact.
- Reply with ONLY the new prompt — no quotes, no preamble, no explanation.`

/**
 * The renderer addresses local media as media:// URLs, which kie.ai's Claude
 * proxy cannot fetch — resolve those to a base64 block instead.
 * Shared with the vision QC service (qc.ts).
 */
export function imageBlockFor(
  imageUrl: string
):
  | { type: 'image'; source: { type: 'url'; url: string } }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } {
  if (!imageUrl.startsWith('media://')) {
    return { type: 'image', source: { type: 'url', url: imageUrl } }
  }
  const url = new URL(imageUrl)
  const db = getDb()
  const id = url.pathname.split('/').filter(Boolean)[0] ?? ''
  let filePath: string | null = null
  if (url.host === 'asset') {
    filePath = db.select().from(assets).where(eq(assets.id, id)).get()?.filePath ?? null
  } else if (url.host === 'generation') {
    const gen = db.select().from(generations).where(eq(generations.id, id)).get()
    filePath = (url.pathname.includes('lastFrame') ? gen?.lastFramePath : gen?.resultPath) ?? null
  }
  if (!filePath) throw new Error('Local image file not found.')
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeTypeFor(filePath) ?? 'image/jpeg',
      data: readFileSync(filePath).toString('base64')
    }
  }
}

export async function refineImagePrompt(args: {
  currentPrompt: string
  imageUrl: string
  instruction: string
}): Promise<{ prompt: string }> {
  const userText = `Current prompt:\n${args.currentPrompt || '(empty)'}\n\nRequested adjustment:\n${args.instruction}\n\nReturn the full new prompt.`
  const prompt = await kieClaudeMessage({
    model: REFINE_MODEL,
    system: SYSTEM,
    content: [imageBlockFor(args.imageUrl), { type: 'text', text: userText }]
  })
  return { prompt }
}

/**
 * refine_image_prompt for agents: same rewrite as the IPC surface, addressed
 * by NODE — the current prompt comes from the node's params and the image from
 * its selected output, so the agent only supplies the adjustment.
 */
export async function refineNodeImagePrompt(
  nodeId: string,
  instruction: string
): Promise<{ prompt: string }> {
  const db = getDb()
  const node = db.select().from(nodes).where(eq(nodes.id, nodeId)).get()
  if (!node) throw new Error('Node not found')
  const imageUrl = resolveSelectedOutputUrl(node, 'output')
  if (!imageUrl) {
    throw new Error(
      'The node has no output image yet — run it first, or just edit the prompt with update_node.'
    )
  }
  const prompt = (node.params as { prompt?: unknown } | null)?.prompt
  return refineImagePrompt({
    currentPrompt: typeof prompt === 'string' ? prompt : '',
    imageUrl,
    instruction
  })
}
