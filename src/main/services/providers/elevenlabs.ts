import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mimeTypeFor } from '../../media/files'
import { elevenlabsGenerateAudio } from '../elevenlabs'
import { maxPollAttemptsFor, POLL_INTERVAL_MS } from '../genQueue'
import { getElevenLabsApiKey } from '../settings'
import { CLOUD_QUEUE_KEY } from './kie'
import type { GenerationProvider } from './types'

/**
 * ElevenLabs provider — SYNCHRONOUS: one HTTP call returns the finished
 * audio, so there is nothing to poll. `submit` runs the call inside the
 * queue slot, stages the mp3 in a temp file and returns that file's
 * `file://` URL as the task ref; `status` reports success while the file
 * exists (a restart that lost the staging file fails the run and the engine's
 * smart retry re-submits from the input snapshot); `fetchResult` copies the
 * staged file into the media store instead of downloading.
 */

export const ELEVENLABS_KEY_MISSING_MESSAGE =
  'ElevenLabs API key is not configured. Add it in Settings → Integrations.'

/** Where submit stages the finished audio until the engine copies it into the media store. */
export const SPEECH_STAGING_DIR = join(tmpdir(), 'raccord-speech')

export const elevenlabsProvider: GenerationProvider = {
  id: 'elevenlabs',
  label: 'ElevenLabs',
  queueKey: CLOUD_QUEUE_KEY,
  assertConfigured() {
    if (!getElevenLabsApiKey()) throw new Error(ELEVENLABS_KEY_MISSING_MESSAGE)
  },
  async submit({ generationId, payload }) {
    const result = await elevenlabsGenerateAudio(payload)
    mkdirSync(SPEECH_STAGING_DIR, { recursive: true })
    const staged = join(SPEECH_STAGING_DIR, `speech-${generationId}.mp3`)
    writeFileSync(staged, result.audio)
    return { taskRef: pathToFileURL(staged).href, transcript: result.transcript }
  },
  async status(taskRef) {
    if (taskRef.startsWith('file://') && existsSync(fileURLToPath(taskRef))) {
      return { state: 'success', resultUrl: taskRef }
    }
    return {
      state: 'fail',
      failMsg: 'ElevenLabs result staging file is gone (app restarted mid-run?)'
    }
  },
  async fetchResult({ resultUrl, targetFor }) {
    // Node's fetch refuses file:// URLs — copy the staged file into the store.
    const source = fileURLToPath(resultUrl)
    const path = targetFor(extname(source) || '.mp3')
    copyFileSync(source, path)
    rmSync(source, { force: true })
    return { path, mimeType: mimeTypeFor(path) }
  },
  poll: { intervalMs: POLL_INTERVAL_MS, maxAttempts: maxPollAttemptsFor }
}
