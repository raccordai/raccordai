import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@renderer/lib/ipc'

const PROJECTS_KEY = ['projects']

export function useProjects() {
  return useQuery({
    queryKey: PROJECTS_KEY,
    queryFn: () => invoke('projects:list')
  })
}

export function useCreateProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (name: string) => invoke('projects:create', { name }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY })
  })
}

export function useDeleteProject() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => invoke('projects:delete', { id }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: PROJECTS_KEY })
  })
}
