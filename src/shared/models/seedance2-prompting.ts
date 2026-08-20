/**
 * Shared prompting knowledge for the Seedance 2.x family — the 2.0 tiers
 * (seedance-2, seedance-2-fast, seedance-2-mini) and seedance-2-5: identical
 * @-reference system, prompt syntax and pitfalls. What changes per generation
 * is the BUDGET (slots, per-file and combined durations) and the duration
 * ceiling, so the guide is built from one template parameterized by
 * `Seedance2ReferenceLimits` — the numbers can never drift between tiers and
 * doctrine text stays single-source.
 *
 * Distilled from ByteDance's official Seedance 2.0 prompt guide
 * (BytePlus/Volcengine doc 2222480) and the "Top 10 Seedance 2.0 Tricks"
 * e-book (Framer), cross-checked with kie.ai docs (2.5 limits from
 * docs.kie.ai/market/bytedance/seedance-2.5). Notably: the official guide
 * flags exact timestamps as UNSTABLE — shot-numbered structure is the
 * supported long-clip syntax.
 */
import { TRANSITION_CONTRACT } from '../shotContinuity'

/**
 * The MANDATORY constraint appended to every board-driven shot prompt: without
 * it the model may render the panel grid itself in the video. Single source of
 * truth — the blueprints, the prompt lint (§6.5) and the guide below all use
 * this exact sentence. It names both grid shapes the app produces: the 3x3
 * scene storyboard and the 2x2 shot board.
 */
export const ANTI_GRID_GUARD =
  'Render one single full-frame shot: no storyboard grid of any kind (no 3x3 grid, no 2x2 grid), no panel borders, no panel numbers, no split-screen or comic-panel layout.'

/**
 * The per-generation API budgets that vary inside the Seedance 2.x family —
 * kie.ai-documented bounds, mirrored on the model files' handle declarations
 * (`maxCount`/`maxTotalSeconds`). Keep the two in sync.
 */
export interface Seedance2ReferenceLimits {
  generation: '2.0' | '2.5'
  imageSlots: number
  videoSlots: number
  audioSlots: number
  /** Per-file reference video/audio length window, e.g. '2-15 s'. */
  videoSecondsEach: string
  videoTotalSeconds: number
  videoMaxMb: number
  audioSecondsEach: string
  audioTotalSeconds: number
  /** Output duration window, e.g. '4-15 s'. */
  outputSeconds: string
  /** 2.0 caps combined uploads at 12 files; 2.5 documents no combined cap. */
  combinedFilesCap?: number
}

export const SEEDANCE20_LIMITS: Seedance2ReferenceLimits = {
  generation: '2.0',
  imageSlots: 9,
  videoSlots: 3,
  audioSlots: 3,
  videoSecondsEach: '2-15 s',
  videoTotalSeconds: 15,
  videoMaxMb: 50,
  audioSecondsEach: '2-15 s',
  audioTotalSeconds: 15,
  outputSeconds: '4-15 s',
  combinedFilesCap: 12
}

export const SEEDANCE25_LIMITS: Seedance2ReferenceLimits = {
  generation: '2.5',
  imageSlots: 30,
  videoSlots: 10,
  audioSlots: 10,
  videoSecondsEach: '2-30 s',
  videoTotalSeconds: 30,
  videoMaxMb: 200,
  audioSecondsEach: '2-30 s',
  audioTotalSeconds: 30,
  outputSeconds: '4-30 s'
}

