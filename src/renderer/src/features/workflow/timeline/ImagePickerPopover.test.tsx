// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GraphNode } from '@shared/ipc/contracts'
import { installApiMock } from '../../../../../../tests/helpers/rendererTest'
import { ImagePickerPopover } from './ImagePickerPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

beforeEach(() => {
  installApiMock()
})
afterEach(cleanup)

const node = (id: string, label: string): GraphNode =>
  ({ id, key: id, label, modelId: 'unknown/model' }) as unknown as GraphNode

const anchor = { x: 400, y: 300 }

describe('ImagePickerPopover', () => {
  it('shows the empty message when the graph has no candidate', () => {
    render(
      <ImagePickerPopover candidates={[]} anchor={anchor} onPick={() => {}} onClose={() => {}} />
    )
    expect(screen.getByText('timeline.addImageEmpty')).toBeTruthy()
  })

  it('picks a candidate by node id', () => {
    const onPick = vi.fn()
    render(
      <ImagePickerPopover
        candidates={[
          { node: node('n1', 'Poster'), url: 'media://poster.jpg' },
          { node: node('n2', 'Landscape'), url: 'media://landscape.jpg' }
        ]}
        anchor={anchor}
        onPick={onPick}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByText('Landscape'))
    expect(onPick).toHaveBeenCalledWith('n2')
  })

  it('dismisses on Escape and on an outside pointerdown', () => {
    const onClose = vi.fn()
    render(
      <ImagePickerPopover candidates={[]} anchor={anchor} onPick={() => {}} onClose={onClose} />
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.pointerDown(document.body)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
