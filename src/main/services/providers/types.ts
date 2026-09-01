import type { ModelKind } from '@shared/models'
import type { ModelProvider } from '@shared/models/types'
import type { SpeechTranscript } from '@shared/speech'

/**
 * A generation provider is everything the run engine needs to drive one API
 * family end to end: submit a payload, poll it, fetch the result, and publish
 * the run's local input media in a form the provider can read. The engine
 * owns the lifecycle (queue slots, smart retry, settle, download into the
 * media store, last-frame extraction); a provider owns only the wire.
 *
 * `ModelDefinition.provider` names the family; `providerFor` (index.ts)
 * resolves it. Adding a family = one file here + one entry in the map —
 * the engine never branches on the provider id.
 */

export interface RemoteStatus {
  state: 'success' | 'fail' | 'pending'
  /** Where the result can be fetched from (http(s), or file:// for a locally staged result). */
  resultUrl?: string
  /** Terminal failure detail — keep any provider status code in it, the smart
   *  retry classifier reads it to tell permanent (4xx) from transient. */
  failMsg?: string
}

export interface SubmitArgs {
  generationId: string
  /** The SUBMITTED model id (the draft one under draft mode). */
  modelId: string
  payload: Record<string, unknown>
}

export interface SubmitResult {
  /**
   * Opaque handle the engine persists (`generations.kieTaskId`) and hands back
   * to `status`/`fetchResult`. A remote job id for asynchronous APIs; a
   * synchronous provider stages its result and returns a `file://` URL.
   */
  taskRef: string
  /** Speech providers return the timed transcript with the audio — it only
   *  exists in the submit response, so it lands on the row right away. */
  transcript?: SpeechTranscript
}

export interface FetchResultArgs {
  taskRef: string
  resultUrl: string
  kind: ModelKind | undefined
  /** Destination path in the media store for the extension the provider picks. */
  targetFor(ext: string): string
}

export interface FetchedResult {
  path: string
  /** A media mime type (video/, audio/, image/) or null when unknown. */
  mimeType: string | null
}

export interface PublishInputArgs {
  localPath: string
  /** What the file is, for the provider's own bucketing/naming. */
  purpose: 'assets' | 'frames' | 'results'
  /** The reference this file was last published under, if any (engine-persisted cache). */
  cached: { ref: string | null; at: number | null }
}

export interface PublishedInput {
  /** The reference the model payload consumes (a public URL for kie.ai). */
  ref: string
  /** True when `cached.ref` was reused as-is — the engine skips the cache write. */
  reused: boolean
}

/**
 * How a provider reads the run's input media. Local desktop files have no
 * public URL, so each provider publishes them its own way (kie.ai: File
 * Upload API with a TTL; a local server: its own upload endpoint).
 */
export interface InputPublisher {
  /** Whether an http(s) URL the engine already holds can be passed as-is
   *  (a kie.ai CDN result is fetchable by kie itself — while it lasts). */
  acceptsRemoteUrl(url: string): Promise<boolean>
  publish(args: PublishInputArgs): Promise<PublishedInput>
}

export interface PollPolicy {
  /** Delay between two status checks. */
  intervalMs: number
  /** Attempts before the engine settles the row as a (recoverable) timeout. */
  maxAttempts(kind: ModelKind | undefined): number
}

export interface GenerationProvider {
  id: ModelProvider
  /** Human name for error messages ("kie.ai", "ElevenLabs"). */
  label: string
  /**
   * Which concurrency budget the provider's runs draw from. The
   * `maxConcurrentGenerations` setting is ONE budget shared by every hosted
   * provider (historical behavior, key `cloud`); a local provider declares its
   * own key so a long GPU render never blocks the hosted queue.
   */
  queueKey: string
  /** Throws the user-facing "configure your key" message when the provider cannot run. */
  assertConfigured(): void
  /**
   * Submits one run. Owns its own transient-retry policy (createTask retries
   * 5xx with backoff); a throw here goes to the engine's smart retry, so keep
   * status codes in the message.
   */
  submit(args: SubmitArgs): Promise<SubmitResult>
  status(taskRef: string): Promise<RemoteStatus>
  /**
   * Present when a result is not a plain http(s) download (a synchronous
   * provider staged it locally). Absent = the engine streams `resultUrl` into
   * the media store with `resultRequestHeaders`, if any.
   */
  fetchResult?(args: FetchResultArgs): Promise<FetchedResult>
  /** Extra headers for the default result download (authenticated remote hosts). */
  resultRequestHeaders?(resultUrl: string): Record<string, string>
  poll: PollPolicy
  /** Absent when no model of this provider takes media inputs. */
  inputs?: InputPublisher
}
