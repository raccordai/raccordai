/**
 * Demo mode (§9) — the renderer-side pure part of the capture upload: base64
 * chunking of the MediaRecorder blobs. (The input journal itself is main's
 * business — machine-wide hook + demo:point — since every take films a whole
 * display through one path.)
 */

/**
 * Bytes → base64 strings sized for the IPC boundary (the handle() wrapper
 * zod-parses every payload, so one giant string is off the table). The
 * 0x8000-slice String.fromCharCode loop avoids the spread-arg stack overflow
 * on big buffers.
 */
export function toBase64Chunks(bytes: Uint8Array, maxChars = 4_000_000): string[] {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  const base64 = btoa(binary)
  // Main decodes each chunk independently (Buffer.from per appendChunk), so
  // every cut must land on a 4-char base64 boundary (4 chars = 3 bytes).
  const step = Math.max(4, maxChars - (maxChars % 4))
  const chunks: string[] = []
  for (let i = 0; i < base64.length; i += step) {
    chunks.push(base64.slice(i, i + step))
  }
  return chunks
}
