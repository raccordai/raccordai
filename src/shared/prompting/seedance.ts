/**
 * §6.9 — THE SEEDANCE PROMPTING DOCTRINE, as data.
 *
 * The app used to hold its prompting knowledge as prose (`seedance2-prompting.ts`,
 * `docs.ts`, the chat system prompts): correct, but only an LLM could apply it,
 * and only if it happened to read it. This module encodes the same doctrine as
 * PURE DATA plus an assembler, so three surfaces enforce it mechanically:
 *
 *   - the shot recipes build their prompt through `buildSeedancePrompt`;
 *   - the run engine wraps every styled video prompt in the sandwich
 *     (`wrapPromptWithStyle` in `styles/registry.ts`);
 *   - the prompt lint checks what is mechanically checkable.
 *
 * The three ideas everything else descends from:
 *   1. WHAT KIND OF FOOTAGE IS THIS — declared before anything else. The first
 *      15-40 words are a domain selector: naming a medium, an era and a
 *      provenance pulls a coherent slice of the training distribution, and that
 *      slice arrives carrying grain, motion physics, framing habits, lighting
 *      and wardrobe logic already agreeing with each other.
 *   2. WHO IS HOLDING THE CAMERA — a body or a ghost, declared every time. An
 *      undeclared camera drifts between the two: too smooth to be filmed, too
 *      clumsy to be designed.
 *   3. WHAT IS GOING WRONG — every real recording is a record of small
 *      failures, and failures in MOTION outrank failures in texture.
 *
 * All content is English: these strings go into prompts.
 */

// ─── Registers ──────────────────────────────────────────────────────────────

/**
 * Which of the three prompt shapes a shot is written in. The decision rule:
 * if the shot's success depends on matching a reference or holding an exact
 * continuity chain → `architect`; on feeling really filmed → `flow`; on feeling
 * authored, choreographed and impossible → `kinetic`.
 *
 * `flow` and `kinetic` never mix: they run on opposite camera doctrines, and a
 * prompt asking for both an unsteady operator and a weightless invisible camera
 * gets neither.
 */
export const PROMPT_MODES = ['architect', 'flow', 'kinetic'] as const
export type PromptMode = (typeof PROMPT_MODES)[number]

/**
 * The camera's ontology. There are exactly two, and mixing them produces
 * neither — `camera-doctrine-mixed` is a blocking lint finding for that reason.
 */
export const CAMERA_DOCTRINES = ['embodied', 'disembodied'] as const
export type CameraDoctrine = (typeof CAMERA_DOCTRINES)[number]

/**
 * The negation that frees the camera from a body. Not decoration: without it
 * the model defaults toward handheld physics on anything violent (most violent
 * footage it learned from was filmed by a person), and the impossible moves —
 * snap zooms, orbital arcs, crash push-ins — never arrive.
 */
export const CAMERA_NEGATION =
  'The camera is a weightless invisible presence — never a person’s viewpoint, never part of the scene.'

/**
 * Declares speed ramping as the governing style. It has to sit in the opening
 * line, before any action exists: ramps written into individual beats without
 * this get flattened into a single average speed.
 */
export const RAMP_SPINE =
  'Single continuous cinematic take, one seamless uncut shot with aggressive in-camera speed ramps.'

/**
 * The anti-beauty lock. Without it the model reverts to symmetrical, flawless,
 * retouched faces — the single loudest AI signature.
 */
export const ANTI_BEAUTY_LOCK =
  'Completely natural face with no makeup, soft asymmetric features, visible skin texture and pores, wind-tousled hair.'

/** Said three times, in three places, or a oner is not a oner. */
export const ONER_DECLARATIONS = {
  opening: 'single continuous uncut take',
  timeline: 'The camera never cuts — one unbroken move through the whole clip.',
  booster: 'Continuous single shot, no edits, seamless take.'
} as const

/** Both halves of a freeze must be stated, or it renders as a paused video. */
export const FREEZE_CONTRACT = {
  frozen:
    'WHAT FREEZES: everything — subjects, debris, dust, fabric, water. No hair movement, no cloth shift, no micro-motion at all, suspended with accurate weight and trajectories.',
  moving: 'WHAT MOVES: the camera only, in one continuous move.'
} as const

/** The micro-artifact that makes a resumed freeze read as photographed. */
export const TEMPORAL_RESIDUE =
  'Time snaps back with a slight realistic temporal residue — some outer debris shows a very subtle reverse lag before continuing forward.'

/** Appended to any booster stack when the clip runs long. */
export const CONSISTENCY_TAIL =
  'Consistent appearance and wardrobe across all beats, stable facial structure, natural gait with feet contacting the ground, coherent motion throughout, stable picture.'

// ─── Law 1 — the opening declaration ────────────────────────────────────────

/**
 * A capture declaration: five slots — medium/format, era & provenance, rig &
 * operator, light regime, imperfection signature — closed by an intent verdict.
 *
 * 15-40 words. Longer and it stops being a selector and starts being noise.
 * ONE medium only: mixed media is mush. And the declaration is a CONTRACT —
 * everything downstream has to obey it (a 16mm cinéma vérité opener cannot
 * contain a drone crane move; that footage does not exist).
 */
