import { randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import type { Db } from '../db/client'
import { generations } from '../db/schema'
import { mediaDirFor } from '../media/files'
import { createNode } from './graph'
import { createProject, deleteProject, getProject, listProjects, renameProject } from './projects'
import {
  createVideo,
  deleteVideo,
  getVideo,
  listVideos,
  renameVideo,
  setDraftMode,
  setQcEnabled,
  setVideoDefaults,
  setVideoStyle
} from './videos'

let db: Db

beforeEach(() => {
  db = useTestDatabase()
})
afterEach(() => resetTestDatabase())

/** A success generation whose media really exists in the managed store. */
function insertGenerationWithMedia(
  projectId: string,
  videoId: string,
  nodeId: string
): { resultPath: string; lastFramePath: string } {
  const dir = mediaDirFor(projectId)
  const id = randomUUID()
  const resultPath = join(dir, `${id}.mp4`)
  const lastFramePath = join(dir, `${id}-frame.jpg`)
  writeFileSync(resultPath, 'video-bytes')
  writeFileSync(lastFramePath, 'frame-bytes')
  db.insert(generations)
    .values({ id, nodeId, videoId, status: 'success', resultPath, lastFramePath, createdAt: 1 })
    .run()
  return { resultPath, lastFramePath }
}

describe('projects', () => {
  it('creates and reads back a project', () => {
    const p = createProject('My film')
    expect(getProject(p.id)).toEqual(p)
    expect(listProjects().map((x) => x.id)).toContain(p.id)
  })

  it('renames a project', () => {
    const p = createProject('Old')
    renameProject(p.id, 'New')
    expect(getProject(p.id)?.name).toBe('New')
  })

  it('deleting a project cascades to its videos', () => {
    const p = createProject('P')
    const v = createVideo(p.id, 'V')
    deleteProject(p.id)
    expect(getProject(p.id)).toBeNull()
    expect(getVideo(v.id)).toBeNull()
  })

  it('deleting a project removes its media directory from disk', () => {
    const p = createProject('P')
    const v = createVideo(p.id, 'V')
    const node = createNode({ videoId: v.id, modelId: 'bytedance/seedance-2-fast' })
    const media = insertGenerationWithMedia(p.id, v.id, node.id)
    expect(existsSync(media.resultPath)).toBe(true)

    deleteProject(p.id)
    expect(existsSync(media.resultPath)).toBe(false)
    expect(existsSync(media.lastFramePath)).toBe(false)
  })
})

describe('videos', () => {
  it('lists videos of a project, most recently updated first', () => {
    const p = createProject('P')
    const a = createVideo(p.id, 'A')
    const b = createVideo(p.id, 'B')
    renameVideo(a.id, 'A2')
    const names = listVideos(p.id).map((v) => v.name)
    expect(names.slice().sort()).toEqual(['A2', 'B'])
    expect(getVideo(b.id)?.name).toBe('B')
  })

  it('deletes a video', () => {
    const p = createProject('P')
    const v = createVideo(p.id, 'V')
    deleteVideo(v.id)
    expect(getVideo(v.id)).toBeNull()
    expect(listVideos(p.id)).toHaveLength(0)
  })

  it('deleting a video removes its generation media, not the project media dir', () => {
    const p = createProject('P')
    const v = createVideo(p.id, 'V')
    const other = createVideo(p.id, 'Other')
    const node = createNode({ videoId: v.id, modelId: 'bytedance/seedance-2-fast' })
    const otherNode = createNode({ videoId: other.id, modelId: 'bytedance/seedance-2-fast' })
    const media = insertGenerationWithMedia(p.id, v.id, node.id)
    const kept = insertGenerationWithMedia(p.id, other.id, otherNode.id)

    deleteVideo(v.id)
    expect(existsSync(media.resultPath)).toBe(false)
    expect(existsSync(media.lastFramePath)).toBe(false)
    // A sibling video's media is untouched.
    expect(existsSync(kept.resultPath)).toBe(true)
    expect(existsSync(kept.lastFramePath)).toBe(true)
  })

  it('attaches, clears and validates the style template', () => {
    const p = createProject('P')
    const v = createVideo(p.id, 'V')
    expect(v.styleId).toBeNull()

    setVideoStyle(v.id, 'anime')
    expect(getVideo(v.id)?.styleId).toBe('anime')

    setVideoStyle(v.id, null)
    expect(getVideo(v.id)?.styleId).toBeNull()

    expect(() => setVideoStyle(v.id, 'not-a-style')).toThrow(/Unknown style/)
  })

  it('sets, keeps and clears the video-level generation defaults', () => {
    const p = createProject('P')
    const v = createVideo(p.id, 'V')
    expect(v.defaultAspectRatio).toBeNull()
    expect(v.defaultResolution).toBeNull()

    setVideoDefaults(v.id, { defaultAspectRatio: '9:16' })
    expect(getVideo(v.id)).toMatchObject({ defaultAspectRatio: '9:16', defaultResolution: null })

    // Omitted field untouched, provided one updated.
    setVideoDefaults(v.id, { defaultResolution: '1080p' })
    expect(getVideo(v.id)).toMatchObject({ defaultAspectRatio: '9:16', defaultResolution: '1080p' })

    // Explicit null clears; empty patch is a no-op.
    setVideoDefaults(v.id, { defaultAspectRatio: null })
    setVideoDefaults(v.id, {})
    expect(getVideo(v.id)).toMatchObject({ defaultAspectRatio: null, defaultResolution: '1080p' })
  })

  it('toggles draft mode and vision QC (both default off)', () => {
    const p = createProject('P')
    const v = createVideo(p.id, 'V')
    expect(v.draftMode).toBe(false)
    expect(v.qcEnabled).toBe(false)

    setDraftMode(v.id, true)
    setQcEnabled(v.id, true)
    expect(getVideo(v.id)).toMatchObject({ draftMode: true, qcEnabled: true })

    setDraftMode(v.id, false)
    expect(getVideo(v.id)).toMatchObject({ draftMode: false, qcEnabled: true })
  })
})
