import { useEffect, useRef } from 'react'
import { DocumentEditorContainerComponent, Toolbar, Inject } from '@syncfusion/ej2-react-documenteditor'
import { registerLicense } from '@syncfusion/ej2-base'
import '../lib/syncfusion-styles'
import { markdownToSfdt } from '../lib/sfdt'

// Register the Syncfusion license from an env var (VITE_SYNCFUSION_LICENSE).
// Without it the editor shows a trial banner/nag but still works.
registerLicense(import.meta.env.VITE_SYNCFUSION_LICENSE ?? '')

/**
 * Word-grade document pane backed by Syncfusion's Document Editor. We convert
 * the matter's Markdown document (with <ins>/<del> redlines) to SFDT in the
 * renderer — no docx→SFDT server — so the AI's redlines show as native
 * tracked-change suggestions.
 */
export default function SyncfusionPane({ documentText }: { documentText: string }): JSX.Element {
  const ref = useRef<DocumentEditorContainerComponent>(null)

  const open = (md: string): void => {
    const editor = ref.current?.documentEditor
    if (!editor || !md.trim()) return
    editor.open(markdownToSfdt(md))
    editor.enableTrackChanges = true // user edits are tracked too
  }

  // Reload when the AI edits the document.
  useEffect(() => {
    open(documentText)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentText])

  return (
    <div className="h-full bg-paper">
      <DocumentEditorContainerComponent
        ref={ref}
        height="100%"
        enableToolbar
        serviceUrl=""
        created={() => open(documentText)}
      >
        <Inject services={[Toolbar]} />
      </DocumentEditorContainerComponent>
    </div>
  )
}