export interface CaptureDeclaration {
  id: string
  /** Agent-facing English name; the UI localizes through `recipeFields.capture.options.<id>`. */
  label: string
  mode: PromptMode
  doctrine: CameraDoctrine
  /** The medium token — also what `hasCaptureDeclaration` looks for. */
  medium: string
  /** The declaration itself, ready to open a prompt. */
  text: string
  /** The booster stack that re-states this medium at the bottom of the sandwich. */
  boosterId: string
}

export const CAPTURE_DECLARATIONS: CaptureDeclaration[] = [
  {
    id: 'verite-16mm',
    label: 'Cinéma vérité / observational (16mm)',
    mode: 'flow',
    doctrine: 'embodied',
    medium: '16mm',
    text: 'Gritty 16mm cinéma vérité, authentic 1970s European documentary footage, organic film grain, pure natural daylight, heavy shoulder-mounted handheld shake, no stabilization, soft focus falls, subtle light leaks, raw and elegant, lived-in realism.',
    boosterId: 'documentary-16mm'
  },
  {
    id: 'found-footage-phone',
    label: 'Found footage / smartphone',
    mode: 'flow',
    doctrine: 'embodied',
    medium: 'smartphone video',
    text: "Raw found footage style, amateur handheld smartphone video, heavy natural camera shake and jitter from the operator's unsteady hands, low-fi consumer camera quality with visible grain, compression artifacts, motion blur during fast pans, single continuous uncut take with no edits, natural available light, realistic operator reactions.",
    boosterId: 'found-footage'
  },
  {
    id: 'camcorder-dv',
    label: 'Consumer camcorder / archival',
    mode: 'flow',
    doctrine: 'embodied',
    medium: 'DV camcorder',
    text: 'Handheld documentary footage recorded on an early-2000s consumer DV camcorder, interlaced video texture, limited dynamic range, autofocus hunting, exposure pumping, drifting framing, constant shake, the imperfect look of real on-site documentation.',
    boosterId: 'found-footage'
  },
  {
    id: 'grounded-action',
    label: 'Grounded action thriller',
    mode: 'flow',
    doctrine: 'embodied',
    medium: '35mm anamorphic',
    text: 'Ultra-photorealistic cinematic action sequence from a grounded action thriller film, 35mm anamorphic, naturalistic contrast, hyper-realistic practical destruction, handheld-dynamic camera with urgent motivated moves, heavy motion blur on fast debris, no gloss.',
    boosterId: 'action-destruction'
  },
  {
    id: 'cold-survival',
    label: 'Cold survival realism',
    mode: 'flow',
    doctrine: 'embodied',
    medium: 'survival cinema',
    text: 'Ultra-realistic high-budget survival cinema, cool blue-grey shadows, pale overcast daylight, muted desaturated greens, drifting mist and frost, wet blacks and cold hard metal, high contrast but naturalistic, tactile wet textures, grounded raw realism.',
    boosterId: 'naturalistic-drama'
  },
  {
    id: 'nature-doc',
    label: 'Nature documentary (long lens)',
    mode: 'flow',
    doctrine: 'embodied',
    medium: 'wildlife documentary footage',
    text: 'Long-lens wildlife documentary footage, super-telephoto compression, operator anchored far away behind cover, available daylight, heat shimmer in the compressed air column, patient observational framing that finds the action late.',
    boosterId: 'creature'
  },
  {
    id: 'broadcast-eng',
    label: 'Broadcast news / ENG',
    mode: 'flow',
    doctrine: 'embodied',
    medium: 'ENG video camera',
    text: 'Live broadcast news field footage, shoulder-mounted ENG video camera, hard on-camera light against ambient darkness, slightly overexposed faces, reactive reframing, unglamorous flat coverage.',
    boosterId: 'found-footage'
  },
  {
    id: 'surveillance',
    label: 'Security / surveillance',
    mode: 'architect',
    // "no operator" is a RIG (a bolted-down camera), not a ghost: the camera is
    // physically present, it simply has nobody behind it. Only the explicit
    // negation makes a camera disembodied.
    doctrine: 'embodied',
    medium: 'surveillance camera footage',
    text: 'Fixed overhead surveillance camera footage, wide distorted lens, low frame rate stutter, monochrome infrared cast, no operator, flat unmotivated lighting, timestamped institutional recording.',
    boosterId: 'found-footage'
  },
  {
    id: 'golden-age-35mm',
    label: 'Golden-age film emulation',
    mode: 'architect',
    doctrine: 'embodied',
    medium: '35mm three-strip emulation',
    text: 'Photorealistic 35mm three-strip emulation, 1950s studio production, hard key light with sculpted fill, deep saturated primaries, gate weave, halation blooming around highlights, locked-off studio camera on a dolly.',
    boosterId: 'naturalistic-drama'
  },
  {
    id: 'vertical-ugc',
    label: 'Vertical UGC',
    mode: 'flow',
    doctrine: 'embodied',
    medium: 'vertical smartphone video',
    text: 'Vertical smartphone video shot at arm’s length, front-facing lens distortion, mixed indoor light with window spill, natural handheld micro-shake, unedited single take, authentic unrehearsed energy.',
    boosterId: 'found-footage'
  },
  {
    id: 'high-end-commercial',
    label: 'High-end commercial',
    mode: 'architect',
    doctrine: 'embodied',
    medium: 'commercial cinematography',
    text: 'Precision-controlled commercial cinematography, motion-control camera, clean studio softbox key with negative fill, flawless glass and metal reflections, no grain, clinical color separation, product photography discipline.',
    boosterId: 'commercial-product'
  },
  {
    id: 'frozen-diorama',
    label: 'Frozen time / diorama',
    mode: 'flow',
    doctrine: 'embodied',
    medium: 'handheld shot in slow motion',
    text: 'Single continuous handheld shot in slow motion, drifting and weaving organically through a world suspended mid-motion, every element locked like a living diorama, camera physically present and imperfect while the world holds still.',
    boosterId: 'frozen-time'
  },
  {
    id: 'stylized-kinetic',
    label: 'Stylized kinetic action',
    mode: 'kinetic',
    doctrine: 'disembodied',
    medium: 'single continuous cinematic take',
    text: `${RAMP_SPINE} ${CAMERA_NEGATION} Snap zooms, crash push-ins, whip-pans, orbital arcs and sudden speed shifts.`,
    boosterId: 'stylized-kinetic'
  },
  {
    id: 'dark-fantasy-battlefield',
    label: 'Dark fantasy battlefield',
    mode: 'kinetic',
    doctrine: 'disembodied',
    medium: 'ultra-dynamic single take',
    text: `Ultra-dynamic single take on a scorched dusk battlefield: churned black mud, burning embers, dark red smoke-choked sky, firelight and thick drifting ash. ${CAMERA_NEGATION} Aggressive speed ramping, brutal supernatural physics.`,
    boosterId: 'stylized-kinetic'
  },
  // ── Two adaptations. The library above is photographic; Raccord also ships
  // an illustrated art direction and a general cinematic one, and a style
  // without a declaration would be the one case where the doctrine does not
  // apply. Same five slots, transposed to their own medium.
  {
    id: 'anime-cel',
    label: 'Hand-drawn 2D cel animation',
    mode: 'architect',
    // A drawn camera emulates a physical one — motivated moves, held
    // backgrounds, parallax pans. The ghost doctrine is for weightless
    // impossible moves, and claiming it here would license the wrong grammar.
    doctrine: 'embodied',
    medium: '2D cel animation',
    text: 'Hand-drawn 2D cel animation from a theatrical anime feature, clean lineart over painted backgrounds, animation on twos with sakuga bursts on key moments, painted key light with strong rim at golden hour, visible line-weight variation and held backgrounds with parallax camera pans, expressive drawn performance.',
    boosterId: 'anime-cel'
  },
  {
    id: 'cinematic-35mm',
    label: 'Naturalistic 35mm cinema',
    mode: 'flow',
    doctrine: 'embodied',
    medium: '35mm',
    text: 'Photorealistic 35mm cinema, contemporary naturalistic drama, motivated practical light with natural highlight roll-off, operator on a fluid head making slow deliberate moves, fine grain, subtle focus breathing on pulls, restrained and grounded.',
    boosterId: 'naturalistic-drama'
  }
]

