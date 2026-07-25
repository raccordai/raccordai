import { useSyncExternalStore } from 'react'

// Module-level store for the global assistant sidebar (§4.10 phase 1) — lets
// distant components (editor "fix with the assistant" buttons, header toggle,
// global shortcut) drive one sidebar without threading props through the tree.

export const ASSISTANT_MIN_WIDTH = 320
export const ASSISTANT_MAX_WIDTH = 560
const DEFAULT_WIDTH = 400

const OPEN_KEY = 'raccord.assistant.open'
const WIDTH_KEY = 'raccord.assistant.width'

export interface AssistantState {
  open: boolean
  width: number
  /** Draft to inject into the chat input (consumed by the panel on send). */
  prefill: string | null
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH
  return Math.min(ASSISTANT_MAX_WIDTH, Math.max(ASSISTANT_MIN_WIDTH, Math.round(width)))
}

let state: AssistantState = {
  // Open by default — '0' means the user explicitly closed it.
  open: localStorage.getItem(OPEN_KEY) !== '0',
  width: clampWidth(Number(localStorage.getItem(WIDTH_KEY) ?? DEFAULT_WIDTH)),
  prefill: null
}

const listeners = new Set<() => void>()

function setState(next: AssistantState): void {
  state = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAssistant(): AssistantState {
  return useSyncExternalStore(subscribe, () => state)
}

export function openAssistant(prefill?: string): void {
  localStorage.setItem(OPEN_KEY, '1')
  setState({ ...state, open: true, prefill: prefill ?? state.prefill })
}

export function closeAssistant(): void {
  localStorage.setItem(OPEN_KEY, '0')
  setState({ ...state, open: false })
}

export function toggleAssistant(): void {
  if (state.open) closeAssistant()
  else openAssistant()
}

export function setAssistantWidth(width: number): void {
  const clamped = clampWidth(width)
  if (clamped === state.width) return
  localStorage.setItem(WIDTH_KEY, String(clamped))
  setState({ ...state, width: clamped })
}

export function consumeAssistantPrefill(): void {
  if (state.prefill === null) return
  setState({ ...state, prefill: null })
}
