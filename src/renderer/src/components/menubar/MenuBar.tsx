import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'
import { useDismissable } from '@renderer/components/ui/useDismissable'
import { shortcutLabel } from '@renderer/components/ui/useShortcut'
import type { ShortcutId } from '@renderer/lib/shortcuts'

// App menu bar (Figma-style, in the title bar) — pages contribute menus while
// they are mounted via useAppMenus(); the header renders them with <MenuBar />.

export interface MenuEntry {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
  /** Registered binding, rendered right-aligned (the caller also binds it). */
  shortcut?: ShortcutId
}

/** Sections are separated by a thin rule inside the dropdown. */
export interface AppMenu {
  id: string
  label: string
  sections: { id: string; entries: MenuEntry[] }[]
}

// Two contexts on purpose: registrants only consume the (stable) setter, so
// registering menus never re-renders the page that registered them — only the
// <MenuBar /> subscribes to the value.
const MenusValueContext = createContext<AppMenu[]>([])
const MenusSetterContext = createContext<Dispatch<SetStateAction<AppMenu[]>> | null>(null)

// Right side of the title bar (next to the settings gear) — same contribution
// pattern as the menus, for page-scoped action buttons.
const ActionsValueContext = createContext<React.ReactNode>(null)
const ActionsSetterContext = createContext<Dispatch<SetStateAction<React.ReactNode>> | null>(null)

export function MenuBarProvider({ children }: { children: React.ReactNode }) {
  const [menus, setMenus] = useState<AppMenu[]>([])
  const [actions, setActions] = useState<React.ReactNode>(null)
  return (
    <MenusSetterContext.Provider value={setMenus}>
      <MenusValueContext.Provider value={menus}>
        <ActionsSetterContext.Provider value={setActions}>
          <ActionsValueContext.Provider value={actions}>{children}</ActionsValueContext.Provider>
        </ActionsSetterContext.Provider>
      </MenusValueContext.Provider>
    </MenusSetterContext.Provider>
  )
}

/**
 * Contribute menus to the app menu bar for as long as the caller is mounted.
 * `menus` must be memoized by the caller (useMemo) — a new identity re-renders
 * the menu bar.
 */
export function useAppMenus(menus: AppMenu[]) {
  const setMenus = useContext(MenusSetterContext)
  useEffect(() => {
    if (!setMenus) return
    setMenus(menus)
    return () => setMenus([])
  }, [setMenus, menus])
}

/**
 * Contribute action buttons to the right side of the title bar for as long as
 * the caller is mounted. `node` must be memoized by the caller (useMemo).
 */
export function useHeaderActions(node: React.ReactNode) {
  const setActions = useContext(ActionsSetterContext)
  useEffect(() => {
    if (!setActions) return
    setActions(node)
    return () => setActions(null)
  }, [setActions, node])
}

export function HeaderActions() {
  const actions = useContext(ActionsValueContext)
  if (!actions) return null
  return <div className="no-drag flex items-center gap-1">{actions}</div>
}

export function MenuBar() {
  const menus = useContext(MenusValueContext)
  const [openId, setOpenId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // Close on outside click / Escape (menu buttons toggle themselves).
  const close = useCallback(() => setOpenId(null), [])
  useDismissable(openId !== null, close, rootRef)

  if (menus.length === 0) return null

  return (
    // `relative z-50` keeps the bar above its own dismiss overlay, so hovering
    // between menus and re-clicking the open one still work.
    <div ref={rootRef} className="no-drag relative z-50 flex items-center gap-0.5">
      {/*
        The header is an Electron drag region (`-webkit-app-region: drag`), and
        macOS swallows pointer events over it — the document listener in
        useDismissable never sees a click on the empty strip of the title bar,
        so the menu stayed open. This overlay is `no-drag`, so those clicks
        reach the renderer again; it also covers the rest of the window, which
        is the usual "first click dismisses the menu" behaviour.
      */}
      {openId !== null && (
        <div className="no-drag fixed inset-0 z-40" onPointerDown={close} aria-hidden="true" />
      )}
      {menus.map((menu) => (
        // z-50 keeps the trigger above the dismiss overlay below (they are
        // siblings, so the overlay's z-40 would otherwise cover the buttons and
        // swallow the re-click that closes the menu).
        <div key={menu.id} className="relative z-50">
          <button
            onClick={() => setOpenId((v) => (v === menu.id ? null : menu.id))}
            // Once a menu is open, hovering a sibling switches to it (native menu bar UX).
            onMouseEnter={() => setOpenId((v) => (v !== null ? menu.id : v))}
            className={`rounded-md px-2 py-1 text-sm transition ${
              openId === menu.id
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200'
            }`}
          >
            {menu.label}
          </button>
          {openId === menu.id && (
            <div className="absolute top-full left-0 z-50 mt-1 min-w-60 overflow-hidden rounded-md border border-neutral-800 bg-neutral-900 py-1 shadow-xl">
              {menu.sections.map((section, i) => (
                <div key={section.id}>
                  {i > 0 && <div className="my-1 h-px bg-neutral-800" />}
                  {section.entries.map((entry) => (
                    <button
                      key={entry.id}
                      disabled={entry.disabled}
                      onClick={() => {
                        setOpenId(null)
                        entry.onSelect()
                      }}
                      className="flex w-full items-center gap-6 px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent"
                    >
                      <span className="flex-1">{entry.label}</span>
                      {entry.shortcut && (
                        <span className="shrink-0 text-xs text-neutral-500">
                          {shortcutLabel(entry.shortcut)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
