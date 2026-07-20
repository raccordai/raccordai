/**
 * Shared prompting knowledge for the Seedance 2.0 family (seedance-2,
 * seedance-2-fast, seedance-2-mini): identical @-reference system, prompt
 * syntax and pitfalls — the tiers only differ in speed and resolution.
 *
 * Distilled from ByteDance's official Seedance 2.0 prompt guide
 * (BytePlus/Volcengine doc 2222480) and the "Top 10 Seedance 2.0 Tricks"
 * e-book (Framer), cross-checked with kie.ai docs. Notably: the official
 * guide flags exact timestamps as UNSTABLE — shot-numbered structure is the
 * supported long-clip syntax.
 */
export const SEEDANCE2_PROMPT_GUIDE = `ANATOMY (official ByteDance order):
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

@ REFERENCES (the core of Seedance 2.0 — every connected source needs an explicit ROLE):
  - Slots: @Image1-@Image9, @Video1-@Video3, @Audio1-@Audio3 (numbered by connection order, ≤12 files total).
  - Assign roles verbatim: "@Image1 as the first frame", "@Image2 as the last frame",
    "reference @Video1 for camera movement and pacing", "use @Audio1 as background music",
    "Replace the woman in @Video1 with @Image1", "Extend @Video1 by 5 seconds".
  - Subject binding: define each subject ONCE with 2-3 stable traits ("the woman in the red dress from
    @Image1"), then reuse the same @ImageN on every mention. Contradictory traits cause identity drift.
  - Budget: 4-5 references is the sweet spot (1-2 character images, 1 scene, 1 camera video, 1 audio);
    more causes style collision and subject-recognition blur.
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

FRAME ANCHORS (First/Last frame handles — these images APPEAR on screen literally):
  - The First frame / Last frame inputs pin the clip's exact opening/closing image (scene stills,
    hero shots, the previous clip's lastFrame — NEVER design sheets).
  - In-between technique: wire BOTH first and last frame, then prompt:
    "Show me what happens in between. USE MULTIPLE CAMERA ANGLES." — generates the full multi-shot
    story connecting the two stills.
  - Frame anchoring and multimodal @ references are mutually exclusive (official) — one mode per
    run. Inside @ reference mode you can still pin a frame with "@Image1 as the first frame".

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
  - VIDEO EXTEND — the strongest continuity tool: connect the previous clip as @Video1 and describe
    what happens next as "[cut]"-separated beats. Preserves environment, character appearance AND
    voice — unlike lastFrame chaining, which only carries the closing image. Prefer it whenever a
    character speaks across consecutive clips.
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
  - A 2-second BLACK, SILENT video connected as a @Video reference reportedly lowers kie.ai billing
    by 20-35% (bigger discount on pricier runs). Unofficial and may be patched; never spend a
    reference slot on it that a real reference needs.
  - For animation, iterate on Fast/Mini at 720p and upscale rather than paying for native 1080p.

FULL EXAMPLE (official pattern):
  "Girl @Image1 as protagonist, @Image2 as scene style reference, reference @Video1's camera movement.
  Shot 1: Late afternoon, girl @Image1 walks briskly to the door, medium tracking shot, warm golden light.
  Shot 2: Cut to indoor medium shot, roommates look up, one asks: 'How did the exam go?', camera pans.
  Shot 3: Close-up, she lowers her head, then looks up laughing: 'Just kidding!', camera pulls back wide.
  HD cinematic documentary style, warm tone, soft lighting; faces stable, smooth motion, no subtitles."`
