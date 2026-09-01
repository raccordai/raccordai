import { getModel, type ModelDefinition } from '@shared/models'
import type { ModelProvider } from '@shared/models/types'
import { elevenlabsProvider } from './elevenlabs'
import { kieJobsProvider, kieSunoProvider } from './kie'
import type { GenerationProvider } from './types'

/**
 * THE provider map: `ModelDefinition.provider` → the object that drives that
 * API family. A new family is one file next to this one + one entry here.
 */
const PROVIDERS: Record<ModelProvider, GenerationProvider> = {
  jobs: kieJobsProvider,
  suno: kieSunoProvider,
  elevenlabs: elevenlabsProvider
}

/** The provider for a model definition (`jobs` when the model declares none). */
export function providerOf(model: ModelDefinition | undefined): GenerationProvider {
  return PROVIDERS[model?.provider ?? 'jobs']
}

/**
 * The provider a model id runs on. An unknown id (registry change between
 * versions, `studio/asset`) resolves to the default family so the callers
 * that only need a queue key or a poll policy keep working.
 */
export function providerFor(modelId: string): GenerationProvider {
  return providerOf(getModel(modelId))
}

export type {
  FetchResultArgs,
  FetchedResult,
  GenerationProvider,
  InputPublisher,
  PollPolicy,
  PublishInputArgs,
  PublishedInput,
  RemoteStatus,
  SubmitArgs,
  SubmitResult
} from './types'
