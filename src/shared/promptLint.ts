import { clampParamToField, getModel, type ModelDefinition, type ParamField } from './models'
import { ANTI_GRID_GUARD } from './models/seedance2-prompting'
import { getDesignRecipe } from './designs/registry'

/**
 * Prompt lint (§6.5) — the prompting knowledge of `seedance2-prompting.ts` and
 * `docs/models.md`, applied BEFORE a run instead of after a bad one. Pure and
 * unit-tested: the params panel, the run confirm, the `lint_node` tool and the
 * vision-QC report all read the same findings.
 *
 * Rules are deliberately conservative — a false warning on a good prompt costs
 * more trust than a missed one. Everything here is derived from the model
 * registry (handles, aliases, enums), never from hardcoded model ids.
 */

export type LintSeverity = 'error' | 'warning'

/** A one-click repair the UI (or an agent) can apply without further input. */
export type LintFix =
  | { kind: 'appendPrompt'; text: string }
  | { kind: 'setParam'; key: string; value: unknown }
  /** Move an edge to another input handle of the same target node. */
  | { kind: 'rewire'; edgeId: string; targetHandle: string }

export interface LintFinding {
  /** Stable rule id — i18n keys and tests key off it. */
  rule:
    | 'empty-prompt'
    | 'required-input-missing'
    | 'reference-role-undeclared'
    | 'video-prompt-without-motion'
    | 'storyboard-on-frame-anchor'
    | 'storyboard-guard-missing'
    | 'param-out-of-enum'
    | 'param-out-of-range'
    | 'reference-budget-exceeded'
  severity: LintSeverity
  /** Agent- and user-facing English sentence (the UI localizes by `rule`). */
  message: string
  /** The handle, param or alias the finding is about — used to anchor the UI. */
  subject?: string
  fix?: LintFix
}

/** One wired input, as the lint needs to see it (renderer and main both build this). */
export interface LintConnection {
  edgeId: string
  /** Target handle key the edge lands on. */
  handleKey: string
  /** `@Image2` when the handle declares a `referenceAlias`, else undefined. */
  alias?: string
  /** Display name of the source node, for readable messages. */
  sourceLabel?: string
  /** `params.designId` of the source node (or of its asset) when it is a design sheet. */
  designId?: string
  /**
   * Declared clip length of the source node (`params.duration`), when it has
   * one — the only duration knowable before the media exists, so the handle
   * budget check below stays a warning.
   */
  sourceDurationSeconds?: number
}

export interface LintInput {
  modelId: string
  params: Record<string, unknown> | null | undefined
  connections: LintConnection[]
}

/**
 * Motion vocabulary: a video prompt that describes only what is IN the frame
 * (and never how it moves) wastes the model's strength — and on a
 * storyboard-driven shot it fights the panels. Matched case-insensitively as
 * whole words; the list stays short and unambiguous on purpose.
 */
const MOTION_WORDS = [
  'camera',
  'pan',
  'pans',
  'tilt',
  'tilts',
  'dolly',
  'zoom',
  'zooms',
  'push in',
  'pull back',
  'tracking',
  'track',
  'handheld',
  'orbit',
  'crane',
  'steadicam',
  'walks',
  'walking',
  'runs',
  'running',
  'turns',
  'moves',
  'moving',
  'enters',
  'exits',
  'rises',
  'falls',
  'slow motion',
  'motion',
  'movement',
  // French — prompts are usually English but the field accepts anything.
  'caméra',
  'travelling',
  'panoramique',
  'zoom avant',
  'zoom arrière',
  'marche',
  'court',
  'tourne',
  'avance',
  'recule',
  'mouvement'
]

const MOTION_RE = new RegExp(
  `(^|[^\\p{L}])(${MOTION_WORDS.map((w) => w.replace(/ /g, '\\s+')).join('|')})([^\\p{L}]|$)`,
  'iu'
)

/** True when the prompt says anything about how the shot moves. */
export function mentionsMotion(prompt: string): boolean {
  return MOTION_RE.test(prompt)
}

/** True when the anti-grid guard (or a close paraphrase) is already in the prompt. */
export function hasAntiGridGuard(prompt: string): boolean {
  const normalized = prompt.toLowerCase()
  return (
    normalized.includes('no 3x3 grid') ||
    normalized.includes('no 2x2 grid') ||
    normalized.includes('no storyboard grid') ||
    normalized.includes('no panel borders')
  )
}

/** True when `designId` names a recipe that produces a panel grid (§6.4 boards). */
function isBoardRecipe(designId: string): boolean {
  return getDesignRecipe(designId)?.board === true
}

function promptOf(params: Record<string, unknown> | null | undefined): string {
  const prompt = (params ?? {})['prompt']
  return typeof prompt === 'string' ? prompt : ''
}

/**
 * The discrete values a stepped number field accepts (Seedance 1.5: 4, 8, 12),
 * or null when the field is a plain range — the message then quotes bounds
 * instead of listing values.
 */
