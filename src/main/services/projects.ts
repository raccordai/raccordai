import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Project } from '@shared/ipc/contracts'
import { PROJECT_INSTRUCTIONS_MAX_CHARS } from '@shared/config'
import { getDb } from '../db/client'
import { projects, videos } from '../db/schema'
import { deleteProjectMedia } from '../media/files'
import { cancelGenerationsForVideo } from './generationLifecycle'
import { purgeHistory } from './graphHistory'

export function listProjects(): Project[] {
  return getDb().select().from(projects).orderBy(desc(projects.updatedAt)).all()
}

export function getProject(id: string): Project | null {
  return getDb().select().from(projects).where(eq(projects.id, id)).get() ?? null
}

export function createProject(name: string): Project {
  const now = Date.now()
  const project: Project = {
    id: randomUUID(),
    name,
    instructions: null,
    createdAt: now,
    updatedAt: now
  }
  getDb().insert(projects).values(project).run()
  return project
}

export function renameProject(id: string, name: string): void {
  getDb().update(projects).set({ name, updatedAt: Date.now() }).where(eq(projects.id, id)).run()
}

/**
 * Full-replacement write of the project's Instructions (markdown methodology).
 * The cap is re-checked here because the MCP tool path does not go through the
 * IPC zod contract.
 */
export function setProjectInstructions(id: string, instructions: string | null): void {
  const value = instructions?.trim() || null
  if (value && value.length > PROJECT_INSTRUCTIONS_MAX_CHARS) {
    throw new Error(
      `Project instructions exceed the ${PROJECT_INSTRUCTIONS_MAX_CHARS}-character limit (got ${value.length}).`
    )
  }
  getDb()
    .update(projects)
    .set({ instructions: value, updatedAt: Date.now() })
    .where(eq(projects.id, id))
    .run()
}

export function deleteProject(id: string): void {
  const db = getDb()
  // The cascade is about to take every video: settle their in-flight
  // generations first (queue slots released, pollers stopped) and drop the
  // in-memory undo stacks.
  const projectVideos = db
    .select({ id: videos.id })
    .from(videos)
    .where(eq(videos.projectId, id))
    .all()
  for (const video of projectVideos) {
    cancelGenerationsForVideo(video.id)
    purgeHistory(video.id)
  }
  db.delete(projects).where(eq(projects.id, id)).run()
  // The whole managed store for the project (generation results, extracted
  // frames, imported assets) — nothing under it can outlive the project rows.
  deleteProjectMedia(id)
}