function buildSeedance2Guide(l: Seedance2ReferenceLimits): string {
  const filesCap = l.combinedFilesCap
    ? `, ≤${l.combinedFilesCap} files total`
    : ' — no combined-files cap documented, only the per-handle maxima'
  const longTakes =
    l.generation === '2.5'
      ? `

LONG TAKES & DURATION (2.5 only — the headline difference):
  - Output duration is ${l.outputSeconds} per generation: a whole 2-3-shot scene, or a single
    unbroken 30 s take, fits in ONE run. This removes most of the reasons to stitch clips —
    prefer one well-structured 20-30 s generation over three chained 8 s ones when the beats
    belong to the same scene.
  - The consistency ceiling has not moved: ~3 cuts per generation stay coherent. A 30 s run is
    either ONE continuous take (a oner: state "one continuous shot, no cuts" and give the camera
    a full path to travel) or 2-3 numbered shots — not 6.
  - Long generations amplify prompt structure: give the timeline beats in order (numbered shots
    or "[cut]" lines), each with its own camera mode, and state what the FINAL frame is — on a
    30 s run an unspecified ending drifts.
  - The API's duration=-1 (auto-length) is NOT exposed in this app: the timeline, the render and
    the credit estimate all need a declared duration.`
      : ''
  const costTrick =
    l.generation === '2.5'
      ? `  - The 2-second black-video billing trick reported on 2.0 (below) is UNVERIFIED on 2.5 —
    do not rely on it here.
  - Community-reported on 2.0: a 2-second BLACK, SILENT video connected as a @Video reference
    lowers kie.ai billing by 20-35%. Unofficial and may be patched.`
      : `  - A 2-second BLACK, SILENT video connected as a @Video reference reportedly lowers kie.ai billing
    by 20-35% (bigger discount on pricier runs). Unofficial and may be patched; never spend a
    reference slot on it that a real reference needs.`

  return `READ FIRST: the app's prompting doctrine — docs "doctrine" (§6.9,
  \`src/shared/prompting/seedance.ts\`). It governs HOW a clip prompt is shaped: the opening capture
  declaration (added from the video's style at payload time), the camera's ontology (a body or a
  ghost, never both), the bracketed timeline with one camera mode per beat, imperfection, and the
  closing booster stack. What follows is the MODEL-SPECIFIC half — Seedance ${l.generation}'s own syntax.

ANATOMY (official ByteDance order):
  Precise subject + action detail + scene/environment + lighting & color tone + camera movement
  + visual style + image quality + constraints.
Think of the prompt as a short shot brief: who, doing what, where, shot how, what it sounds like.

MODEL TIERS (same syntax — pick by job):
  - Seedance 2 Mini: cheapest and fastest (480p/720p) — drafts, animatics, high-volume iteration.
  - Seedance 2 Fast: the ANIMATION workhorse (480p/720p). A 300-generation community test found no
    visible quality difference vs full Seedance 2 for animation — iterate and ship here; 720p +
    an external upscaler beats paying for native 1080p.
  - Seedance 2: the only tier with 1080p/4k — live-action realism and final masters that must not
    go through an upscaler.
  - Seedance 2.5: the newest generation — 4-30 s per run (long takes, whole scenes in one
    generation), stronger motion/physics, and a much larger reference budget (30 images,
    10 videos, 10 audios, 30 s of reference video). Caps at 1080p: a 4k master still means
    Seedance 2, or an external upscaler.
${longTakes}

@ REFERENCES (the core of Seedance 2.x — every connected source needs an explicit ROLE):
  - Slots: @Image1-@Image${l.imageSlots}, @Video1-@Video${l.videoSlots}, @Audio1-@Audio${l.audioSlots} (numbered by connection order${filesCap}).
  - Media limits (kie.ai): images jpeg/png/webp/bmp/tiff/gif, aspect ratio 0.4-2.5, 300-6000 px,
    ≤30 MB each. Videos mp4/mov, 480p or 720p, ${l.videoSecondsEach} each, ≤${l.videoSlots} files and ≤${l.videoTotalSeconds} s total,
    ≤${l.videoMaxMb} MB each. Audio wav/mp3, ${l.audioSecondsEach} each, ≤${l.audioSlots} files and ≤${l.audioTotalSeconds} s total.
  - Assign roles verbatim: "@Image1 as the first frame", "@Image2 as the last frame",
    "reference @Video1 for camera movement and pacing", "use @Audio1 as background music",
    "Replace the woman in @Video1 with @Image1", "Extend @Video1 by 5 seconds".
  - Subject binding: define each subject ONCE with 2-3 stable traits ("the woman in the red dress from
    @Image1"), then reuse the same @ImageN on every mention. Contradictory traits cause identity drift.
  - Budget: 4-5 references is the sweet spot (1-2 character images, 1 scene, 1 camera video, 1 audio);
    more causes style collision and subject-recognition blur. The slot ceiling is an API bound,
    not a recommendation — a pile of ${l.imageSlots} references degrades, it does not enrich.
  - Omni-reference recipe: build the scene from THREE separate labeled references — environment
    (@Image1), character(s) (@Image2…), prop (@Image3) — then describe the scene with the tags.
    Explicit role-per-reference beats an unlabeled pile of images.
  - STORYBOARD recipe (pre-visualization): before spending video credits on a scene, generate ONE
    3x3 grid of 9 numbered panels showing the scene beat by beat (same characters, lighting and
    style in every panel, at the video's aspect ratio) and let the user review the staging on the
    grid. Then wire the grid as its OWN reference with an explicit role: "@Image2 is the 9-panel
    storyboard of this scene — follow its panels in order, left to right, top to bottom" (keep the
    character sheet as a separate @Image1; on multi-shot scenes, tell each shot which panels it
    covers, e.g. "this shot covers panels 4-6"). The storyboard already encodes composition and
    framing — spend the video prompt on MOTION: camera direction, rhythm, transition logic.
    MANDATORY anti-grid guard: without it the model may render the grid ITSELF in the video.
    State in the role that the storyboard is "a staging plan only, it must NEVER appear on screen",
    and append this exact constraint to every board-driven prompt:
    "${ANTI_GRID_GUARD}"
  - SHOT BOARD recipe (one board per SHOT, 2x2 grid of 4 panels): the same idea at clip resolution —
    panel 1 is the shot's exact opening frame, panels 2-3 the action, panel 4 its exact closing
    frame. It is the transition tool (see TRANSITIONS below) and the right board for 4-6s clips,
    where a 9-panel scene grid only spares one panel per clip. Same wiring rules as the storyboard.

FRAME ANCHORS (First/Last frame handles — these images APPEAR on screen literally):
  - The First frame / Last frame inputs pin the clip's exact opening/closing image (scene stills,
    hero shots — NEVER design sheets).
  - In-between technique: wire BOTH first and last frame, then prompt:
    "Show me what happens in between. USE MULTIPLE CAMERA ANGLES." — generates the full multi-shot
    story connecting the two stills.
  - THREE MUTUALLY EXCLUSIVE MODES (official kie.ai): first frame only / first + last frame /
    multimodal @ references. Never combine them in one run. Inside @ reference mode you can still
    pin a frame with "@Image1 as the first frame" — official docs present this as the way to get a
    first/last-frame effect WITH references, and recommend the dedicated inputs only when the frame
    match must be strictly guaranteed.

CUTTING BETWEEN SHOTS (read this before wiring two clips together):
  - DEFAULT: do NOT chain clips. Feeding clip N's closing frame into clip N+1 ("lastFrame chaining")
    looks like continuity on paper and glitches in practice: the closing frame of a generated clip
    is motion-blurred and compressed, so the next clip re-interprets a degraded still and the seam
    pops — warping faces, sliding backgrounds, a visible hitch on the cut.
  - Do this instead: treat every new clip as a CUT to a new camera setup — change the angle, the
    lens or the axis, and say so in the prompt ("New camera setup: this is a cut, not a continuation
    of the previous shot."). Carry consistency with SHARED REFERENCES — the same character sheet and
    the same storyboard wired as @Image references on every shot — not with the previous frame.
  - When continuity is genuinely required (a character speaking across two clips, an unbroken
    move), use VIDEO EXTEND: wire the previous CLIP as @Video1 and describe what happens next. It
    carries environment, appearance and voice; the closing still carries none of that.
  - Anchoring several shots on the SAME clean source still (a hero product shot, a scene still) is
    fine and often ideal — it is a pristine image, not a generated frame. That is re-anchoring, not
    chaining.

TRANSITIONS (shared references are NOT enough — this is what makes two clips one sequence):
  - Same sheets, same style, and two consecutive clips still read as two different films, because
    nothing told shot N+1 what shot N ended on. Write the hand-off into the prompts:
      ${TRANSITION_CONTRACT}
  - Name the cut when it carries meaning: "hard cut on the impact", "cut on the movement — she
    exits frame right, the next shot picks her up entering frame left".
  - SHOT BOARD (2x2, 4 panels — one per shot): panel 1 is the shot's exact opening frame, panels
    2-3 the action, panel 4 its exact closing frame. Board two consecutive shots and write shot
    N+1's panel 1 as shot N's panel 4: the cut is settled on a cheap image instead of on two video
    generations. On 4-6s clips this beats a 9-panel scene storyboard, which spares each clip one
    panel. Wire it as a reference with a role, plus the anti-grid guard — like any board.
  - PREVIOUS CLIP AS @Video: the strongest carrier (grade, texture, wardrobe, voice) and the most
    expensive — it serializes generation and a re-roll invalidates the shots after it. Role:
    "@Video1 is the PREVIOUS shot — match its lighting, grade, wardrobe, set and character
    appearance; do NOT continue its action or camera: this shot is a CUT to a new setup." Mind the
    handle budget (${l.videoSlots} files, ${l.videoTotalSeconds}s combined). Use it on the cuts that matter, not on every pair.
  - SHOT LENGTH: the API floor is 4s. A script beat shorter than that is MERGED with its
    neighbour or covered by a longer shot — never rounded down, and never silently stretched
    without saying what it does to the film's total length.

MULTI-SHOT (long clips — 10s+):
  Shot 1: [camera move] + [subject action/expression] + [location] + [audio].
  Shot 2: Cut to ... (one camera movement per shot; ~3 cuts per generation stay consistent)
  Alternative that tests well for continuations: separate consecutive beats with "[cut]" lines.
  DO NOT use exact timestamps ("0-3s:") — officially flagged as unstable.

DIALOGUE, AUDIO & LIP-SYNC:
  - Quoted dialogue works on API platforms: She says: "Keep lines short." State language and tone.
  - PERFECT LIP-SYNC with a custom voice-over: render the VO (real voice or ElevenLabs) into a
    BLANK black video carrying only the audio track, connect it as a @Video reference, put the
    exact spoken lines in the prompt and add "Use the exact audio from the attached file".
    Reusing the same cloned voice across clips keeps a series' voices consistent. Lip-sync accuracy
    rises the closer the character is to camera — frame tighter if sync drifts.
  - SINGING (music videos): cut the song into 5-15s clips, render each as a blank video, one per
    generation; describe the performance and include the exact lyrics sung in that clip.
  - Voice cloning by reference: "low, warm male voice from @Audio1".
  - The model scores everything by default — write "no music" explicitly if you want silence.

VIDEO-TO-VIDEO RECIPES (connect an existing clip as @Video1):
  - VIDEO EXTEND — the ONLY reliable continuity tool: connect the previous clip as @Video1 and
    describe what happens next as "[cut]"-separated beats. Preserves environment, character
    appearance AND voice, where lastFrame chaining carries a single degraded still and glitches on
    the seam (see CUTTING BETWEEN SHOTS). Use it whenever a character speaks across consecutive
    clips or the motion must not break; otherwise just cut to a new angle.
  - CHARACTER SWAP: "Change the [subject] in @Video1 to the [subject] in @Image1." Re-shoots the
    exact same actions with the new character.
  - FIX THE SCENE: edits propagate across ALL shots of the referenced clip — objects, season, time
    of day, interiors: "Change the season in @Video1 to winter", "Change the kitchen interior in
    @Video1 to the interior in @Image1. Replace the sausage with a burnt grilled-cheese sandwich."
    Several changes in one run work.

IDEATION SHORTCUTS (when stuck):
  - A location/building still → "Show me who lives inside this [building] and what they do inside."
  - A start and an end image → the in-between technique above.

STYLE & QUALITY (required — prevents style collapse toward photorealism):
  - Always include a strong style keyword: "2D anime", "3D CG fantasy", "vintage film", "cyberpunk
    cool blue-purple", "high-end commercial style"... plus a quality tail: "high-definition, rich
    detail, cinematic texture, natural color, soft lighting".
  - Standard constraint line to append: "faces stable, smooth motion, no stutter or flicker,
    no subtitles, no watermarks, no duplicate identical characters".
  - When the video belongs to a styled workflow, append the video's style bible verbatim.

PITFALLS (official troubleshooting):
  - Identity drift → clean headshot + separate full-body reference; put the priority reference first.
  - Burned-in subtitles → "no subtitles" constraint + text-free reference sources.
  - Anime drifting photoreal → the style keyword is missing or too weak.
  - "Twin" subject duplication → single-subject references + "no identical duplicates".
  - Adjective stacking ("stunning, gorgeous") does nothing — spend words on verbs and physics.

COST (kie.ai-specific, community-reported — verify on the account before relying on it):
${costTrick}
  - For animation, iterate on Fast/Mini at 720p and upscale rather than paying for native 1080p.

FULL EXAMPLE (official pattern):
  "Girl @Image1 as protagonist, @Image2 as scene style reference, reference @Video1's camera movement.
  Shot 1: Late afternoon, girl @Image1 walks briskly to the door, medium tracking shot, warm golden light.
  Shot 2: Cut to indoor medium shot, roommates look up, one asks: 'How did the exam go?', camera pans.
  Shot 3: Close-up, she lowers her head, then looks up laughing: 'Just kidding!', camera pulls back wide.
  HD cinematic documentary style, warm tone, soft lighting; faces stable, smooth motion, no subtitles."`
}

/** The 2.0-family guide (seedance-2, seedance-2-fast, seedance-2-mini). */
export const SEEDANCE2_PROMPT_GUIDE = buildSeedance2Guide(SEEDANCE20_LIMITS)

/** The seedance-2-5 guide — same doctrine, 2.5 budgets + the long-take section. */
export const SEEDANCE25_PROMPT_GUIDE = buildSeedance2Guide(SEEDANCE25_LIMITS)
