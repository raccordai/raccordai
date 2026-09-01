import * as demo from '../../services/demo'
import * as demoWindowsService from '../../services/demoWindows'
import { obj, str, type AgentTool } from './types'

/** Demo mode (§9): screen recording, gestures and the input journal. */
export const demoTools: AgentTool[] = [
  {
    name: 'record_demo',
    description:
      'Demo mode (§9, RACCORD_DEMO=1 only): start/stop a recording with an input-event journal. Targets: "window" (default) = Raccord’s own window; "app" = ONE other app’s window (pass app, e.g. "chrome"); "display" = a whole screen. Other windows never appear on window/app takes. Journal needs macOS Accessibility else stop warns. focus_node/demo_point point during a take. Stop imports into projectId.',
    inputSchema: obj(
      {
        action: { type: 'string', enum: ['start', 'stop'] },
        projectId: str('Destination project (stop’s value wins over start’s)'),
        target: {
          type: 'string',
          enum: ['window', 'app', 'display'],
          description:
            'window = Raccord (default); app = one other app’s window; display = a screen'
        },
        app: str('Application to film in app mode (fuzzy name, see list_demo_windows)'),
        windowTitle: str(
          'Pin ONE window of that app by title (a browser demo tab); capture survives navigation'
        ),
        displayId: {
          type: 'number',
          description: 'Display to film in display mode (list_demo_displays; default: Raccord’s)'
        }
      },
      ['action', 'projectId']
    ),
    scope: 'project',
    risk: 'write',
    execute: async ({ action, projectId, target, app, windowTitle, displayId }) => {
      if (action === 'start') {
        return demo.startDemo({
          projectId: String(projectId),
          ...(target === 'display' || target === 'window' || target === 'app' ? { target } : {}),
          ...(typeof app === 'string' && app ? { app } : {}),
          ...(typeof windowTitle === 'string' && windowTitle ? { windowTitle } : {}),
          ...(typeof displayId === 'number' ? { displayId } : {})
        })
      }
      const result = await demo.stopDemo({ projectId: String(projectId) })
      const { events, ...rest } = result
      return { ...rest, eventCount: events.length }
    }
  },
  {
    name: 'list_demo_displays',
    description:
      'Demo mode (§9): the machine’s displays — id, label, bounds, scale, primary — to pick the screen a record_demo target "display" take films.',
    inputSchema: obj({}, []),
    scope: 'global',
    risk: 'read',
    execute: () => demo.listDemoDisplays()
  },
  {
    name: 'list_demo_windows',
    description:
      'Demo mode (§9): every visible window of every application (macOS) — app name, title, bounds — to pick what a record_demo target "app" take films.',
    inputSchema: obj({}, []),
    scope: 'global',
    risk: 'read',
    execute: () => demoWindowsService.listDemoWindows()
  },
  {
    name: 'demo_gesture',
    description:
      'Demo mode (§9): perform a REAL UI interaction in Raccord — a visible cursor travels to the element and genuine DOM events fire (menus actually open, typing appears). THE way to drive a demo people watch; graph tools mutate invisibly. kinds: click/hover (target = title, visible text or placeholder — picker entries match their model id), type (commit blurs to save), press (key).',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['click', 'type', 'press', 'hover'] },
        target: str('Element query: title, visible text or placeholder (accent-insensitive)'),
        text: str('Text to type (kind "type")'),
        key: str('Key to press (kind "press"): Enter, Escape, ArrowDown…'),
        commit: { type: 'boolean', description: 'After typing, blur to commit the field' }
      },
      ['kind']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ kind, target, text, key, commit }) =>
      demo.performGesture({
        kind: kind as 'click' | 'type' | 'press' | 'hover',
        ...(typeof target === 'string' && target ? { target } : {}),
        ...(typeof text === 'string' ? { text } : {}),
        ...(typeof key === 'string' && key ? { key } : {}),
        ...(commit === true ? { commit: true } : {})
      })
  },
  {
    name: 'demo_point',
    description:
      'Demo mode (§9): journal a synthetic click at a SCREEN coordinate during a take — how a driver that clicks synthetically (browser extension, script) gives the automatic camera its zoom targets. Compute x/y from list_demo_windows bounds + the in-window position of what you just clicked. No-op outside a live take.',
    inputSchema: obj(
      {
        x: { type: 'number', description: 'Screen x (points/DIPs)' },
        y: { type: 'number', description: 'Screen y (points/DIPs)' }
      },
      ['x', 'y']
    ),
    scope: 'global',
    risk: 'write',
    execute: ({ x, y }) => {
      demo.demoPoint({ x: Number(x), y: Number(y) })
      return { ok: true }
    }
  }
]
