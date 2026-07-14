import { Link, Outlet, createRootRoute } from '@tanstack/react-router'
import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { HeaderActions, MenuBar, MenuBarProvider } from '@renderer/components/menubar/MenuBar'

export const Route = createRootRoute({
  component: RootLayout
})

function RootLayout(): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <MenuBarProvider>
      <div className="flex h-full flex-col">
        <header className="titlebar-drag flex h-12 shrink-0 items-center gap-3 border-b border-neutral-800 pr-4 pl-24">
          {/* Pages contribute their menus (Fichier, …) while mounted. */}
          <MenuBar />
          <div className="flex-1" />
          <HeaderActions />
          <Link
            to="/settings"
            className="rounded-md p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
            title={t('settings.title')}
          >
            <Settings className="h-4 w-4" />
          </Link>
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </MenuBarProvider>
  )
}
