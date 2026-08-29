// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { TextLayer } from '@shared/ipc/contracts'
import { installApiMock } from '../../../../../../tests/helpers/rendererTest'
import { LayerSettingsPopover } from './LayerSettingsPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

let invoke: Mock
beforeEach(() => {
  invoke = installApiMock()
})
afterEach(cleanup)

const anchor = { x: 400, y: 300 }
const layer = {
  id: 'ly1',
  content: 'Hello',
  startSec: 0,
  endSec: 3,
  fontFamily: null,
  sizePct: 6,
  bold: false,
  italic: false,
  colorHex: '#ffffff',
  animation: null
} as unknown as TextLayer

describe('LayerSettingsPopover', () => {
  it('normalizes the patch: empty font/animation → null, size clamped to 30%', () => {
    render(<LayerSettingsPopover layer={layer} anchor={anchor} onClose={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('6'), { target: { value: '50' } })
    fireEvent.click(screen.getByText('timeline.apply'))
    expect(invoke).toHaveBeenCalledWith('textLayers:update', {
      id: 'ly1',
      patch: {
        content: 'Hello',
        startSec: 0,
        endSec: 3,
        fontFamily: null,
        sizePct: 30,
        bold: false,
        italic: false,
        colorHex: '#ffffff',
        animation: null
      }
    })
  })

  it('a blanked content falls back to the stored text (never an empty title)', () => {
    render(<LayerSettingsPopover layer={layer} anchor={anchor} onClose={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('Hello'), { target: { value: '   ' } })
    fireEvent.click(screen.getByText('timeline.apply'))
    const patch = (invoke.mock.calls[0]?.[1] as { patch: { content: string } }).patch
    expect(patch.content).toBe('Hello')
  })

  it('toggles bold into the patch', () => {
    render(<LayerSettingsPopover layer={layer} anchor={anchor} onClose={() => {}} />)
    fireEvent.click(screen.getByText('B'))
    fireEvent.click(screen.getByText('timeline.apply'))
    const patch = (invoke.mock.calls[0]?.[1] as { patch: { bold: boolean } }).patch
    expect(patch.bold).toBe(true)
  })

  it('deletes the layer', () => {
    render(<LayerSettingsPopover layer={layer} anchor={anchor} onClose={() => {}} />)
    fireEvent.click(screen.getByTitle('timeline.layerDelete'))
    expect(invoke).toHaveBeenCalledWith('textLayers:delete', { id: 'ly1' })
  })
})