const DECLARATION_MAP = new Map(CAPTURE_DECLARATIONS.map((d) => [d.id, d]))

export function getCaptureDeclaration(id: string): CaptureDeclaration | undefined {
  return DECLARATION_MAP.get(id)
}

// ─── Law 5 — the booster stack (the bottom of the sandwich) ─────────────────

/**
 * Closing stacks. Their job is texture ENFORCEMENT, not new adjectives: the top
 * of the sandwich selects the universe, the bottom stops it decaying over the
 * back half of the clip. A stack re-states the medium it belongs to — which is
 * why each one is bound to its declarations rather than being free-floating.
 */
export interface BoosterStack {
  id: string
  /** `flow` stacks stay short; `kinetic` ones enumerate every dynamic operation. */
  mode: PromptMode
  text: string
}

export const BOOSTER_STACKS: BoosterStack[] = [
  {
    id: 'documentary-16mm',
    mode: 'flow',
    text: 'Photorealistic 16mm film emulation, heavy organic grain, authentic period details, natural skin texture, imperfect handheld physics, subtle film weave, coherent motion, pure observational texture.'
  },
  {
    id: 'found-footage',
    mode: 'flow',
    text: 'Raw consumer found-footage aesthetic, heavy handheld instability and micro-shakes, natural motion blur from camera movement, realistic flare and slight overexposure on bright sources, amateur recording feel with no stabilization, no text, no overlays, no watermarks.'
  },
  {
    id: 'action-destruction',
    mode: 'flow',
    text: 'Photorealistic, hyper-realistic rigid-body destruction with correct material properties (metal, wood, glass, concrete), accurate mass and trajectories, natural dust and smoke interaction, heavy cinematic motion blur on fast debris, stable character performance, movie-level practical effects quality.'
  },
  {
    id: 'creature',
    mode: 'flow',
    text: 'Photorealistic creature rendering, wet matted fur with visible weight and inertia, accurate muscle and skeletal motion, correct contact shadows and surface deformation, grounded animal physics, tactile material response, no smooth plastic surfaces, no stylized rendering.'
  },
  {
    id: 'frozen-time',
    mode: 'flow',
    text: 'Perfect frozen mid-air physics with accurate weight and trajectories, seamless transition from freeze to resume, natural dust and particle interaction, single seamless slow-motion take, coherent spatial geometry throughout the move.'
  },
  {
    id: 'naturalistic-drama',
    mode: 'flow',
    text: 'Photorealistic, natural skin texture with visible pores and asymmetry, motivated practical lighting, restrained naturalistic grade, believable shallow depth of field, coherent motion, no retouching, no artificial bloom.'
  },
  {
    id: 'commercial-product',
    mode: 'architect',
    text: 'Precision commercial finish, flawless glass and metal reflections, clean studio key with negative fill, clinical color separation, accurate mass and contact shadows on every surface, coherent motion, no grain, no artifacts.'
  },
  {
    id: 'anime-cel',
    mode: 'architect',
    text: 'Hand-drawn 2D cel-animation rendering, clean lineart with consistent line weight, flat two-tone shading, painted backgrounds with parallax depth, animation on twos, consistent character model across every beat, no 3D render look, no photorealism.'
  },
  {
    id: 'stylized-kinetic',
    mode: 'kinetic',
    text: 'Ultra-dynamic single take with aggressive speed ramping between slow motion and real time, punchy snap zooms and crash zooms on impacts, hard whip-pans, low-angle hero framing, canted dutch-angle finish, orbital arcs, invisible weightless camera that is never a character, heavy motion blur on every fast move, coherent brutal physics, hard flares and overexposure on sparks and energy, fine cinematic grain, high contrast punchy grade, no text, no overlays, no watermarks, one unbroken stylized take.'
  }
]

