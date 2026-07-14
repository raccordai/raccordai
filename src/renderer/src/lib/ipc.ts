import type { IpcChannel, IpcInput, IpcOutput } from '@shared/ipc/contracts'

declare global {
  interface Window {
    api: {
      invoke(channel: string, input?: unknown): Promise<unknown>
      on(channel: string, listener: (payload: unknown) => void): () => void
    }
  }
}

type InvokeArgs<C extends IpcChannel> = IpcInput<C> extends void ? [] : [input: IpcInput<C>]

/** Typed facade over the preload bridge — the only way the renderer talks to main. */
export function invoke<C extends IpcChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<IpcOutput<C>> {
  return window.api.invoke(channel, args[0]) as Promise<IpcOutput<C>>
}
