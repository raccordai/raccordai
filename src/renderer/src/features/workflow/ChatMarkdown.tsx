import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

/**
 * Markdown rendering of the assistant's replies. The transcript used to print
 * the model's raw text in a `whitespace-pre-wrap` div, so `**bold**`, lists and
 * fenced code showed up as literal syntax.
 *
 * react-markdown renders React elements (no `dangerouslySetInnerHTML`, so the
 * renderer's CSP is untouched) and drops raw HTML by default — the internal
 * `<app-context>` / `<system-reminder>` blocks the model is told never to quote
 * back are stripped below anyway, content included.
 *
 * Soft line breaks: markdown collapses a single newline into a space, but the
 * assistant writes shot lists and beat sheets one per line. Paragraphs and list
 * items therefore keep `whitespace-pre-wrap`, which turns the preserved "\n"
 * back into a visible break — same result as remark-breaks, no extra dependency.
 */

/** Internal blocks that must never reach the transcript, tags and content. */
const INTERNAL_BLOCK = /<(app-context|system-reminder)>[\s\S]*?<\/\1>/g
/** …and their unclosed form, when a turn is cut off mid-stream. */
const INTERNAL_OPEN = /<\/?(app-context|system-reminder)>/g

export function stripInternalTags(text: string): string {
  return text.replace(INTERNAL_BLOCK, '').replace(INTERNAL_OPEN, '').trim()
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="mb-2 whitespace-pre-wrap last:mb-0">{children}</p>,
  strong: ({ children }) => <strong className="font-semibold text-neutral-100">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-neutral-500 line-through">{children}</del>,

  h1: ({ children }) => (
    <h1 className="mt-3 mb-1.5 text-sm font-semibold text-neutral-100 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-3 mb-1.5 text-sm font-semibold text-neutral-100 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-3 mb-1 text-xs font-semibold tracking-wide text-neutral-300 uppercase first:mt-0">
      {children}
    </h3>
  ),

  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>,
  ol: ({ children }) => (
    <ol className="mb-2 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>
  ),
  li: ({ children }) => <li className="whitespace-pre-wrap">{children}</li>,

  // Fenced blocks: the container scrolls on its own so the panel never widens.
  // Inline `code` styling is reset for the copy that lands inside a block.
  pre: ({ children }) => (
    <pre className="mb-2 overflow-x-auto rounded-md border border-neutral-800 bg-neutral-900/70 p-2 text-[11px] leading-relaxed last:mb-0 [&_code]:bg-transparent [&_code]:px-0 [&_code]:text-neutral-200">
      {children}
    </pre>
  ),
  code: ({ children }) => (
    <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-[11px] text-accent-soft">
      {children}
    </code>
  ),

  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-accent/40 pl-2.5 text-neutral-400 last:mb-0">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-neutral-800" />,

  // Denied by the window-open handler in main, which hands the URL to the
  // system browser — links never navigate the app shell away.
  a: ({ children, href }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-accent underline underline-offset-2 hover:text-accent-hover"
    >
      {children}
    </a>
  ),

  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-[11px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-neutral-800 px-1.5 py-1 text-left font-semibold text-neutral-300">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border border-neutral-800 px-1.5 py-1 align-top">{children}</td>
  )
}

export function ChatMarkdown({
  text,
  children
}: {
  text: string
  /** Streaming caret, appended inside the flow of the last paragraph. */
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="px-1 text-sm leading-relaxed text-neutral-200">
      <Markdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {stripInternalTags(text)}
      </Markdown>
      {children}
    </div>
  )
}