function allowedStepValues(field: ParamField): number[] | null {
  const { min, max, step } = field
  if (min === undefined || max === undefined || step === undefined || step <= 1) return null
  const values: number[] = []
  for (let value = min; value <= max; value += step) {
    values.push(value)
    if (values.length > 12) return null
  }
  return values.length > 1 ? values : null
}

/** The reference handle an anchored design sheet should be moved to, if any. */
function referenceHandleFor(model: ModelDefinition): string | undefined {
  return model.inputs.find((h) => !h.frameAnchor && h.accepts.includes('image'))?.key
}

/** Human role sentence proposed as the one-click fix for an undeclared reference. */
function roleSentenceFor(connection: LintConnection): string {
  const alias = connection.alias ?? '@Image1'
  const label = connection.sourceLabel ? ` (${connection.sourceLabel})` : ''
  if (connection.designId === 'storyboard') {
    return `${alias} is the 9-panel storyboard of this scene — a staging plan only, it must NEVER appear on screen: follow its panels in order, left to right, top to bottom.`
  }
  if (connection.designId === 'shotboard') {
    return `${alias} is the 4-panel shot board of THIS shot — a staging plan only, it must NEVER appear on screen: open on panel 1, play panels 2-3, end on panel 4.`
  }
  if (connection.designId === 'character') {
    return `${alias} is the character sheet${label} — keep the same face, hair, outfit and proportions.`
  }
  if (connection.designId === 'decor') {
    return `${alias} is the décor sheet${label} — keep the same location, architecture and colors.`
  }
  if (connection.designId === 'prop') {
    return `${alias} is the prop sheet${label} — keep the same object design.`
  }
  return `${alias} is the reference${label} — describe here what it must contribute to the shot.`
}

/**
 * Lint one node's prompt and params against its model and wiring. Returns an
 * empty array for an unknown model or an asset node — nothing to say.
 */
