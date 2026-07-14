import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANT_CLASSES: Record<Variant, string> = {
  primary:
    'bg-accent hover:bg-accent-hover text-neutral-900 font-medium border border-accent/50 shadow-sm shadow-accent/20',
  secondary: 'bg-neutral-800 hover:bg-neutral-700 text-neutral-100 border border-neutral-700',
  ghost: 'bg-transparent hover:bg-neutral-800 text-neutral-300 border border-transparent',
  danger:
    'bg-transparent border border-neutral-700 text-neutral-300 hover:border-danger/40 hover:text-danger'
}

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'gap-1 px-2 py-1 text-xs',
  md: 'gap-1.5 px-3 py-1.5 text-sm'
}

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

export function Button({ variant = 'secondary', size = 'md', className = '', ...rest }: Props) {
  return (
    <button
      {...rest}
      className={`inline-flex items-center rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${SIZE_CLASSES[size]} ${VARIANT_CLASSES[variant]} ${className}`}
    />
  )
}
