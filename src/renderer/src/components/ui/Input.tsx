import {
  forwardRef,
  type InputHTMLAttributes,
  type TextareaHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode
} from 'react'

const BASE =
  'w-full rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-500 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent'

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextField(props, ref) {
    return <input ref={ref} {...props} className={`${BASE} ${props.className ?? ''}`} />
  }
)

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function TextArea(props, ref) {
  return (
    <textarea
      ref={ref}
      {...props}
      rows={props.rows ?? 3}
      className={`${BASE} resize-y ${props.className ?? ''}`}
    />
  )
})

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(props, ref) {
    return <select ref={ref} {...props} className={`${BASE} ${props.className ?? ''}`} />
  }
)

export function Label({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <label className={`mb-1 block text-xs font-medium text-neutral-400 ${className}`}>
      {children}
    </label>
  )
}
