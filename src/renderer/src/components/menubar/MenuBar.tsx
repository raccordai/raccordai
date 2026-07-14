import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'

// App menu bar (Figma-style, in the title bar) — pages contribute menus while
// they are mounted via useAppMenus(); the header renders them with <MenuBar />.

export interface MenuEntry {
  id: string
  label: string
  onSelect: () => void
  disabled?: boolean
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
  useEffect(() => {
    if (!openId) return
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpenId(null)
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpenId(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [openId])

  if (menus.length === 0) return null

  return (
    <div ref={rootRef} className="no-drag flex items-center gap-0.5">
      {menus.map((menu) => (
        <div key={menu.id} className="relative">
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
                      className="flex w-full items-center px-3 py-1.5 text-left text-sm text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:text-neutral-600 disabled:hover:bg-transparent"
                    >
                      {entry.label}
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
