import dagre from '@dagrejs/dagre'

/**
 * Graph layout — THE single source of truth for node placement, shared by the
 * renderer's "Tidy" button and by the main process when a workflow arrives
 * without usable positions (assistant / MCP `import_workflow`, `add_node`).
 *
 * It used to live in the renderer only, typed against React Flow's `Node`, so
 * main had no way to call it: `importWorkflow` defaulted every position-less
 * node to (0,0) and the assistant's graphs came out stacked on top of each
 * other. The algorithm is unchanged — it just works on a structural node type
 * now, and `renderer/features/workflow/autoLayout.ts` adapts React Flow nodes
 * to it (same pattern as `src/shared/timeline.ts`).
 */

export type LayoutDirection = 'LR' | 'TB'

/** The minimum a node must expose to be laid out. */
export interface LayoutNode {
  id: string
  /** Sizing bucket: 'modelNode' | 'assetNode' (anything else falls back). */
  type?: string | undefined
  position: { x: number; y: number }
  /** Real rendered size, when the caller knows it (React Flow measurement). */
  measured?: { width?: number | undefined; height?: number | undefined } | undefined
  /** Shot-order hints — the first run of digits in either wins. */
  label?: string | null | undefined
  key?: string | null | undefined
  createdAt?: number | undefined
}

export interface LayoutEdge {
  source: string
  target: string
}

export interface LayoutResult {
  id: string
  position: { x: number; y: number }
}

/**
 * Approximate node dimensions used by dagre to compute non-overlapping positions.
 * They don't need to be exact — dagre just needs reasonable values to space nodes apart.
 */
const NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  modelNode: { width: 288, height: 260 },
  assetNode: { width: 224, height: 200 }
}
const DEFAULT_DIM = { width: 260, height: 220 }

const MARGIN = 40
const NODE_SEP = 60
const RANK_SEP = 120

/**
 * Computes tidy positions for a graph, arranged as a strict grid:
 *   - COLUMN (flow axis: x in LR, y in TB) = the node's pipeline depth, from
 *     dagre's layering. So asset → image → clip read left-to-right (LR).
 *   - ROW (sequence axis: y in LR, x in TB) = the authored shot order. Every
 *     node carrying the same shot number (e.g. "img_07" + "clip_07", both
 *     labelled "07 — …") shares one row, so the image and its clip line up.
 *
 * The grid is GLOBAL: shot 1 sits above shot 2 … above shot N across the whole
 * canvas, regardless of which reference asset each shot is wired to. The old
 * layout stacked weakly-connected components as separate vertical bands, which
 * fragmented the order — shots sharing the "captain" reference clumped together,
 * away from shots sharing the "ship" reference — so the column never read
 * 01, 02, 03… top-to-bottom. Ordering by shot number instead of by component
 * fixes that.
 */