const BOOSTER_MAP = new Map(BOOSTER_STACKS.map((b) => [b.id, b]))

export function getBoosterStack(id: string): BoosterStack | undefined {
  return BOOSTER_MAP.get(id)
}

// ─── Camera mode brackets ───────────────────────────────────────────────────

/**
 * The bracket vocabulary. The bracket acts as a header token: it isolates the
 * camera instruction from the action sentence so the model does not blend the
 * two — the practical implementation of "subject motion and camera motion
 * stated separately".
 *
 * ONE camera mode per beat, exactly one. If a second move is needed, it is a
 * second beat.
 */
export interface CameraModeToken {
  id: string
  /** Written verbatim, brackets included. */
  bracket: string
  family: 'handheld' | 'controlled' | 'aerial' | 'specialist' | 'kinetic'
  /** `kinetic` brackets require the ghost; handheld ones require a body. */
  doctrine: CameraDoctrine
}

export const CAMERA_MODES: CameraModeToken[] = [
  // Handheld family — a body is holding this.
  {
    id: 'close-handheld-tracking',
    bracket: '[Close Handheld Tracking]',
    family: 'handheld',
    doctrine: 'embodied'
  },
  {
    id: 'unsteady-following',
    bracket: '[Unsteady Following Shot]',
    family: 'handheld',
    doctrine: 'embodied'
  },
  { id: 'handheld-medium', bracket: '[Handheld Medium]', family: 'handheld', doctrine: 'embodied' },
  { id: 'raw-tracking', bracket: '[Raw Tracking]', family: 'handheld', doctrine: 'embodied' },
  {
    id: 'continuous-shaky',
    bracket: '[Continuous Shaky Handheld]',
    family: 'handheld',
    doctrine: 'embodied'
  },
  {
    id: 'shoulder-follow',
    bracket: '[Shoulder-Mounted Follow]',
    family: 'handheld',
    doctrine: 'embodied'
  },
  {
    id: 'reactive-handheld',
    bracket: '[Reactive Handheld]',
    family: 'handheld',
    doctrine: 'embodied'
  },
  {
    id: 'frantic-reframe',
    bracket: '[Frantic Handheld Reframe]',
    family: 'handheld',
    doctrine: 'embodied'
  },
  // Controlled family — mounted rig, still a physical camera.
  {
    id: 'dolly-push-in',
    bracket: '[Slow Dolly Push-In]',
    family: 'controlled',
    doctrine: 'embodied'
  },
  {
    id: 'pull-back-reveal',
    bracket: '[Slow Pull Back Reveal]',
    family: 'controlled',
    doctrine: 'embodied'
  },
  {
    id: 'lateral-tracking',
    bracket: '[Lateral Tracking Shot]',
    family: 'controlled',
    doctrine: 'embodied'
  },
  {
    id: 'static-locked-off',
    bracket: '[Static Locked Off]',
    family: 'controlled',
    doctrine: 'embodied'
  },
  {
    id: 'slow-orbit',
    bracket: '[Slow Continuous Orbit]',
    family: 'controlled',
    doctrine: 'embodied'
  },
  { id: 'crane-descend', bracket: '[Crane Descend]', family: 'controlled', doctrine: 'embodied' },
  {
    id: 'steadicam-glide',
    bracket: '[Steadicam Glide]',
    family: 'controlled',
    doctrine: 'embodied'
  },
  {
    id: 'rack-focus-hold',
    bracket: '[Rack Focus Hold]',
    family: 'controlled',
    doctrine: 'embodied'
  },
  // Aerial family.
  {
    id: 'aerial-descent',
    bracket: '[Fast Aerial Tracking Descent]',
    family: 'aerial',
    doctrine: 'embodied'
  },
  { id: 'high-wide-aerial', bracket: '[High Wide Aerial]', family: 'aerial', doctrine: 'embodied' },
  {
    id: 'low-drone-pass',
    bracket: '[Low Skimming Drone Pass]',
    family: 'aerial',
    doctrine: 'embodied'
  },
  {
    id: 'rear-aerial-payoff',
    bracket: '[Rear Aerial Payoff]',
    family: 'aerial',
    doctrine: 'embodied'
  },
  // Specialist.
  {
    id: 'bullet-time-orbit',
    bracket: '[Bullet Time Orbit]',
    family: 'specialist',
    doctrine: 'embodied'
  },
  {
    id: 'frozen-world-drift',
    bracket: '[Frozen-World Drift]',
    family: 'specialist',
    doctrine: 'embodied'
  },
  {
    id: 'whip-pan-transition',
    bracket: '[Whip Pan Transition]',
    family: 'specialist',
    doctrine: 'embodied'
  },
  {
    id: 'snake-cam',
    bracket: '[Snake Cam Low Detail]',
    family: 'specialist',
    doctrine: 'embodied'
  },
  {
    id: 'super-tele-observation',
    bracket: '[Super-Tele Observation]',
    family: 'specialist',
    doctrine: 'embodied'
  },
  { id: 'pov-handheld', bracket: '[POV Handheld]', family: 'specialist', doctrine: 'embodied' },
  {
    id: 'over-shoulder-chase',
    bracket: '[Over-Shoulder Chase]',
    family: 'specialist',
    doctrine: 'embodied'
  },
  // Kinetic family — ghost camera only.
  { id: 'snap-zoom-open', bracket: '[Snap-Zoom Open]', family: 'kinetic', doctrine: 'disembodied' },
  { id: 'crash-push-in', bracket: '[Crash Push-In]', family: 'kinetic', doctrine: 'disembodied' },
  {
    id: 'hard-whip-impact',
    bracket: '[Hard Whip to Impact]',
    family: 'kinetic',
    doctrine: 'disembodied'
  },
  { id: 'orbital-arc', bracket: '[180° Orbital Arc]', family: 'kinetic', doctrine: 'disembodied' },
  {
    id: 'ramp-on-the-steal',
    bracket: '[Speed Ramp on the Steal]',
    family: 'kinetic',
    doctrine: 'disembodied'
  },
  {
    id: 'rhythmic-snaps',
    bracket: '[Rhythmic Snap Volley]',
    family: 'kinetic',
    doctrine: 'disembodied'
  },
  {
    id: 'ramp-into-the-kill',
    bracket: '[Ramp Into the Kill]',
    family: 'kinetic',
    doctrine: 'disembodied'
  },
  {
    id: 'dutch-snap-landing',
    bracket: '[Dutch-Angle Snap Landing]',
    family: 'kinetic',
    doctrine: 'disembodied'
  },
  {
    id: 'camera-abandons-hero',
    bracket: '[Camera Abandons the Hero]',
    family: 'kinetic',
    doctrine: 'disembodied'
  }
]

