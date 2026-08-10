/**
 * Fixed default port so external clients (MCP config, CLI tools) can point
 * at a stable address. Overridable via the `localApiPort` setting.
 */
export const DEFAULT_LOCAL_API_PORT = 4517

/**
 * Variants ×N (§6.6): how many parallel generations one node may claim in a
 * single run. Deliberately small — each variant is a full queue slot and a full
 * credit charge; the grid compare is built for 2–4 candidates side by side.
 */
export const MAX_VARIANTS = 4

/**
 * Audio-lane volume gain bounds (1 = original, 2 = +6 dB). Standalone here
 * because both contracts.ts and timeline.ts need them (either would cycle).
 */
export const VOLUME_MIN = 0
export const VOLUME_MAX = 2

/**
 * Clip speed bounds (1 = original). 0.25–4 keeps the audio pitch correction
 * inside two chained `atempo` stages at render time.
 */
export const SPEED_MIN = 0.25
export const SPEED_MAX = 4

/**
 * Per-project Instructions (markdown methodology) size cap — the block is
 * appended to the assistant's system prompt every turn, so an unbounded blob
 * would bloat every request. ~5k tokens. Enforced at write time (IPC zod +
 * service), never truncated at read time.
 */
export const PROJECT_INSTRUCTIONS_MAX_CHARS = 20_000

/**
 * MP4 export quality/codec choices — standalone here because contracts.ts and
 * the (main-side) render plan both need them. 'standard' reproduces the
 * historical encoder args byte for byte; 'hevc' always forces the normalize
 * path (stream copy cannot transcode).
 */
export const RENDER_QUALITIES = ['draft', 'standard', 'high'] as [string, ...string[]]
export const RENDER_CODECS = ['h264', 'hevc'] as [string, ...string[]]
