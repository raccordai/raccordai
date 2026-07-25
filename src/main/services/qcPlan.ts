import type { ModelKind } from '@shared/models'

/**
 * Vision QC (§6.2) — the pure half: prompt construction and verdict parsing.
 * qc.ts owns the I/O (DB reads, the kie Claude call, persistence), same split
 * as renderPlan.ts / render.ts.
 */

export interface QcContext {
  /** The styled prompt that produced the output (from the input snapshot). */
  prompt: string
  /** Number of reference images attached to the QC request (0 = none wired). */
  referenceCount: number
  /** True for storyboard design nodes — adds the 9-panel grid checks. */
  isStoryboard: boolean
  /** Design-sheet subject when the node is a design recipe ("Mira, 12, red scarf"). */
  designSubject?: string | null
}

export interface QcVerdictResult {
  verdict: 'pass' | 'warn'
  notes: string
}

/** Only image outputs get the vision check for now (video/audio have no cheap review path). */
export function isQcEligible(kind: ModelKind | undefined): boolean {
  return kind === 'image'
}

export const QC_SYSTEM = `You are a strict visual QA reviewer for AI-generated images in a film-making tool.
You are shown the GENERATED image first, then any REFERENCE images (design sheets that guided it), then the prompt that produced it.
Judge only what matters for production use. Check:
- Does the image fulfill the prompt (subject, composition, style, any exact text)?
- Obvious generation defects: deformed anatomy (hands, faces), duplicated limbs, garbled text, watermark artifacts.
- If reference images are provided: is the depicted character/décor/prop consistent with them (identity, outfit, colors)?
- If the prompt asks for a storyboard grid: exactly 9 legible panels in a 3x3 layout, correct reading order, no bleed-through between panels.
Reply with ONLY a JSON object, no markdown fence, no prose around it:
{"verdict":"pass","notes":""} or {"verdict":"warn","notes":"<each issue, one short sentence, most severe first>"}
"pass" = usable as-is. "warn" = anything a director would send back. Write the notes in the prompt's language.`

/** The text block appended after the image blocks of the QC request. */
export function buildQcUserText(ctx: QcContext): string {
  const lines: string[] = []
  if (ctx.referenceCount > 0) {
    lines.push(
      `The first image is the generated output; the ${ctx.referenceCount} following image(s) are the reference sheets it must stay consistent with.`
    )
  } else {
    lines.push('The image above is the generated output.')
  }
  if (ctx.designSubject) lines.push(`Design subject: ${ctx.designSubject}`)
  if (ctx.isStoryboard) {
    lines.push(
      'This output is meant to be a 9-panel storyboard (3x3 grid) — apply the storyboard checks.'
    )
  }
  lines.push(`Prompt that produced it:\n${ctx.prompt || '(empty prompt)'}`)
  lines.push('Give your verdict.')
  return lines.join('\n\n')
}

/**
 * Parse the model's reply into a verdict. Throws when no valid JSON verdict
 * can be extracted — the caller records that as a 'error' QC outcome.
 */
export function parseQcVerdict(text: string): QcVerdictResult {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error(`QC reply has no JSON verdict: ${text.slice(0, 200)}`)
  let parsed: unknown
  try {
    parsed = JSON.parse(match[0])
  } catch {
    throw new Error(`QC reply has malformed JSON: ${match[0].slice(0, 200)}`)
  }
  const { verdict, notes } = parsed as { verdict?: unknown; notes?: unknown }
  if (verdict !== 'pass' && verdict !== 'warn') {
    throw new Error(`QC reply has an unknown verdict: ${String(verdict)}`)
  }
  return { verdict, notes: typeof notes === 'string' ? notes.trim() : '' }
}
