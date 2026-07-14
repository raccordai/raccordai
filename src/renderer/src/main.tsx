import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createHashHistory, createRouter } from '@tanstack/react-router'
import { initI18n } from './lib/i18n'
import { routeTree } from './routeTree.gen'
import './styles.css'

const queryClient = new QueryClient()

// Hash history: under file:// the pathname is the bundle's absolute path,
// which can never match route paths.
const router = createRouter({ routeTree, history: createHashHistory() })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

async function bootstrap(): Promise<void> {
  await initI18n()

  // Desktop replacement for Convex reactivity: the main process pushes an
  // event whenever a generation changes; refetch what the editor is showing.
  window.api.on('event:generationsChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['generations'] })
    void queryClient.invalidateQueries({ queryKey: ['graph'] })
  })
  // The assistant (main process) mutated the graph — refetch everything it touches.
  window.api.on('event:workflowChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['graph'] })
    void queryClient.invalidateQueries({ queryKey: ['generations'] })
    void queryClient.invalidateQueries({ queryKey: ['assets'] })
    void queryClient.invalidateQueries({ queryKey: ['history'] })
    // The assistant can also change the video's style template (set_video_style).
    void queryClient.invalidateQueries({ queryKey: ['videos'] })
    // The home assistant can create projects and videos.
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
  })

  const container = document.getElementById('root')
  if (!container) throw new Error('#root element missing')

  createRoot(container).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>
  )
}

void bootstrap()
