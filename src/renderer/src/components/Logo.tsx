import logoSrc from '../assets/logo.png'

interface LogoProps {
  className?: string
}

/**
 * Brand mark: the Raccord "R" tile — same artwork as the app icon
 * (build/icon.png), pre-rounded with the macOS corner proportion.
 */
export function Logo({ className = 'h-6 w-6' }: LogoProps) {
  return <img src={logoSrc} alt="" className={className} aria-hidden="true" />
}
