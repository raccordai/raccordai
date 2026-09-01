import type { DemoGesturePayload } from '@shared/ipc/contracts'
import { invoke } from '@renderer/lib/ipc'
import { pickGestureTarget, type GestureCandidate } from '@renderer/lib/demoGestures'
import { reportRendererError } from '@renderer/lib/errorReporter'

/**
 * Gesture engine (§9) — performs REAL UI interactions on demand so a driven
 * demo shows a human-looking session: a visible cursor travels to the
 * resolved element and genuine DOM events fire (menus actually open, typing
 * appears character by character). Thin shell (E2E scope, out of unit
 * coverage): target scoring is pure in lib/demoGestures.ts.
 *
 * Dispatch doctrine (survey-verified):
 * - FULL sequence pointerover/enter/move → pointerdown/mousedown →
 *   pointerup/mouseup → click: the node picker's entries listen on
 *   onMouseDown (not onClick), everything else on onClick — the sequence
 *   satisfies both. React 19 delegates at the root, native dispatchEvent
 *   reaches handlers.
 * - NEVER hit-test (elementFromPoint): a fixed inset-0 dismiss overlay
 *   (open popovers) would intercept. Resolve by harvest + scoring, dispatch
 *   on the resolved element (useDismissable ignores pointerdown inside its
 *   ref).
 * - Controlled inputs need the native value setter + an 'input' event; the
 *   params-panel prompt commits on blur (gesture option `commit`).
 */

const CURSOR_TRAVEL_MS = 420
const AFTER_CLICK_SETTLE_MS = 350
const TYPE_CHAR_MS = 40
const CURSOR_IDLE_HIDE_MS = 6000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ── Visible cursor ───────────────────────────────────────────────────────────

let cursorEl: HTMLDivElement | null = null
let cursorHideTimer: ReturnType<typeof setTimeout> | null = null

function ensureCursor(): HTMLDivElement {
  if (cursorEl) return cursorEl
  const el = document.createElement('div')
  el.style.cssText = [
    'position:fixed',
    'z-index:9999',
    'pointer-events:none',
    'width:22px',
    'height:22px',
    'border-radius:50%',
    'background:radial-gradient(circle, #ffffff 0 38%, rgba(255,255,255,0.35) 39% 70%, transparent 71%)',
    'box-shadow:0 0 10px rgba(255,255,255,0.55)',
    `left:${window.innerWidth / 2 - 11}px`,
    `top:${window.innerHeight / 2 - 11}px`,
    `transition:left ${CURSOR_TRAVEL_MS}ms cubic-bezier(.3,.7,.3,1), top ${CURSOR_TRAVEL_MS}ms cubic-bezier(.3,.7,.3,1), transform 140ms ease`
  ].join(';')
  document.body.appendChild(el)
  cursorEl = el
  return el
}

function scheduleCursorHide(): void {
  if (cursorHideTimer) clearTimeout(cursorHideTimer)
  cursorHideTimer = setTimeout(() => {
    cursorEl?.remove()
    cursorEl = null
  }, CURSOR_IDLE_HIDE_MS)
}

async function moveCursorTo(x: number, y: number): Promise<void> {
  const el = ensureCursor()
  // Force a layout so a freshly-created cursor still animates the travel.
  void el.offsetLeft
  el.style.left = `${x - 11}px`
  el.style.top = `${y - 11}px`
  await sleep(CURSOR_TRAVEL_MS + 40)
}

function pulseCursor(): void {
  if (!cursorEl) return
  cursorEl.style.transform = 'scale(0.72)'
  setTimeout(() => {
    if (cursorEl) cursorEl.style.transform = 'scale(1)'
  }, 150)
}

// ── Target resolution ────────────────────────────────────────────────────────

interface ResolvedTarget extends GestureCandidate {
  el: HTMLElement
  cx: number
  cy: number
}

function harvestCandidates(): ResolvedTarget[] {
  const nodes = document.querySelectorAll<HTMLElement>(
    'button, a, input, textarea, select, [role="menuitem"], .react-flow__node'
  )
  const out: ResolvedTarget[] = []
  let index = 0
  for (const el of nodes) {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    out.push({
      el,
      text: (el.textContent ?? '').trim().slice(0, 200),
      title: el.getAttribute('title') ?? '',
      placeholder: el.getAttribute('placeholder') ?? '',
      area: rect.width * rect.height,
      index: (index += 1),
      cx: rect.x + rect.width / 2,
      cy: rect.y + rect.height / 2
    })
  }
  return out
}

function resolveTarget(query: string): ResolvedTarget {
  const target = pickGestureTarget(harvestCandidates(), query)
  if (!target) {
    throw new Error(
      `No visible element matches "${query}" (title, text or placeholder) — is the right screen open?`
    )
  }
  return target
}

