import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { FileText, Loader2 } from 'lucide-react'

export default function Deliverable({
  text,
  running,
  emptyHint
}: {
  text: string
  running: boolean
  emptyHint: string
}): JSX.Element {
  if (!text && running) {
    return (
      <div className="h-full grid place-items-center text-ink-600">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 text-accent animate-spin" />
          <span className="text-sm">{emptyHint}</span>
        </div>
      </div>
    )
  }
  if (!text) {
    return (
      <div className="h-full grid place-items-center text-ink-600">
        <div className="flex flex-col items-center gap-2">
          <FileText className="w-7 h-7 opacity-40" />
          <span className="text-sm">The draft will appear here.</span>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-paper">
      <div className="max-w-3xl mx-auto px-12 py-10">
        <div className={`prose-legal ${running ? 'caret' : ''}`}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children }) => (
                <a
                  href={href}
                  onClick={(e) => {
                    e.preventDefault()
                    if (href) window.open(href, '_blank')
                  }}
                  style={{ color: '#a07f2e', textDecoration: 'underline' }}
                >
                  {children}
                </a>
              )
            }}
          >
            {text}
          </ReactMarkdown>
        </div>
      </div>
    </div>
  )
}
