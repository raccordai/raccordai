// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ImageLayer } from '@shared/ipc/contracts'
import { installApiMock } from '../../../../../../tests/helpers/rendererTest'
import { StickerSettingsPopover } from './StickerSettingsPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

let invoke: Mock
beforeEach(() => {
  invoke = installApiMock()
})
afterEach(cleanup)

const anchor = { x: 400, y: 300 }
const layer = { id: 'st1', startSec: 1, endSec: 4, widthPct: 40 } as unknown as ImageLayer

describe('StickerSettingsPopover', () => {
  it('applies timing (comma decimals accepted) and size in one patch', async () => {
    render(<StickerSettingsPopover layer={layer} anchor={anchor} onClose={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: '2,5' } })
    fireEvent.change(screen.getByDisplayValue('4'), { target: { value: '9' } })
    fireEvent.click(screen.getByText('timeline.apply'))
    expect(invoke).toHaveBeenCalledWith('imageLayers:update', {
      id: 'st1',
      patch: { startSec: 2.5, endSec: 9, widthPct: 40 }
    })
  })

  it('keeps the stored values when a field is unparsable', () => {
    render(<StickerSettingsPopover layer={layer} anchor={anchor} onClose={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('1'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByText('timeline.apply'))
    expect(invoke).toHaveBeenCalledWith('imageLayers:update', {
      id: 'st1',
      patch: { startSec: 1, endSec: 4, widthPct: 40 }
    })
  })

  it('deletes the sticker', () => {
    const onClose = vi.fn()
    render(<StickerSettingsPopover layer={layer} anchor={anchor} onClose={onClose} />)
    fireEvent.click(screen.getByTitle('timeline.stickerDelete'))
    expect(invoke).toHaveBeenCalledWith('imageLayers:delete', { id: 'st1' })
  })
})
