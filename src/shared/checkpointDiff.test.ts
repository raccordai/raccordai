import { describe, expect, it } from 'vitest'
import type { WorkflowExport } from './ipc/contracts'
import { diffCheckpoint, formatDiff } from './checkpointDiff'

function workflow(
  nodes: Array<{ key: string; label?: string; params?: Record<string, unknown> }>,
  edges: Array<{ from: string; to: string; input: string }> = []
): WorkflowExport {
  return {
    version: 1,
    assets: [],
    nodes: nodes.map((n) => ({
      key: n.key,
      modelId: 'bytedance/seedance-2-fast',
      ...(n.label ? { label: n.label } : {}),
      position: { x: 0, y: 0 },
      params: n.params ?? { prompt: 'a shot' }
    })),
    edges: edges.map((e) => ({ ...e, output: 'output' }))
  }
}

const base = workflow(
  [
    { key: 'a', label: 'Shot 01' },
    { key: 'b', label: 'Shot 02' }
  ],
  [{ from: 'a', to: 'b', input: 'reference_image_urls' }]
)

const diffOf = (
  current: WorkflowExport,
  selections?: [Record<string, string>, Record<string, string>]
) =>
  diffCheckpoint({
    checkpoint: base,
    current,
    checkpointSelections: selections?.[0] ?? {},
    currentSelections: selections?.[1] ?? {}
  })

describe('diffCheckpoint', () => {
  it('reports an identical graph', () => {
    const diff = diffOf(base)
    expect(diff.identical).toBe(true)
    expect(formatDiff(diff)).toBe('No difference with the current graph.')
  })

  it('ignores a node that only moved', () => {
    const moved = structuredClone(base)
    moved.nodes[0]!.position = { x: 900, y: 400 }
    expect(diffOf(moved).identical).toBe(true)
  })

  it('lists added and removed nodes by key', () => {
    const diff = diffOf(
      workflow([
        { key: 'a', label: 'Shot 01' },
        { key: 'c', label: 'Shot 03' }
      ])
    )
    expect(diff.added).toEqual([{ key: 'c', label: 'Shot 03' }])
    expect(diff.removed).toEqual([{ key: 'b', label: 'Shot 02' }])
  })

  it('reports changed params with the prompt first', () => {
    const diff = diffOf(
      workflow([
        { key: 'a', label: 'Shot 01', params: { resolution: '1080p', prompt: 'a different shot' } },
        { key: 'b', label: 'Shot 02' }
      ])
    )
    expect(diff.changed).toEqual([
      { key: 'a', label: 'Shot 01', changedParams: ['prompt', 'resolution'] }
    ])
  })

  it('counts a rename as a change', () => {
    const diff = diffOf(
      workflow([
        { key: 'a', label: 'Opening' },
        { key: 'b', label: 'Shot 02' }
      ])
    )
    expect(diff.changed[0]?.changedParams).toEqual(['label'])
  })

  it('lists edges added and removed in readable form', () => {
    const diff = diffOf(
      workflow(
        [
          { key: 'a', label: 'Shot 01' },
          { key: 'b', label: 'Shot 02' }
        ],
        [{ from: 'b', to: 'a', input: 'first_frame_url' }]
      )
    )
    expect(diff.edgesAdded).toEqual(['b → a.first_frame_url'])
    expect(diff.edgesRemoved).toEqual(['a → b.reference_image_urls'])
  })

  it('reports a changed selection only for nodes present on both sides', () => {
    const diff = diffOf(base, [
      { a: 'gen-1', gone: 'gen-9' },
      { a: 'gen-2', gone: 'gen-8' }
    ])
    expect(diff.selectionChanged).toEqual(['a'])
  })

  it('renders every change kind on its own line', () => {
    const diff = diffOf(
      workflow([
        { key: 'a', label: 'Opening' },
        { key: 'c', label: 'Shot 03' }
      ]),
      [{ a: 'gen-1' }, { a: 'gen-2' }]
    )
    const text = formatDiff(diff)
    expect(text).toContain('+ node "Shot 03"')
    expect(text).toContain('- node "Shot 02"')
    expect(text).toContain('~ node "Opening" (label)')
    expect(text).toContain('- edge a → b.reference_image_urls')
    expect(text).toContain('~ selected output on a')
  })
})
