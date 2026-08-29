import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * Demo mode (§9) — third-party window geometry on macOS, the missing piece
 * for filming ONE application's window (not the whole screen): the capture
 * comes from desktopCapturer window sources, but the input journal needs the
 * window's live BOUNDS, which Electron cannot see for other apps. System
 * Events (osascript) can — and it runs under the same Accessibility
 * permission the global hook already requires (plus a one-time "control
 * System Events" consent). Thin shell, E2E scope; macOS only — other
 * platforms return empty and the take degrades with a warning.
 */

const exec = promisify(execFile)

const SEP = '|||'

export interface DemoWindowInfo {
  app: string
  title: string
  bounds: { x: number; y: number; width: number; height: number }
}

const LIST_SCRIPT = `
tell application "System Events"
  set out to ""
  repeat with p in (processes whose background only is false)
    set pname to name of p
    repeat with w in windows of p
      try
        set {wx, wy} to position of w
        set {ww, wh} to size of w
        set wname to name of w
        if wname is missing value then set wname to ""
        set out to out & pname & "${SEP}" & wname & "${SEP}" & wx & "${SEP}" & wy & "${SEP}" & ww & "${SEP}" & wh & linefeed
      end try
    end repeat
  end repeat
  return out
end tell`

function parseWindowLine(line: string): DemoWindowInfo | null {
  const parts = line.split(SEP)
  if (parts.length !== 6) return null
  const [app, title, x, y, width, height] = parts
  const nums = [x, y, width, height].map(Number)
  if (nums.some((n) => !Number.isFinite(n))) return null
  return {
    app: app!,
    title: title!,
    bounds: { x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]! }
  }
}

/** Every visible window of every regular app — pick one for a demo take. */
export async function listDemoWindows(): Promise<DemoWindowInfo[]> {
  if (process.platform !== 'darwin') return []
  try {
    const { stdout } = await exec('osascript', ['-e', LIST_SCRIPT], { timeout: 10_000 })
    return stdout
      .split('\n')
      .map((line) => parseWindowLine(line.trim()))
      .filter((w): w is DemoWindowInfo => w !== null && w.bounds.width > 0)
  } catch {
    return []
  }
}

/**
 * Live bounds of an app's frontmost window (System Events points — the same
 * DIP space as Electron displays). Null when the app/window is gone.
 */
export async function frontWindowBounds(
  appName: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (process.platform !== 'darwin') return null
  const script = `
tell application "System Events" to tell (first process whose name is ${JSON.stringify(appName)})
  set w to front window
  set {wx, wy} to position of w
  set {ww, wh} to size of w
  return (wx as text) & "${SEP}" & wy & "${SEP}" & ww & "${SEP}" & wh
end tell`
  try {
    const { stdout } = await exec('osascript', ['-e', script], { timeout: 5_000 })
    const parts = stdout.trim().split(SEP).map(Number)
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
    return { x: parts[0]!, y: parts[1]!, width: parts[2]!, height: parts[3]! }
  } catch {
    return null
  }
}
