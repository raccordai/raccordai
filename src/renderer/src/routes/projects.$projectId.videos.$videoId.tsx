import { createFileRoute } from '@tanstack/react-router'
import { WorkflowEditor } from '@renderer/features/workflow/WorkflowEditor'

export const Route = createFileRoute('/projects/$projectId/videos/$videoId')({
  component: VideoEditorPage
})

function VideoEditorPage(): React.JSX.Element {
  const { projectId, videoId } = Route.useParams()

  // Full-bleed: the editor fills the viewport height under the 48px app header.
  // Brand + project/video breadcrumb live in the editor's single-line toolbar.
  return (
    <div className="flex h-full flex-col">
      <WorkflowEditor videoId={videoId} projectId={projectId} />
    </div>
  )
}
