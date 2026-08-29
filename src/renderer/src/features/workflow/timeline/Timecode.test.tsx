// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Timecode } from './Timecode'

afterEach(cleanup)

describe('Timecode', () => {
  it('renders a fixed-width HH:MM:SS:FF at 25 fps', () => {
    render(<Timecode seconds={65.5} />)
    // 65.5 s → 1637 frames → 00:01:05 + 12 frames.
    expect(screen.getByText(/05:12/)).toBeTruthy()
    const text = document.body.textContent
    expect(text).toBe('00:01:05:12')
  })

  it('never renders negative time', () => {
    render(<Timecode seconds={-3} />)
    expect(document.body.textContent).toBe('00:00:00:00')
  })
})
