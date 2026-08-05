import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createHashHistory, createRouter } from '@tanstack/react-router'
import { ErrorBoundary, ErrorScreen } from './components/ErrorBoundary'
import { installGlobalErrorHandlers, reportRendererError } from './lib/errorReporter'
import { initI18n } from './lib/i18n'
import { routeTree } from './routeTree.gen'
import './styles.css'

// Global error funnel: a failed query used to be indistinguishable from an
// empty state, and a failed mutation without a local try/catch was silent.
// Both now toast (deduped in Feedback.tsx) and land in main's log file.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => reportRendererError('query', error)
  }),
  mutationCache: new MutationCache({
    onError: (error) => reportRendererError('mutation', error)
  })
})

// Hash history: under file:// the pathname is the bundle's absolute path,
// which can never match route paths.
const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultErrorComponent: ({ error }) => <ErrorScreen error={error} scope="route" />
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

async function bootstrap(): Promise<void> {
  installGlobalErrorHandlers()
  await initI18n()

  // Desktop replacement for Convex reactivity: the main process pushes an
  // event whenever a generation changes; refetch what the editor is showing.
  window.api.on('event:generationsChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['generations'] })
    void queryClient.invalidateQueries({ queryKey: ['graph'] })
  })
  // A generation settled — the kie.ai balance moved; refresh the toolbar chip.
  window.api.on('event:creditsChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['kie', 'credits'] })
  })
  // The run queue moved (enqueue/start/settle/retry) — refresh queue positions.
  window.api.on('event:queueChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['queue'] })
  })
  // The assistant (main process) mutated the graph — refetch everything it touches.
  window.api.on('event:workflowChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['graph'] })
    void queryClient.invalidateQueries({ queryKey: ['generations'] })
    void queryClient.invalidateQueries({ queryKey: ['assets'] })
    void queryClient.invalidateQueries({ queryKey: ['history'] })
    // The title track (§6.12b) — its mutations broadcast workflowChanged too.
    void queryClient.invalidateQueries({ queryKey: ['textLayers'] })
    // The assistant can also change the video's style template (set_video_style).
    void queryClient.invalidateQueries({ queryKey: ['videos'] })
    // The home assistant can create projects and videos.
    void queryClient.invalidateQueries({ queryKey: ['projects'] })
  })
  // Niche research (§7) — any actor (UI, MCP, assistant) touched a niche.
  window.api.on('event:nichesChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['niches'] })
  })
  // Voice personas (§8) — persona pickers and lists refetch.
  window.api.on('event:voicePersonasChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['voicePersonas'] })
  })

  const container = document.getElementById('root')
  if (!container) throw new Error('#root element missing')

  createRoot(container).render(
    <StrictMode>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}

void bootstrap()
