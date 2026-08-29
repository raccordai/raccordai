// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { installApiMock } from '../../../../../../tests/helpers/rendererTest'
import { FeedbackNotePopover } from './FeedbackNotePopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

let invoke: Mock
beforeEach(() => {
  invoke = installApiMock()
})
afterEach(cleanup)

const note = {
  x: 400,
  y: 300,
  timecodeSec: 12.3,
  nodeId: 'n1',
  nodeLabel: 'Shot 2'
}

describe('FeedbackNotePopover', () => {
  it('saves on Enter with the FROZEN timecode and node identity', () => {
    const onClose = vi.fn()
    render(<FeedbackNotePopover videoId="v1" note={note} onClose={onClose} />)
    const textarea = screen.getByPlaceholderText('timeline.notePlaceholder')
    fireEvent.change(textarea, { target: { value: 'trop sombre' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(invoke).toHaveBeenCalledWith('feedback:create', {
      videoId: 'v1',
      comment: 'trop sombre',
      timecodeSec: 12.3,
      nodeId: 'n1',
      nodeLabel: 'Shot 2'
    })
    expect(onClose).toHaveBeenCalled()
  })

  it('omits the node fields when the playhead sat outside any clip', () => {
    render(
      <FeedbackNotePopover
        videoId="v1"
        note={{ ...note, nodeId: null, nodeLabel: null }}
        onClose={() => {}}
      />
    )
    const textarea = screen.getByPlaceholderText('timeline.notePlaceholder')
    fireEvent.change(textarea, { target: { value: 'note' } })
    fireEvent.keyDown(textarea, { key: 'Enter' })
    expect(invoke).toHaveBeenCalledWith('feedback:create', {
      videoId: 'v1',
      comment: 'note',
      timecodeSec: 12.3
    })
  })

  it('refuses an empty note (button disabled, Enter is a no-op)', () => {
    render(<FeedbackNotePopover videoId="v1" note={note} onClose={() => {}} />)
    const button = screen.getByText('timeline.noteSave') as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.keyDown(screen.getByPlaceholderText('timeline.notePlaceholder'), { key: 'Enter' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('Shift+Enter keeps typing instead of saving', () => {
    render(<FeedbackNotePopover videoId="v1" note={note} onClose={() => {}} />)
    const textarea = screen.getByPlaceholderText('timeline.notePlaceholder')
    fireEvent.change(textarea, { target: { value: 'multi' } })
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true })
    expect(invoke).not.toHaveBeenCalled()
  })
})
