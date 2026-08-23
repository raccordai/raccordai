import type { ModelKind } from '@shared/models'
import { formatFindings, type LintFinding } from '@shared/promptLint'

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

/**
 * Folds the prompt lint (§6.5) into the vision verdict: the linter sees what
 * the image cannot show (a reference wired but never addressed, a param the
 * model rejects), so its findings belong in the same report. A `pass` only
 * degrades to `warn` on a BLOCKING finding — a stylistic nudge must not
 * re-open a shot the reviewer accepted.
 */
export function foldLintIntoVerdict(
  result: QcVerdictResult,
  findings: LintFinding[]
): QcVerdictResult {
  if (findings.length === 0) return result
  const blocking = findings.some((f) => f.severity === 'error')
  const verdict = result.verdict === 'pass' && !blocking ? 'pass' : 'warn'
  if (verdict === 'pass') return result
  const lintBlock = `Prompt lint:\n${formatFindings(findings)}`
  return { verdict, notes: [result.notes, lintBlock].filter(Boolean).join('\n\n') }
}

/** Clip QC (§6.2 extended): video outputs, judged from sampled frames. */
export function isClipQcEligible(kind: ModelKind | undefined): boolean {
  return kind === 'video'
}

export const CLIP_QC_SYSTEM = `You are a strict visual QA reviewer for AI-generated video clips in a film-making tool.
You are shown FRAMES SAMPLED from the generated clip in playback order (start → end), then any REFERENCE images (design sheets that guided it), then the prompt that produced it.
Judge only what matters for production use. Check:
- Does the clip fulfill the prompt (subject, composition, style, the described action and camera move — infer motion from how the frames differ)?
- Obvious generation defects: deformed anatomy (hands, faces), morphing between frames, duplicated limbs, garbled on-screen text, watermark artifacts.
- Identity drift across frames: the same character/décor must stay itself from the first frame to the last.
- If reference images are provided: is the depicted character/décor/prop consistent with them (identity, outfit, colors)?
Remember you see samples, not the full motion — flag only what the frames actually show.
Reply with ONLY a JSON object, no markdown fence, no prose around it:
{"verdict":"pass","notes":""} or {"verdict":"warn","notes":"<each issue, one short sentence, most severe first>"}
"pass" = usable as-is. "warn" = anything a director would send back. Write the notes in the prompt's language.`

export interface ClipQcContext {
  /** The styled prompt that produced the clip (from the input snapshot). */
  prompt: string
  /** How many frames were sampled from the clip. */
  frameCount: number
  /** Number of reference images attached after the frames. */
  referenceCount: number
  /** Measured clip length, when known. */
  durationSec?: number | null
}

/** The text block appended after the frame + reference blocks of a clip QC. */
export function buildClipQcUserText(ctx: ClipQcContext): string {
  const lines: string[] = []
  const duration = ctx.durationSec ? ` of a ${ctx.durationSec.toFixed(1)}s clip` : ''
  lines.push(
    `The ${ctx.frameCount} images above are frames sampled in playback order${duration} (first frame → last frame).`
  )
  if (ctx.referenceCount > 0) {
    lines.push(
      `The ${ctx.referenceCount} following image(s) are the reference sheets the clip must stay consistent with.`
    )
  }
  lines.push(`Prompt that produced it:\n${ctx.prompt || '(empty prompt)'}`)
  lines.push('Give your verdict.')
  return lines.join('\n\n')
}

/**
 * The snapshot input URLs that can ride along as reference IMAGES: only the
 * handles whose declared `accepts` includes 'image' (a reference VIDEO url
 * would be rejected by the vision provider), in handle order, capped by the
 * caller. Unknown handles are skipped — never guessed from the file name.
 */
export function imageReferenceUrls(
  inputs: Record<string, string[]> | undefined,
  model: { inputs: Array<{ key: string; accepts: readonly string[] }> } | undefined
): string[] {
  if (!inputs || !model) return []
  const urls: string[] = []
  for (const handle of model.inputs) {
    if (!handle.accepts.includes('image')) continue
    for (const url of inputs[handle.key] ?? []) urls.push(url)
  }
  return urls
}
