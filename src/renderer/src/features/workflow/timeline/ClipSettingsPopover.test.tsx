// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { GraphNode, TimelineSegment } from '@shared/ipc/contracts'
import { CLIP_TRANSITION_IDS } from '@shared/transitions'
import { installApiMock } from '../../../../../../tests/helpers/rendererTest'
import { ClipSettingsPopover } from './ClipSettingsPopover'
import type { EngineClip } from './types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

let invoke: Mock
beforeEach(() => {
  invoke = installApiMock()
})
afterEach(cleanup)

const anchor = { x: 400, y: 300 }

function videoClip(segment: Partial<TimelineSegment> = {}): EngineClip {
  const seg: TimelineSegment = {
    trimStartSec: 1,
    trimEndSec: 4,
    transitionAfter: null,
    transitionDurationSec: null,
    ...segment
  }
  const node = {
    id: 'clip1',
    key: 'clip1',
    modelId: 'bytedance/seedance-2-fast',
    overlay: null,
    segments: null,
    ...seg
  } as unknown as GraphNode
  return {
    node,
    segment: seg,
    segmentIndex: 0,
    entryId: 'clip1#0',
    url: 'media://c.mp4',
    declared: 5
  }
}

describe('ClipSettingsPopover', () => {
  it('applies trim and overlay together (comma decimals, empty overlay = null)', () => {
    render(
      <ClipSettingsPopover
        clip={videoClip()}
        isLast={false}
        anchor={anchor}
        splitAtMediaSec={null}
        onClose={() => {}}
      />
    )
    fireEvent.change(screen.getByDisplayValue('4'), { target: { value: '3,5' } })
    fireEvent.click(screen.getByText('timeline.apply'))
    expect(invoke).toHaveBeenCalledWith('nodes:setTrim', {
      nodeId: 'clip1',
      trimStartSec: 1,
      trimEndSec: 3.5,
      segmentIndex: 0
    })
    expect(invoke).toHaveBeenCalledWith('nodes:setOverlay', { nodeId: 'clip1', overlay: null })
  })

  it('a typed overlay ships with its defaults (align 2, size md)', () => {
    render(
      <ClipSettingsPopover
        clip={videoClip()}
        isLast={false}
        anchor={anchor}
        splitAtMediaSec={null}
        onClose={() => {}}
      />
    )
    fireEvent.change(screen.getByPlaceholderText('timeline.overlayPlaceholder'), {
      target: { value: 'Chapter one' }
    })
    fireEvent.click(screen.getByText('timeline.apply'))
    expect(invoke).toHaveBeenCalledWith('nodes:setOverlay', {
      nodeId: 'clip1',
      overlay: { text: 'Chapter one', align: 2, size: 'md' }
    })
  })

  it('writes the transition immediately with a clamped duration', () => {
    render(
      <ClipSettingsPopover
        clip={videoClip()}
        isLast={false}
        anchor={anchor}
        splitAtMediaSec={null}
        onClose={() => {}}
      />
    )
    // Combobox order in the popover: speed, look, transition.
    const transitionSelect = screen.getAllByRole('combobox')[2]!
    const id = CLIP_TRANSITION_IDS[0]!
    fireEvent.change(transitionSelect, { target: { value: id } })
    expect(invoke).toHaveBeenCalledTimes(1)
    const [channel, payload] = invoke.mock.calls[0] as [
      string,
      { transition: string; durationSec: number; segmentIndex: number }
    ]
    expect(channel).toBe('nodes:setTransition')
    expect(payload.transition).toBe(id)
    expect(payload.segmentIndex).toBe(0)
    expect(payload.durationSec).toBeGreaterThanOrEqual(0.1)
    expect(payload.durationSec).toBeLessThanOrEqual(2)
  })

  it('changes the playback speed (1× stores null)', () => {
    render(
      <ClipSettingsPopover
        clip={videoClip()}
        isLast={false}
        anchor={anchor}
        splitAtMediaSec={null}
        onClose={() => {}}
      />
    )
    const speedSelect = screen.getAllByRole('combobox')[0]!
    fireEvent.change(speedSelect, { target: { value: '2' } })
    expect(invoke).toHaveBeenCalledWith('nodes:setSpeed', { nodeId: 'clip1', speed: 2 })
    fireEvent.change(speedSelect, { target: { value: '1' } })
    expect(invoke).toHaveBeenCalledWith('nodes:setSpeed', { nodeId: 'clip1', speed: null })
  })

  it('the razor is disabled without a playhead split point, armed with one', () => {
    const { rerender } = render(
      <ClipSettingsPopover
        clip={videoClip()}
        isLast={false}
        anchor={anchor}
        splitAtMediaSec={null}
        onClose={() => {}}
      />
    )
    const splitButton = screen.getByTitle('timeline.splitHint') as HTMLButtonElement
    expect(splitButton.disabled).toBe(true)
    rerender(
      <ClipSettingsPopover
        clip={videoClip()}
        isLast={false}
        anchor={anchor}
        splitAtMediaSec={2.5}
        onClose={() => {}}
      />
    )
    fireEvent.click(screen.getByTitle('timeline.splitHint'))
    expect(invoke).toHaveBeenCalledWith('nodes:splitClip', { nodeId: 'clip1', atMediaSec: 2.5 })
  })
})