// ── Event dispatch ───────────────────────────────────────────────────────────

function pointerInit(x: number, y: number, down: boolean): PointerEventInit & MouseEventInit {
  return {
    bubbles: true,
    composed: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: down ? 1 : 0,
    pointerId: 1,
    isPrimary: true,
    pointerType: 'mouse'
  }
}

function dispatchHover(target: ResolvedTarget): void {
  const init = pointerInit(target.cx, target.cy, false)
  target.el.dispatchEvent(new PointerEvent('pointerover', init))
  target.el.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false }))
  target.el.dispatchEvent(new MouseEvent('mouseover', init))
  target.el.dispatchEvent(new MouseEvent('mouseenter', { ...init, bubbles: false }))
  target.el.dispatchEvent(new PointerEvent('pointermove', init))
  target.el.dispatchEvent(new MouseEvent('mousemove', init))
}

function dispatchClick(target: ResolvedTarget): void {
  const down = pointerInit(target.cx, target.cy, true)
  const up = pointerInit(target.cx, target.cy, false)
  target.el.dispatchEvent(new PointerEvent('pointerdown', down))
  target.el.dispatchEvent(new MouseEvent('mousedown', down))
  target.el.dispatchEvent(new PointerEvent('pointerup', up))
  target.el.dispatchEvent(new MouseEvent('mouseup', up))
  target.el.dispatchEvent(new MouseEvent('click', up))
}

/** Journals the click for the automatic camera (no-op outside a live take). */
function journalPoint(target: ResolvedTarget): void {
  void invoke('demo:point', {
    x: window.screenX + target.cx,
    y: window.screenY + target.cy
  }).catch(() => undefined)
}

const nativeValueSetter = (el: HTMLInputElement | HTMLTextAreaElement): ((v: string) => void) => {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!
  return (v: string) => set.call(el, v)
}

async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string): Promise<void> {
  el.focus()
  const setValue = nativeValueSetter(el)
  let value = el.value
  for (const char of text) {
    value += char
    setValue(value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    await sleep(TYPE_CHAR_MS)
  }
}

// ── Gesture execution ────────────────────────────────────────────────────────

async function executeGesture(gesture: DemoGesturePayload['gesture']): Promise<void> {
  switch (gesture.kind) {
    case 'click':
    case 'hover': {
      if (!gesture.target) throw new Error(`Gesture "${gesture.kind}" needs a target.`)
      const target = resolveTarget(gesture.target)
      await moveCursorTo(target.cx, target.cy)
      dispatchHover(target)
      if (gesture.kind === 'hover') return
      await sleep(120)
      pulseCursor()
      dispatchClick(target)
      journalPoint(target)
      // Let whatever the click opened (menu, panel) mount before the next gesture.
      await sleep(AFTER_CLICK_SETTLE_MS)
      return
    }
    case 'type': {
      if (!gesture.text) throw new Error('Gesture "type" needs text.')
      let el: HTMLElement | null
      if (gesture.target) {
        const target = resolveTarget(gesture.target)
        await moveCursorTo(target.cx, target.cy)
        dispatchHover(target)
        dispatchClick(target)
        await sleep(80)
        el = target.el
      } else {
        // The picker auto-focuses its search input in an effect — give it a beat.
        await sleep(120)
        el = document.activeElement as HTMLElement | null
      }
      if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
        throw new Error('Gesture "type" found no focused input/textarea — click one first.')
      }
      await typeInto(el, gesture.text)
      if (gesture.commit) {
        el.dispatchEvent(new FocusEvent('blur', { bubbles: false }))
        el.blur()
      }
      return
    }
    case 'press': {
      if (!gesture.key) throw new Error('Gesture "press" needs a key.')
      const el = (document.activeElement as HTMLElement | null) ?? document.body
      const init = { bubbles: true, composed: true, cancelable: true, key: gesture.key }
      el.dispatchEvent(new KeyboardEvent('keydown', init))
      el.dispatchEvent(new KeyboardEvent('keyup', init))
      await sleep(150)
      return
    }
  }
}

/** Obeys main's demoGesture broadcast and reports the outcome back. */
export function handleDemoGesture(payload: DemoGesturePayload): void {
  void executeGesture(payload.gesture)
    .then(() => {
      scheduleCursorHide()
      return invoke('demo:gestureResult', { requestId: payload.requestId, ok: true })
    })
    .catch((error: unknown) => {
      scheduleCursorHide()
      const message = error instanceof Error ? error.message : String(error)
      return invoke('demo:gestureResult', {
        requestId: payload.requestId,
        ok: false,
        error: message
      })
    })
    .catch((error: unknown) => reportRendererError('demo', error))
}