export function autoLayoutPositions(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  direction: LayoutDirection = 'LR'
): LayoutResult[] {
  if (nodes.length === 0) return []

  const seq = sequenceIndex(nodes)
  const rankOf = computeRanks(nodes, edges, direction)
  const rowOf = computeRows(nodes, seq)

  // Extent along each axis: flow = the pipeline direction, seq = the shot stack.
  const flowExtent = (n: LayoutNode): number =>
    direction === 'LR' ? nodeSize(n).width : nodeSize(n).height
  const seqExtent = (n: LayoutNode): number =>
    direction === 'LR' ? nodeSize(n).height : nodeSize(n).width

  // Column offsets along the flow axis, sized to the widest node in each rank.
  const ranks = [...new Set(rankOf.values())].sort((a, b) => a - b)
  const colStart = new Map<number, number>()
  let flowCursor = MARGIN
  for (const r of ranks) {
    colStart.set(r, flowCursor)
    const members = nodes.filter((n) => rankOf.get(n.id) === r)
    flowCursor += Math.max(...members.map(flowExtent)) + RANK_SEP
  }

  // Row offsets along the sequence axis. A row may hold more than one node in
  // the same rank (rare — two shots collapsed onto one row); those stack within
  // the row, so the row's size is the tallest such stack.
  const rows = [...new Set(rowOf.values())].sort((a, b) => a - b)
  const rowStart = new Map<number, number>()
  let seqCursor = MARGIN
  for (const r of rows) {
    rowStart.set(r, seqCursor)
    const byRank = new Map<number, LayoutNode[]>()
    for (const n of nodes) {
      if (rowOf.get(n.id) !== r) continue
      const rank = rankOf.get(n.id)!
      byRank.set(rank, [...(byRank.get(rank) ?? []), n])
    }
    const tallestStack = Math.max(
      ...[...byRank.values()].map(
        (cell) => cell.reduce((sum, n) => sum + seqExtent(n) + NODE_SEP, 0) - NODE_SEP
      )
    )
    seqCursor += tallestStack + NODE_SEP
  }

  // Place each node at (column, row). When a (rank, row) cell holds several
  // nodes they stack along the sequence axis, deterministically by sequence.
  const out: LayoutResult[] = []
  const cellCursor = new Map<string, number>()
  const ordered = [...nodes].sort((a, b) => seq.get(a.id)! - seq.get(b.id)!)
  for (const n of ordered) {
    const rank = rankOf.get(n.id)!
    const row = rowOf.get(n.id)!
    const cellKey = `${rank}:${row}`
    const seqOffset = cellCursor.get(cellKey) ?? rowStart.get(row)!
    cellCursor.set(cellKey, seqOffset + seqExtent(n) + NODE_SEP)
    const flow = colStart.get(rank)!
    out.push({
      id: n.id,
      position: direction === 'LR' ? { x: flow, y: seqOffset } : { x: seqOffset, y: flow }
    })
  }
  return out
}

/**
 * True when positions carry no usable information and the caller should lay the
 * graph out itself: nothing positioned, or every node piled on the same spot.
 * That is exactly what an agent produces when it omits `position` (every node
 * defaults to the origin) or reuses one coordinate for the whole graph.
 */
export function needsLayout(positions: Array<{ x: number; y: number }>): boolean {
  if (positions.length <= 1) return false
  const first = positions[0]!
  return positions.every((p) => p.x === first.x && p.y === first.y)
}

/** The shot number embedded in a node's label, else its key (first run of digits). */
function shotNumber(n: LayoutNode): number | undefined {
  for (const s of [n.label, n.key]) {
    if (typeof s === 'string') {
      const m = s.match(/\d+/)
      if (m) return parseInt(m[0], 10)
    }
  }
  return undefined
}

/**
 * Stable ordering of nodes — the authored shot sequence:
 *   1. The shot number embedded in the node's label (e.g. "Clip — Shot 28" → 28),
 *      falling back to the node key. Numbered nodes sort before unnumbered ones.
 *   2. Creation order.
 *   3. Current Y/X position.
 * Returns a map node id → rank in that ordering.
 */
function sequenceIndex(nodes: LayoutNode[]): Map<string, number> {
  const sorted = [...nodes].sort((a, b) => {
    const na = shotNumber(a)
    const nb = shotNumber(b)
    if (na !== undefined && nb !== undefined && na !== nb) return na - nb
    if ((na !== undefined) !== (nb !== undefined)) return na !== undefined ? -1 : 1
    const ca = a.createdAt
    const cb = b.createdAt
    if (ca !== undefined && cb !== undefined && ca !== cb) return ca - cb
    return a.position.y - b.position.y || a.position.x - b.position.x
  })
  return new Map(sorted.map((n, i) => [n.id, i]))
}

/**
 * Pipeline depth (column index) of each node, from dagre's layered layout —
 * which handles multi-parent fan-in, shared references, and disconnected nodes.
 * We keep only dagre's rank assignment (its flow-axis coordinate), discarding
 * its within-rank ordering, and densify the coordinates into 0..R integers.
 */
