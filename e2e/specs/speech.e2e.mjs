/**
 * Speech end to end (§8): the ElevenLabs chain the unit tests cannot cross —
 * a TTS node runs through the SYNCHRONOUS provider branch of the run engine
 * (no poller round-trip on the mock's side, a file:// staging hand-off inside
 * main), the audio lands in the media store like any kie result, and the timed
 * transcript is stored on the generation and served back through the typed
 * generation DTO and the get_transcript agent tool.
 *
 * Also pins: the dialogue script → per-speaker payload resolution against a
 * voice persona's id (the channel-consistency mechanism), and the voices
 * listing that feeds the pickers.
 */
import { launchApp } from '../harness/app.mjs'
import { startKieMock } from '../harness/kie-mock.mjs'
import { check, checkEqual, defer, spec, step, waitFor } from '../harness/spec.mjs'

await spec('speech', async () => {
  const mock = await startKieMock({})
  defer(() => mock.close())
  const app = await launchApp({ kieBase: mock.base })
  defer(() => app.close())
  const { invoke } = app

  step('a voice persona names the channel voice')
  const persona = await invoke('voicePersonas:create', {
    name: 'Narrateur',
    voiceId: 'mock-voice-a',
    description: 'calm, warm'
  })
  checkEqual(persona.name, 'Narrateur', 'persona created')
  const voices = await invoke('speech:listVoices', {})
  check(
    voices.voices.some((v) => v.voiceId === 'mock-voice-a'),
    'the ElevenLabs voices listing reaches the mock'
  )

  step('a TTS node runs synchronously and stores its timed transcript')
  const project = await invoke('projects:create', { name: 'E2E — Speech' })
  const video = await invoke('videos:create', { projectId: project.id, name: 'VO test' })
  const ttsNode = await invoke('nodes:create', {
    videoId: video.id,
    modelId: 'elevenlabs/text-to-speech',
    position: { x: 0, y: 0 },
    params: { prompt: 'Hello world. Second sentence.', voiceId: persona.voiceId }
  })
  await invoke('generations:run', { nodeId: ttsNode.id })
  const ttsGen = await waitFor(
    async () => {
      const gens = await invoke('generations:listForNode', { nodeId: ttsNode.id })
      return gens.find((g) => g.status === 'success' && g.url) ?? null
    },
    { label: 'the TTS generation settles and downloads' }
  )
  check(ttsGen.url?.startsWith('media://'), 'the audio landed in the local media store')
  check(ttsGen.transcript !== null, 'the generation carries a transcript')
  checkEqual(ttsGen.transcript.segments.length, 2, 'one segment per sentence')
  checkEqual(ttsGen.transcript.segments[0].start, 0, 'segments are timestamped')

  const sent = mock.recorded.elevenlabs.find((r) => r.endpoint === 'tts')
  checkEqual(sent?.voiceId, 'mock-voice-a', "the persona's voice id reached the API")
  checkEqual(sent?.input.model_id, 'eleven_v3', 'eleven_v3 is the submitted model')

  step('a dialogue node resolves its script against the voice map')
  const dialogueNode = await invoke('nodes:create', {
    videoId: video.id,
    modelId: 'elevenlabs/text-to-dialogue',
    position: { x: 0, y: 300 },
    params: {
      prompt: 'Léa: Bonjour !\nMarc: Salut.',
      voiceMap: `Léa = mock-voice-b\nMarc = ${persona.voiceId}`
    }
  })
  await invoke('generations:run', { nodeId: dialogueNode.id })
  const dialogueGen = await waitFor(
    async () => {
      const gens = await invoke('generations:listForNode', { nodeId: dialogueNode.id })
      return gens.find((g) => g.status === 'success' && g.url) ?? null
    },
    { label: 'the dialogue generation settles' }
  )
  const dialogueSent = mock.recorded.elevenlabs.find((r) => r.endpoint === 'dialogue')
  checkEqual(dialogueSent?.input.inputs.length, 2, 'one API cue per script line')
  checkEqual(dialogueSent?.input.inputs[0].voice_id, 'mock-voice-b', 'Léa got her mapped voice')
  check(
    !('speaker' in (dialogueSent?.input.inputs[0] ?? {})),
    'the speaker label never leaks into the API payload'
  )
  checkEqual(
    dialogueGen.transcript.segments.map((s) => s.speaker).join(','),
    'Léa,Marc',
    'the stored transcript keeps the speaker labels'
  )

  step('the get_transcript agent tool serves the formatted transcript')
  const viaTool = await app.mcp('get_transcript', { nodeId: ttsNode.id })
  check(viaTool.formatted.includes('[0:00]'), 'formatted transcript carries timestamps')
})
