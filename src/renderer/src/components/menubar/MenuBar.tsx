import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'

// Title-bar action buttons (icon-only, next to the settings gear) — pages
// contribute them while they are mounted via useHeaderActions(); the header
// renders them with <HeaderActions />.

// Two contexts on purpose: registrants only consume the (stable) setter, so
// registering actions never re-renders the page that registered them — only
// <HeaderActions /> subscribes to the value.
const ActionsValueContext = createContext<React.ReactNode>(null)
const ActionsSetterContext = createContext<Dispatch<SetStateAction<React.ReactNode>> | null>(null)

export function MenuBarProvider({ children }: { children: React.ReactNode }) {
  const [actions, setActions] = useState<React.ReactNode>(null)
  return (
    <ActionsSetterContext.Provider value={setActions}>
      <ActionsValueContext.Provider value={actions}>{children}</ActionsValueContext.Provider>
    </ActionsSetterContext.Provider>
  )
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
