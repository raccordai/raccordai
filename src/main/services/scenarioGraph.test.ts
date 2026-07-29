import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { planScenario, type ScenarioBeat } from '@shared/scenario'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { assets } from '../db/schema'
import { createProject } from './projects'
import { createVideo, setVideoScenario } from './videos'
import { listGraph } from './graph'
import { historyState, undoGraph } from './graphHistory'
import { createCasting } from './casting'
import { buildGraphFromScenario, planScenarioGraph } from './scenarioGraph'

let db: Db
let projectId: string
let videoId: string

const SEEDANCE2 = 'bytedance/seedance-2-fast'
const SEEDANCE_15 = 'bytedance/seedance-1.5-pro'

beforeEach(() => {
  db = useTestDatabase()
  projectId = createProject('Test project').id
  videoId = createVideo(projectId, 'Test video').id
})

afterEach(() => resetTestDatabase())

/** "LE COLIS" again — the script the scenario planner was built on. */
const BEATS: ScenarioBeat[] = [
  {
    title: 'Le sac',
    action: 'Gloved hands buckle a backpack strap.',
    seconds: 4,
    camera: 'insert macro sur la boucle',
    closesOn: 'the buckle snapping shut'
  },
  {
    title: 'La sortie',
    action: 'Maya bursts out of the car park.',
    seconds: 6,
    camera: 'travelling latéral',
    closesOn: 'Maya entering the neon street',
    screenDirection: 'left-to-right',
    roles: ['Maya']
  },
  {
    title: 'Le regard',
    action: 'She looks back over her shoulder.',
    seconds: 5,
    camera: 'gros plan',
    closesOn: 'her eyes flicking back to the road',
    roles: ['Maya']
  }
]

function writeScenario(modelId = SEEDANCE2, beats = BEATS): void {
  setVideoScenario(videoId, planScenario({ brief: 'Une course', modelId, beats }))
}

function insertSheet(name = 'Maya — character sheet'): string {
  const id = randomUUID()
  db.insert(assets)
    .values({
      id,
      projectId,
      key: `asset-${id.slice(0, 6)}`,
      name,
      kind: 'image',
      filePath: null,
      sourceUrl: 'https://example.com/maya.png',
      designId: 'character',
      designSubject: 'Maya, 24, courier',
      createdAt: Date.now()
    })
    .run()
  return id
}

const nodeByKey = (key: string) => listGraph(videoId).nodes.find((n) => n.key === key)
const paramsOf = (key: string) => (nodeByKey(key)!.params ?? {}) as Record<string, unknown>

describe('planScenarioGraph', () => {
  it('reports the preset, the duration and the reason for every shot, touching nothing', () => {
    writeScenario()
    const plan = planScenarioGraph({ videoId })

    expect(plan.shotCount).toBe(3)
    expect(plan.build.map((entry) => entry.recipeId)).toEqual([
      'shot-insert',
      'shot-tracking',
      'shot-reaction'
    ])
    expect(plan.build.map((entry) => entry.seconds)).toEqual([4, 6, 5])
    expect(plan.build[0]!.reason).toContain('insert')
    expect(listGraph(videoId).nodes).toHaveLength(0)
    expect(historyState(videoId).canUndo).toBe(false)
  })

  it('resolves the scenario’s role names against the project’s cast', () => {
    writeScenario()
    const castingId = createCasting({ projectId, name: 'Maya', assetId: insertSheet() }).id

    const plan = planScenarioGraph({ videoId })
    expect(plan.build[1]!.roles).toEqual([{ name: 'Maya', castingId }])
    expect(plan.unknownRoles).toEqual([])
  })

  it('names a role the cast does not know instead of failing on it', () => {
    writeScenario()
    const plan = planScenarioGraph({ videoId })
    expect(plan.unknownRoles).toEqual(['Maya'])
  })

  it('refuses a video with no scenario, pointing at the step that writes one', () => {
    expect(() => planScenarioGraph({ videoId })).toThrow(/write_scenario/)
  })
})

