import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { FlagState } from '@shared/ipc/contracts'
import { invoke } from '@renderer/lib/ipc'

const FLAGS_KEY = ['flags']

export function useFlags() {
  return useQuery({
    queryKey: FLAGS_KEY,
    queryFn: () => invoke('flags:list')
  })
}

/** Convenience: a single flag's effective state (false while loading). */
export function useFlag(key: string): boolean {
  const flags = useFlags()
  return flags.data?.find((f) => f.key === key)?.enabled ?? false
}

export function useSetFlagOverride() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (input: { key: string; enabled: boolean | null }) =>
      invoke('flags:setOverride', input),
    onSuccess: (flags: FlagState[]) => {
      queryClient.setQueryData(FLAGS_KEY, flags)
    }
  })
}