const CAMERA_MODE_MAP = new Map(CAMERA_MODES.map((m) => [m.id, m]))

export function getCameraMode(id: string): CameraModeToken | undefined {
  return CAMERA_MODE_MAP.get(id)
}

/** The bracket to use for `id` under `doctrine`, falling back to a legal one. */
export function bracketFor(id: string, doctrine: CameraDoctrine): string {
  const token = CAMERA_MODE_MAP.get(id)
  if (token?.doctrine === doctrine) return token.bracket
  // A handheld bracket under the ghost (or a kinetic one under a body) would
  // re-open the doctrine the prompt just closed — fall back to a legal bracket
  // rather than honour the id.
  const fallback = CAMERA_MODES.find(
    (m) =>
      m.doctrine === doctrine &&
      m.family === (doctrine === 'disembodied' ? 'kinetic' : 'controlled')
  )
  return fallback?.bracket ?? '[Static Locked Off]'
}

// ─── Optics ─────────────────────────────────────────────────────────────────

/**
 * FOV anchor table. Only these discrete steps are ever written into a prompt —
 * not millimetres, and not an arbitrary degree value.
 */
export interface FovStep {
  degrees: number
  mmEquiv: string
  purpose: string
}

export const FOV_STEPS: FovStep[] = [
  { degrees: 180, mmEquiv: 'fisheye', purpose: 'spherical distortion — POV, dream-state' },
  {
    degrees: 107,
    mmEquiv: '14-16mm',
    purpose: 'architectural ultra-wide — huge interiors, epic establish'
  },
  { degrees: 84, mmEquiv: '20-24mm', purpose: 'wide — establish, group blocking' },
  { degrees: 63, mmEquiv: '28-35mm', purpose: 'observational — wide observation, reportage' },
  {
    degrees: 47,
    mmEquiv: '40-50mm',
    purpose: 'neutral human perspective — universal establish, medium'
  },
  {
    degrees: 29,
    mmEquiv: '75-85mm',
    purpose: 'portrait compression — medium-isolate, dialogue bust'
  },
  {
    degrees: 18,
    mmEquiv: '100-135mm',
    purpose: 'natural portrait — close-portrait, identity-preserving'
  },
  { degrees: 12, mmEquiv: '180-200mm', purpose: 'tele-detail — hands, objects, detail-on-wide' },
  { degrees: 8, mmEquiv: '300-400mm', purpose: 'extreme compression — observation, broadcast' }
]

