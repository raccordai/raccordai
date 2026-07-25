// What the editor knows and the assistant should too (§4.10 phase 2). Plain
// module state, deliberately minimal: no subscriptions, no event firehose —
// the sidebar reads ONE snapshot per send and attaches it to chat:send.

export interface EditorContext {
  selectedNodeId: string | null
  /** Last generation error surfaced to the user (toast), if any. */
  lastError: string | null
}

let editorContext: EditorContext = { selectedNodeId: null, lastError: null }

export function setEditorContext(patch: Partial<EditorContext>): void {
  editorContext = { ...editorContext, ...patch }
}

/** Called when the editor unmounts — its selection/error no longer exist. */
export function resetEditorContext(): void {
  editorContext = { selectedNodeId: null, lastError: null }
}

export function getEditorContext(): EditorContext {
  return editorContext
}
