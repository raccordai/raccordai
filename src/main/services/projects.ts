import { randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import type { Project } from '@shared/ipc/contracts'
import { getDb } from '../db/client'
import { projects } from '../db/schema'

export function listProjects(): Project[] {
  return getDb().select().from(projects).orderBy(desc(projects.updatedAt)).all()
}

export function getProject(id: string): Project | null {
  return getDb().select().from(projects).where(eq(projects.id, id)).get() ?? null
}

export function createProject(name: string): Project {
  const now = Date.now()
  const project: Project = { id: randomUUID(), name, createdAt: now, updatedAt: now }
  getDb().insert(projects).values(project).run()
  return project
}

export function renameProject(id: string, name: string): void {
  getDb().update(projects).set({ name, updatedAt: Date.now() }).where(eq(projects.id, id)).run()
}

export function deleteProject(id: string): void {
  getDb().delete(projects).where(eq(projects.id, id)).run()
}