export const FOV_DEGREES = FOV_STEPS.map((f) => f.degrees)

/** Snaps an arbitrary FOV onto the nearest legal step. */
export function snapFov(degrees: number): number {
  return FOV_DEGREES.reduce((best, step) =>
    Math.abs(step - degrees) < Math.abs(best - degrees) ? step : best
  )
}

export interface ShotSizeToken {
  id: string
  abbr: string
  inFrame: string
}

export const SHOT_SIZES: ShotSizeToken[] = [
  { id: 'ecu', abbr: 'ECU', inFrame: 'a detail: eyes, button, headlight, hand' },
  { id: 'cu', abbr: 'CU', inFrame: 'full face / one element large' },
  { id: 'mcu', abbr: 'MCU', inFrame: 'head and shoulders' },
  { id: 'ms', abbr: 'MS', inFrame: 'roughly to the waist' },
  { id: 'ws', abbr: 'WS', inFrame: 'full figure + surroundings' },
  { id: 'ews', abbr: 'EWS', inFrame: 'scale, location' }
]

const SHOT_SIZE_MAP = new Map(SHOT_SIZES.map((s) => [s.id, s]))

export function getShotSize(id: string): ShotSizeToken | undefined {
  return SHOT_SIZE_MAP.get(id)
}

/** White balance is set in Kelvin and fixed within a scene. */
export const WHITE_BALANCE_KELVIN = [3200, 4000, 5600, 8500] as const

// ─── Law 3 — documented imperfection ────────────────────────────────────────

/**
 * The exact failure behaviours to name, per medium. Realism is prompting for
 * those failures on purpose, and MOTION failures outrank texture failures: a
 * stabilized, graded clip with grain slapped on top still reads as AI.
 */
export const IMPERFECTIONS_BY_MEDIUM: Record<string, string> = {
  '16mm': 'organic grain, gate weave, soft focus falls, light leaks, halation, slight frame jitter',
  '35mm':
    'fine grain, halation around highlights, subtle breathing on focus pulls, natural roll-off',
  'DV camcorder':
    'autofocus hunting, exposure pumping, interlaced motion, limited dynamic range, drifting framing',
  VHS: 'tracking noise, chroma bleed, softness, low contrast, tape wobble',
  'smartphone video':
    'compression artifacts, rolling shutter skew on fast pans, aggressive auto-exposure, blown windows',
  'digital cinema':
    'clean but with practical flare, natural highlight roll-off, believable shallow focus',
  'surveillance camera footage':
    'frame-rate stutter, wide-angle barrel distortion, IR wash, motion smear'
}

// ─── The anti-AI lexicon ────────────────────────────────────────────────────

/**
 * Words that look harmless and actively degrade output. The `registers` field
 * matters: `epic`, `8K` and `photoreal` fight a medium declaration in the
 * realism register, but are accurate descriptions of the target in the
 * stylized one — so the lint only complains where the term actually hurts.
 */
export interface AntiAiTerm {
  /** Matched case-insensitively as a whole word. */
  term: string
  instead: string
  /** Modes where the term degrades the result. */
  modes: PromptMode[]
}

export const ANTI_AI_TERMS: AntiAiTerm[] = [
  {
    term: 'epic',
    instead: 'name the specific framing, light or material',
    modes: ['architect', 'flow']
  },
  { term: 'amazing', instead: 'name the specific visual', modes: ['architect', 'flow', 'kinetic'] },
  {
    term: 'beautiful',
    instead: 'name the specific visual',
    modes: ['architect', 'flow', 'kinetic']
  },
  {
    term: 'stunning',
    instead: 'name the specific visual',
    modes: ['architect', 'flow', 'kinetic']
  },
  {
    term: 'masterpiece',
    instead: 'name the medium and its grain',
    modes: ['architect', 'flow', 'kinetic']
  },
  {
    term: 'hyperrealistic',
    instead: 'name the medium and its grain (it pushes toward over-sharpened plastic)',
    modes: ['architect', 'flow']
  },
  { term: '8K', instead: 'name the medium and its grain', modes: ['architect', 'flow'] },
  {
    term: 'dreamlike',
    instead: 'delete it — it pulls straight out of photorealism',
    modes: ['architect', 'flow']
  },
  {
    term: 'ethereal',
    instead: 'delete it — it pulls straight out of photorealism',
    modes: ['architect', 'flow']
  },
  {
    term: 'multiple angles',
    instead: '"single continuous shot" plus timeline beats',
    modes: ['architect', 'flow', 'kinetic']
  },
  {
    term: 'lots of movement',
    instead: 'one specific motion with one speed modifier',
    modes: ['architect', 'flow', 'kinetic']
  }
]

