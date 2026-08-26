import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createHashHistory, createRouter } from '@tanstack/react-router'
import { ErrorBoundary, ErrorScreen } from './components/ErrorBoundary'
import { installGlobalErrorHandlers, reportRendererError } from './lib/errorReporter'
import { initI18n } from './lib/i18n'
import { graphKeys } from './features/workflow/data'
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
  // The payload carries the exact video/node, so only their queries refetch —
  // this event fires on every poll transition, download and retry, and used
  // to refetch every mounted video's graph and generation lists each time.
  window.api.on('event:generationsChanged', (payload) => {
    const { videoId, nodeId } = payload as { videoId: string; nodeId: string }
    void queryClient.invalidateQueries({ queryKey: graphKeys.generationsForNode(nodeId) })
    void queryClient.invalidateQueries({ queryKey: graphKeys.generationsForVideo(videoId) })
    void queryClient.invalidateQueries({ queryKey: graphKeys.history(videoId) })
    void queryClient.invalidateQueries({ queryKey: graphKeys.graph(videoId) })
  })
  // A generation settled — the kie.ai balance moved; refresh the toolbar chip.
  window.api.on('event:creditsChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['kie', 'credits'] })
  })
  // The run queue moved (enqueue/start/settle/retry) — refresh queue positions.
  window.api.on('event:queueChanged', () => {
    void queryClient.invalidateQueries({ queryKey: ['queue'] })
  })
  // The assistant (main process) mutated the graph — refetch what it touches,
  // scoped to the payload's video. Only the light row lists (videos, projects,
  // assets) stay unscoped: the event has no projectId and those queries are
  // cheap, unlike the graph/generation ones this used to refetch app-wide.
  window.api.on('event:workflowChanged', (payload) => {
    const { videoId } = payload as { videoId: string }
    void queryClient.invalidateQueries({ queryKey: graphKeys.graph(videoId) })
    // Node-scoped generation lists have no videoId in their key; the mounted
    // ones all belong to the open editor anyway.
    void queryClient.invalidateQueries({ queryKey: ['generations', 'node'] })
    void queryClient.invalidateQueries({ queryKey: graphKeys.generationsForVideo(videoId) })
    void queryClient.invalidateQueries({ queryKey: graphKeys.history(videoId) })
    // Undo/redo counters (Toolbar).
    void queryClient.invalidateQueries({ queryKey: ['history', videoId] })
    // The title track (§6.12b) — its mutations broadcast workflowChanged too.
    void queryClient.invalidateQueries({ queryKey: ['textLayers', videoId] })
    // The sticker track (§6.12d) — same broadcast.
    void queryClient.invalidateQueries({ queryKey: ['imageLayers', videoId] })
    // The feedback bucket (§6.13) — same broadcast (MCP agents mark items done).
    void queryClient.invalidateQueries({ queryKey: ['feedback', videoId] })
    void queryClient.invalidateQueries({ queryKey: ['assets'] })
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