describe('buildGraphFromScenario', () => {
  it('creates one preset node per shot, keyed and labelled like the shot list', () => {
    writeScenario()
    const result = buildGraphFromScenario({ videoId })

    expect(result.created.map((entry) => entry.key)).toEqual(['shot-01', 'shot-02', 'shot-03'])
    expect(listGraph(videoId).nodes.map((n) => n.label)).toEqual([
      'Le sac',
      'La sortie',
      'Le regard'
    ])
    expect(nodeByKey('shot-02')!.modelId).toBe(SEEDANCE2)
  })

  it('carries the shot’s legal duration into the param', () => {
    writeScenario()
    buildGraphFromScenario({ videoId })
    expect(paramsOf('shot-01').duration).toBe(4)
    expect(paramsOf('shot-02').duration).toBe(6)
    expect(paramsOf('shot-03').duration).toBe(5)
  })

  it('writes the beat timeline against that same length, never the preset’s', () => {
    setVideoScenario(
      videoId,
      planScenario({
        brief: 'Un plan long',
        modelId: SEEDANCE2,
        // A 12 s insert: the preset defaults to 4 s, the scenario says 12.
        beats: [{ title: 'Le colis', action: 'The parcel sits.', seconds: 12, camera: 'insert' }]
      })
    )
    buildGraphFromScenario({ videoId })

    // The insert preset is a 4 s shot: without the override the prompt would
    // ship a 4 s timeline inside a 12 s clip.
    expect(paramsOf('shot-01').duration).toBe(12)
    expect(String(paramsOf('shot-01').prompt)).toContain('9-12s:')
  })

  it('writes the shot’s opening and closing frames into the prompt', () => {
    writeScenario()
    buildGraphFromScenario({ videoId })
    const prompt = String(paramsOf('shot-02').prompt)
    expect(prompt).toContain('OPENS ON')
    expect(prompt).toContain('Maya entering the neon street')
  })

  it('keeps the recipe markers so the lint and the params panel still recognize the node', () => {
    writeScenario()
    buildGraphFromScenario({ videoId })
    const params = paramsOf('shot-02')
    expect(params.recipeId).toBe('shot-tracking')
    expect(params.recipeMode).toBe('text')
    expect(params.applyVideoStyle).toBe(true)
    // A shot is not a design sheet — that marker would fire the sheet rules.
    expect(params.designId).toBeUndefined()
  })

  it('casts the scenario’s roles onto exactly the shots that name them', () => {
    writeScenario()
    const castingId = createCasting({ projectId, name: 'Maya', assetId: insertSheet() }).id

    const result = buildGraphFromScenario({ videoId })
    expect(result.cast).toHaveLength(1)
    expect(result.cast[0]!.castingId).toBe(castingId)
    expect(result.cast[0]!.nodeIds).toHaveLength(2)

    const graph = listGraph(videoId)
    const sheetNode = graph.nodes.find((n) => n.modelId === 'studio/asset')!
    const wired = graph.edges.filter((e) => e.sourceNodeId === sheetNode.id)
    expect(wired.map((e) => e.targetNodeId).sort()).toEqual(
      [nodeByKey('shot-02')!.id, nodeByKey('shot-03')!.id].sort()
    )
    // The reference is addressed in the prompt, never left to guide by accident.
    expect(String(paramsOf('shot-02').prompt)).toContain('Maya')
    expect(String(paramsOf('shot-01').prompt)).not.toContain('@Image1')
  })

  it('is ONE undo step — the user built a film, they undo a film', () => {
    writeScenario()
    createCasting({ projectId, name: 'Maya', assetId: insertSheet() })
    buildGraphFromScenario({ videoId })
    expect(listGraph(videoId).nodes.length).toBe(4) // 3 shots + the sheet

    undoGraph(videoId)
    expect(listGraph(videoId).nodes).toHaveLength(0)
    expect(listGraph(videoId).edges).toHaveLength(0)
  })

  it('never chains one shot into the next — between shots you cut', () => {
    writeScenario()
    buildGraphFromScenario({ videoId })
    const graph = listGraph(videoId)
    const shotIds = new Set(graph.nodes.filter((n) => n.key.startsWith('shot-')).map((n) => n.id))
    expect(graph.edges.filter((e) => shotIds.has(e.sourceNodeId))).toEqual([])
  })

  it('rebuilds by adding, never by duplicating', () => {
    writeScenario()
    buildGraphFromScenario({ videoId })

    writeScenario(SEEDANCE2, [
      ...BEATS,
      { title: 'La chute', action: 'The bag hits the ground.', seconds: 4, camera: 'insert' }
    ])
    const second = buildGraphFromScenario({ videoId })

    expect(second.created.map((entry) => entry.key)).toEqual(['shot-04'])
    expect(second.alreadyBuilt.map((entry) => entry.key)).toEqual(['shot-01', 'shot-02', 'shot-03'])
    expect(listGraph(videoId).nodes).toHaveLength(4)
  })

  it('costs no undo step when there is nothing left to build', () => {
    writeScenario()
    buildGraphFromScenario({ videoId })
    const before = historyState(videoId)
    const again = buildGraphFromScenario({ videoId })

    expect(again.created).toEqual([])
    expect(historyState(videoId)).toEqual(before)
  })

  it('builds only the shots asked for, and rejects an unknown key', () => {
    writeScenario()
    const result = buildGraphFromScenario({ videoId, shotKeys: ['shot-02'] })

    expect(result.created.map((entry) => entry.key)).toEqual(['shot-02'])
    expect(listGraph(videoId).nodes).toHaveLength(1)
    expect(() => buildGraphFromScenario({ videoId, shotKeys: ['shot-99'] })).toThrow(/shot-99/)
  })

  it('degrades a preset the scenario’s model cannot run, and says so', () => {
    writeScenario(SEEDANCE_15)
    const plan = planScenarioGraph({ videoId })
    expect(plan.build[0]!.recipeId).toBe('shot-reaction') // no insert on 1.5
    expect(plan.build[0]!.notes.join(' ')).toContain('shot-insert')

    buildGraphFromScenario({ videoId })
    expect(nodeByKey('shot-01')!.modelId).toBe(SEEDANCE_15)
    // Seedance 1.5 locks the camera with a real param, not with prompt words.
    expect(paramsOf('shot-01').fixed_lens).toBe(true)
  })

  it('lays the shots out in shot order, one row each', () => {
    writeScenario()
    buildGraphFromScenario({ videoId })
    const positions = ['shot-01', 'shot-02', 'shot-03'].map((key) => nodeByKey(key)!.position)
    expect(new Set(positions.map((p) => p.x)).size).toBe(1)
    expect(positions[0]!.y).toBeLessThan(positions[1]!.y)
    expect(positions[1]!.y).toBeLessThan(positions[2]!.y)
  })
})