const wholeWord = (term: string): RegExp =>
  new RegExp(`(^|[^\\p{L}\\d])${term.replace(/ /g, '\\s+')}([^\\p{L}\\d]|$)`, 'iu')

/**
 * The anti-AI terms present in `prompt` that actually hurt in `mode`. With no
 * mode (the video's art direction is unknown), only the terms that hurt in
 * EVERY register are reported — a register-specific complaint on a prompt whose
 * register we cannot see would be a false warning, which costs more trust than
 * a missed one.
 */
export function findAntiAiTerms(prompt: string, mode?: PromptMode): AntiAiTerm[] {
  return ANTI_AI_TERMS.filter(
    (t) =>
      (mode === undefined ? t.modes.length === PROMPT_MODES.length : t.modes.includes(mode)) &&
      wholeWord(t.term).test(prompt)
  )
}

// ─── Doctrine checks (what the lint can verify mechanically) ────────────────

const EMBODIED_MARKERS = [
  'handheld',
  'shoulder-mounted',
  'the operator',
  'operator’s',
  "operator's",
  'unsteady hands',
  'the person filming',
  'no stabilization'
]
const DISEMBODIED_MARKERS = [
  'weightless invisible',
  'never a person’s viewpoint',
  "never a person's viewpoint",
  'never part of the scene',
  'invisible camera'
]

const hasAny = (prompt: string, markers: string[]): boolean => {
  const lower = prompt.toLowerCase()
  return markers.some((m) => lower.includes(m.toLowerCase()))
}

/** Which camera doctrines the prompt asserts. Both = the ugly middle. */
export function detectCameraDoctrines(prompt: string): {
  embodied: boolean
  disembodied: boolean
} {
  return {
    embodied: hasAny(prompt, EMBODIED_MARKERS),
    disembodied: hasAny(prompt, DISEMBODIED_MARKERS)
  }
}

/** True when the prompt opens on a known capture medium rather than adjectives. */
export function hasCaptureDeclaration(prompt: string): boolean {
  const opening = prompt.slice(0, 400).toLowerCase()
  return CAPTURE_DECLARATIONS.some((d) => opening.includes(d.medium.toLowerCase()))
}

const RAMP_MARKERS = [
  'speed ramp',
  'ramps into',
  'ramping',
  'snaps back to real time',
  'snaps to full speed'
]

/** True when the prompt asks for a speed ramp anywhere. */
export function mentionsSpeedRamp(prompt: string): boolean {
  return hasAny(prompt, RAMP_MARKERS)
}

/** True when ramping is declared as the governing style, in the opening. */
export function hasRampSpine(prompt: string): boolean {
  const opening = prompt.slice(0, 400).toLowerCase()
  return opening.includes('speed ramp') || opening.includes('in-camera speed ramps')
}

/**
 * Uppercase transient markers (`SNAP IN`, `CRASH ZOOM`, `HOLD`). They mark the
 * instant of change and the model reads them as beat-internal cut points —
 * three to six per prompt. More than that and they stop meaning anything.
 */
export const MAX_CAPS_TRANSIENTS = 6

export function countCapsTransients(prompt: string): number {
  // Bracketed tokens are STRUCTURE — the section headers of the sandwich and
  // the camera-mode brackets. Counting `[TIMELINE]` as a transient marker would
  // make every well-formed prompt look like it was shouting.
  const prose = prompt.replace(/\[[^\]]*\]/g, ' ')
  // Two or more consecutive capitals, as a standalone word; single-letter and
  // known non-transient tokens (ECU, MCU, FOV, 4K…) are not markers.
  const words = prose.match(/(^|[^\p{L}])([A-Z]{2,}(?:\s+[A-Z]{2,})*)(?=[^\p{L}]|$)/gu) ?? []
  const NOT_TRANSIENT = new Set([
    'ECU',
    'CU',
    'MCU',
    'MS',
    'WS',
    'EWS',
    'FOV',
    'WB',
    'POV',
    'ENG',
    'DV',
    'VHS',
    'AI',
    'ON',
    'OFF'
  ])
  return words
    .map((w) => w.trim())
    .filter((w) => !w.split(/\s+/).every((part) => NOT_TRANSIENT.has(part))).length
}

// ─── The assembler ──────────────────────────────────────────────────────────

/**
 * One beat of the timeline. Ranges (`0-3s`) produce flowing, continuous
 * sequences; exact cut markers are a MODE A / timed-multishot device and are
 * deliberately not modelled here.
 *
 * ONE camera behaviour and ONE primary subject action per beat. Background life
 * is encouraged; a second SUBJECT action is not.
 */
