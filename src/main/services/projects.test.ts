import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTestDatabase, useTestDatabase } from '../../../tests/helpers/db'
import { createProject, deleteProject, getProject, listProjects, renameProject } from './projects'
import {
  createVideo,
  deleteVideo,
  getVideo,
  listVideos,
  renameVideo,
  setVideoDefaults,
  setVideoStyle
} from './videos'

beforeEach(() => {
  useTestDatabase()
})
afterEach(() => resetTestDatabase())

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
})
