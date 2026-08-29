// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { GraphNode } from '@shared/ipc/contracts'
import { installApiMock } from '../../../../../../tests/helpers/rendererTest'
import { AudioSettingsPopover } from './AudioSettingsPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

let invoke: Mock
beforeEach(() => {
  invoke = installApiMock()
})
afterEach(cleanup)

const anchor = { x: 400, y: 300 }
const node = (volume?: number): GraphNode =>
  ({ id: 'audio-1', key: 'audio-1', modelId: 'suno/music', volume }) as unknown as GraphNode

describe('AudioSettingsPopover', () => {
  it('shows the persisted gain as a percentage', () => {
    render(<AudioSettingsPopover node={node(0.5)} anchor={anchor} onClose={() => {}} />)
    expect(screen.getByText('50%')).toBeTruthy()
  })

  it('commits a gain change through nodes:setVolume', () => {
    render(<AudioSettingsPopover node={node()} anchor={anchor} onClose={() => {}} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '150' } })
    fireEvent.pointerUp(slider)
    expect(invoke).toHaveBeenCalledWith('nodes:setVolume', { nodeId: 'audio-1', volume: 1.5 })
  })

  it('writes null at 100% — the unset gain keeps the historical render argv', () => {
    render(<AudioSettingsPopover node={node(0.5)} anchor={anchor} onClose={() => {}} />)
    const slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '100' } })
    fireEvent.pointerUp(slider)
    expect(invoke).toHaveBeenCalledWith('nodes:setVolume', { nodeId: 'audio-1', volume: null })
  })
})