export interface SeedanceBeat {
  /** Seconds from the start of the clip. */
  from: number
  to: number
  /** The bracket: a camera mode (flow) or a beat title naming its job (kinetic). */
  bracket: string
  /** The single primary subject action. */
  action: string
  /** The single camera behaviour — stated separately from the action. */
  camera?: string
  /** One atmospheric detail, or the beat's uncontrolled event. */
  atmosphere?: string
}

/**
 * The BODY of the sandwich — what a node stores. The declaration and the
 * booster are deliberately NOT in here: they are provenance and texture
 * enforcement, they belong to the video's art direction, and the run engine
 * adds them at payload time from the video's CURRENT style (exactly like the
 * style bible). Storing them would freeze the universe into the prompt and
 * duplicate it on every re-wrap.
 */
export interface SeedanceBodySpec {
  /** Role sentences for the connected references. */
  references?: string[]
  beats: SeedanceBeat[]
  /** Diegetic sound only, named. */
  audio?: string
  /** Adds the oner declaration to the timeline preamble. */
  oner?: boolean
}

/** What the run engine wraps a stored body with. */
export interface SeedanceWrapSpec {
  /** The opening declaration — the domain selector. */
  declaration: string
  /** 25-40 word compression of the series look bible, carried in the opening. */
  lookCompact?: string
  /** The closing texture-enforcement stack. */
  booster: string
  /** Adds the remaining two oner declarations, in their two places. */
  oner?: boolean
  /** Short positive fixers, restated once at the very end. */
  locks?: string[]
}

export type SeedanceShotSpec = SeedanceBodySpec & SeedanceWrapSpec

const clean = (parts: Array<string | undefined | false>): string =>
  parts
    .filter((p): p is string => typeof p === 'string')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join(' ')
    .replace(/[ \t]+/g, ' ')

const formatSeconds = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1)

/** The stored half: references, the bracketed timeline, the diegetic sound. */
export function buildSeedanceBody(spec: SeedanceBodySpec): string {
  const sections: string[] = []

  if (spec.references && spec.references.length > 0) {
    sections.push(`[REFERENCES]\n${spec.references.map((r) => r.trim()).join(' ')}`)
  }

  const timeline = spec.beats
    .map((beat) =>
      clean([
        `${formatSeconds(beat.from)}-${formatSeconds(beat.to)}s: ${beat.bracket}`,
        beat.action,
        beat.camera,
        beat.atmosphere
      ])
    )
    .join('\n')
  sections.push(`[TIMELINE]\n${spec.oner ? `${ONER_DECLARATIONS.timeline}\n` : ''}${timeline}`)

  if (spec.audio) sections.push(`[AUDIO]\n${spec.audio.trim()}`)

  return sections.join('\n\n')
}

/**
 * Wraps a stored body in the sandwich: the declaration selects the universe at
 * the top, the body stays pure action, and the booster stack stops the look
 * decaying at the bottom. Repetition between top and bottom is not redundancy —
 * it is what holds the medium across fifteen seconds.
 *
 * Idempotent by construction where it matters: a body that already opens on
 * this declaration is returned untouched, so a re-wrap (a retry replaying a
 * stored payload, a prompt pasted back into a node) can never stack two
 * universes on top of each other.
 */
export function wrapSeedanceSandwich(body: string, spec: SeedanceWrapSpec): string {
  const trimmed = body.trim()
  if (trimmed.startsWith('[STYLE + CAMERA + ATMOSPHERE]')) return trimmed

  const top = `[STYLE + CAMERA + ATMOSPHERE]\n${clean([
    spec.declaration,
    spec.lookCompact,
    spec.oner ? `The take is a ${ONER_DECLARATIONS.opening}.` : undefined
  ])}`
  const bottom = `[STYLE & QUALITY BOOSTERS]\n${clean([
    spec.booster,
    spec.oner ? ONER_DECLARATIONS.booster : undefined,
    ...(spec.locks ?? [])
  ])}`

  return trimmed === '' ? `${top}\n\n${bottom}` : `${top}\n\n${trimmed}\n\n${bottom}`
}

/** Body + wrap in one call — the preview, the docs and the tests use this. */
export function buildSeedancePrompt(spec: SeedanceShotSpec): string {
  return wrapSeedanceSandwich(buildSeedanceBody(spec), spec)
}

/**
 * Beat count for a clip length — 5s → 2-3, 10s → 3-4, 15s → 4-6. Fewer beats
 * than this reads as a held shot; more turns a short clip into a slideshow.
 */
export function beatCountFor(seconds: number): number {
  if (seconds <= 5) return 2
  if (seconds <= 8) return 3
  if (seconds <= 12) return 4
  return 5
}

/** Evenly split `seconds` into `count` beat boundaries, rounded to 0.5s. */
export function beatRanges(seconds: number, count: number): Array<{ from: number; to: number }> {
  const step = seconds / count
  const round = (value: number): number => Math.round(value * 2) / 2
  return Array.from({ length: count }, (_, i) => ({
    from: i === 0 ? 0 : round(step * i),
    to: i === count - 1 ? seconds : round(step * (i + 1))
  }))
}