function computeRanks(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  direction: LayoutDirection
): Map<string, number> {
  const ids = new Set(nodes.map((n) => n.id))
  const g = new dagre.graphlib.Graph({ directed: true })
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: direction, nodesep: NODE_SEP, ranksep: RANK_SEP, marginx: 0, marginy: 0 })
  for (const n of nodes) {
    const { width, height } = nodeSize(n)
    g.setNode(n.id, { width, height })
  }
  for (const e of edges) if (ids.has(e.source) && ids.has(e.target)) g.setEdge(e.source, e.target)
  dagre.layout(g)

  // Flow-axis centre = x in LR, y in TB. Bucket (÷10 to absorb jitter), then map
  // the distinct buckets in order to contiguous rank indices.
  const bucketOf = (n: LayoutNode): number => {
    const laid = g.node(n.id)
    return Math.round((direction === 'LR' ? laid.x : laid.y) / 10)
  }
  const buckets = [...new Set(nodes.map(bucketOf))].sort((a, b) => a - b)
  const rankIndex = new Map(buckets.map((b, i) => [b, i]))
  return new Map(nodes.map((n) => [n.id, rankIndex.get(bucketOf(n))!]))
}

/**
 * Row (sequence-axis slot) of each node. Nodes sharing a shot number share a row
 * so image/clip pairs align; unnumbered nodes (references, music) each get their
 * own row. Rows are ordered by the authored sequence, so the canvas reads
 * 01, 02, 03 … N top-to-bottom (LR).
 */
function computeRows(nodes: LayoutNode[], seq: Map<string, number>): Map<string, number> {
  const groupKey = (n: LayoutNode): string => {
    const s = shotNumber(n)
    return s !== undefined ? `s${s}` : `u${n.id}`
  }
  // Order groups by their earliest member in the authored sequence.
  const minSeq = new Map<string, number>()
  for (const n of nodes) {
    const k = groupKey(n)
    const s = seq.get(n.id)!
    if (!minSeq.has(k) || s < minSeq.get(k)!) minSeq.set(k, s)
  }
  const ordered = [...minSeq.keys()].sort((a, b) => minSeq.get(a)! - minSeq.get(b)!)
  const rowIndex = new Map(ordered.map((k, i) => [k, i]))
  return new Map(nodes.map((n) => [n.id, rowIndex.get(groupKey(n))!]))
}

/** Real rendered size when the caller measured the node, else the approximation. */
function nodeSize(n: LayoutNode): { width: number; height: number } {
  const fallback = NODE_DIMENSIONS[n.type ?? ''] ?? DEFAULT_DIM
  return {
    width: n.measured?.width ?? fallback.width,
    height: n.measured?.height ?? fallback.height
  }
}

/** Margin kept between a grown node and the neighbours pushed away from it. */
const COLLISION_GAP = 40

/**
 * Pushes nodes apart so nothing overlaps a node that just grew (e.g. a finished
 * generation rendering its media preview). Starting from `seedIds`, any node
 * intersecting one of them is shifted along the axis of least overlap, away from
 * it, with a margin — and then pushes its own neighbours in turn (cascade).
 * Nodes in `frozenIds` (e.g. mid-drag) are never moved.
 * Returns only the nodes whose position changed.
 */
export function resolveOverlaps(
  nodes: LayoutNode[],
  seedIds: string[],
  frozenIds: ReadonlySet<string> = new Set()
): LayoutResult[] {
  const items = nodes.map((n) => {
    const { width, height } = nodeSize(n)
    return { id: n.id, x: n.position.x, y: n.position.y, w: width, h: height }
  })
  const byId = new Map(items.map((i) => [i.id, i]))
  const queue = seedIds.filter((id) => byId.has(id))
  const moved = new Set<string>()
  // Hard cap against pathological cascades on dense graphs.
  let budget = 25 * Math.max(nodes.length, 1)

  while (queue.length > 0 && budget-- > 0) {
    const a = byId.get(queue.shift()!)!
    for (const b of items) {
      if (b.id === a.id || frozenIds.has(b.id)) continue
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
      if (overlapX <= 0 || overlapY <= 0) continue
      // Push along the axis of least overlap, away from `a`'s centre.
      if (overlapX < overlapY) {
        const dir = b.x + b.w / 2 >= a.x + a.w / 2 ? 1 : -1
        b.x += dir * (overlapX + COLLISION_GAP)
      } else {
        const dir = b.y + b.h / 2 >= a.y + a.h / 2 ? 1 : -1
        b.y += dir * (overlapY + COLLISION_GAP)
      }
      moved.add(b.id)
      queue.push(b.id)
    }
  }

  return items
    .filter((i) => moved.has(i.id))
    .map((i) => ({ id: i.id, position: { x: Math.round(i.x), y: Math.round(i.y) } }))
}