export function lintNode(input: LintInput): LintFinding[] {
  const model = getModel(input.modelId)
  if (!model) return []
  const params = (input.params ?? {}) as Record<string, unknown>
  const prompt = promptOf(params)
  const findings: LintFinding[] = []

  const hasPromptField = model.paramFields.some((f) => f.key === 'prompt')
  if (hasPromptField && prompt.trim() === '') {
    findings.push({
      rule: 'empty-prompt',
      severity: 'error',
      subject: 'prompt',
      message: 'The prompt is empty — the run would generate from nothing.'
    })
  }

  // Required inputs: the engine rejects the run anyway, say it before spending
  // the click (and before an agent queues a batch that cannot start).
  for (const handle of model.inputs) {
    if (!handle.required) continue
    if (input.connections.some((c) => c.handleKey === handle.key)) continue
    findings.push({
      rule: 'required-input-missing',
      severity: 'error',
      subject: handle.key,
      message: `Required input "${handle.label}" is not connected.`
    })
  }

  const anchorKeys = new Set(model.inputs.filter((h) => h.frameAnchor).map((h) => h.key))
  const rewireTarget = referenceHandleFor(model)

  for (const connection of input.connections) {
    // A design sheet on a frame anchor puts the sheet itself on screen — the
    // single most expensive mistake in the app (a wasted video generation).
    if (connection.designId && anchorKeys.has(connection.handleKey)) {
      const handleLabel =
        model.inputs.find((h) => h.key === connection.handleKey)?.label ?? connection.handleKey
      findings.push({
        rule: 'storyboard-on-frame-anchor',
        severity: 'error',
        subject: connection.handleKey,
        message: `"${connection.sourceLabel ?? 'A design sheet'}" is wired to "${handleLabel}", a frame anchor: the sheet would appear on screen literally. Wire it as a reference instead.`,
        ...(rewireTarget
          ? { fix: { kind: 'rewire', edgeId: connection.edgeId, targetHandle: rewireTarget } }
          : {})
      })
      continue
    }
    // A reference nobody addresses in the prompt is an invisible input: the
    // model has no role for it and silently blurs it into the style.
    if (connection.alias && !prompt.includes(connection.alias)) {
      findings.push({
        rule: 'reference-role-undeclared',
        severity: 'warning',
        subject: connection.alias,
        message: `${connection.alias}${connection.sourceLabel ? ` ("${connection.sourceLabel}")` : ''} is wired but never mentioned in the prompt — declare its role or it only guides by accident.`,
        fix: { kind: 'appendPrompt', text: roleSentenceFor(connection) }
      })
    }
  }

  // A panel grid wired as a reference without the anti-grid guard: the model
  // may render the grid itself in the shot. Which recipes are grids comes from
  // the registry (`board`), never from a hardcoded id.
  const storyboardRef = input.connections.find(
    (c) => c.designId && isBoardRecipe(c.designId) && !anchorKeys.has(c.handleKey)
  )
  if (storyboardRef && prompt.trim() !== '' && !hasAntiGridGuard(prompt)) {
    findings.push({
      rule: 'storyboard-guard-missing',
      severity: 'warning',
      subject: storyboardRef.alias ?? storyboardRef.handleKey,
      message:
        'A panel board is wired as a reference but the prompt has no anti-grid guard — the model may render the panel grid on screen.',
      fix: { kind: 'appendPrompt', text: ANTI_GRID_GUARD }
    })
  }

  // Motion: a video prompt that never says how the shot moves.
  if (model.kind === 'video' && prompt.trim() !== '' && !mentionsMotion(prompt)) {
    findings.push({
      rule: 'video-prompt-without-motion',
      severity: 'warning',
      subject: 'prompt',
      message:
        'This video prompt describes visuals but no motion — say what the camera and the subject do (the composition belongs to the references).'
    })
  }

  // Params outside the model's declared enums: the schema would reject the run,
  // or the value would be silently coerced by the provider.
  for (const field of model.paramFields) {
    if (!field.options) continue
    const value = params[field.key]
    if (value === undefined || value === null) continue
    if (field.options.some((o) => o.value === value)) continue
    findings.push({
      rule: 'param-out-of-enum',
      severity: 'error',
      subject: field.key,
      message: `"${field.label}" is set to "${String(value)}", which this model does not accept (${field.options.map((o) => o.value).join(', ')}).`,
      ...(field.defaultValue !== undefined
        ? { fix: { kind: 'setParam', key: field.key, value: field.defaultValue } }
        : {})
    })
  }

  // Numeric params outside the model's declared bounds — the API rejects them
  // (a Seedance 2 clip shorter than 4 s is the classic), and until this rule
  // existed nothing said so before the spend: the value was stored verbatim by
  // the panel, by import_workflow and by the agent tools, and only blew up in
  // `prepareRun`. Bounds come from the field itself, never from a model id.
  for (const field of model.paramFields) {
    if (field.type !== 'number') continue
    const value = params[field.key]
    if (value === undefined || value === null) continue
    const fallback: LintFix | undefined =
      field.defaultValue === undefined
        ? undefined
        : { kind: 'setParam', key: field.key, value: field.defaultValue }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      findings.push({
        rule: 'param-out-of-range',
        severity: 'error',
        subject: field.key,
        message: `"${field.label}" is set to "${String(value)}", which is not a number.`,
        ...(fallback ? { fix: fallback } : {})
      })
      continue
    }

    const legal = clampParamToField(value, field)
    if (legal === value) continue

    const { min, max } = field
    const outOfBounds = (min !== undefined && value < min) || (max !== undefined && value > max)
    const allowed = allowedStepValues(field)
    const bounds = allowed
      ? allowed.join(', ')
      : min !== undefined && max !== undefined
        ? `${min} to ${max}`
        : min !== undefined
          ? `${min} at the least`
          : `${max} at the most`

    findings.push({
      rule: 'param-out-of-range',
      // Out of bounds = the provider rejects the run. Merely off-step is
      // snapped by `buildPayload`, so the clip is simply not the length the
      // timeline was told about — worth saying, not worth blocking.
      severity: outOfBounds ? 'error' : 'warning',
      subject: field.key,
      message: outOfBounds
        ? `"${field.label}" is set to ${value} — this model accepts ${bounds}. The run would be rejected.`
        : `"${field.label}" is set to ${value} — this model only accepts ${bounds}, so the run would be snapped to ${legal}.`,
      fix: { kind: 'setParam', key: field.key, value: legal }
    })
  }

  // Reference handles with a combined-duration budget (Seedance 2: ≤ 15 s of
  // video, ≤ 15 s of audio across the handle). Only the DECLARED lengths of the
  // source nodes are knowable before the media exists, so this stays a warning.
  for (const handle of model.inputs) {
    if (handle.maxTotalSeconds === undefined) continue
    const wired = input.connections.filter((c) => c.handleKey === handle.key)
    const total = wired.reduce((sum, c) => sum + (c.sourceDurationSeconds ?? 0), 0)
    if (total <= handle.maxTotalSeconds) continue
    findings.push({
      rule: 'reference-budget-exceeded',
      severity: 'warning',
      subject: handle.key,
      message: `"${handle.label}" carries ~${total}s of source media across ${wired.length} connections — this model accepts ${handle.maxTotalSeconds}s combined. Unwire one or shorten the sources.`
    })
  }

  return findings
}

/** Convenience for callers that only need to know whether a run is blocked. */
export function hasBlockingFinding(findings: LintFinding[]): boolean {
  return findings.some((f) => f.severity === 'error')
}

/** One-line-per-finding rendering, used by `lint_node` and the QC report. */
export function formatFindings(findings: LintFinding[]): string {
  return findings.map((f) => `${f.severity === 'error' ? '✗' : '⚠'} ${f.message}`).join('\n')
}
