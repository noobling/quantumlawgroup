import { useRef } from 'react'
import {
  DocumentEditorContainerComponent,
  Toolbar,
  Inject
} from '@syncfusion/ej2-react-documenteditor'
import { registerLicense } from '@syncfusion/ej2-base'
import '../lib/syncfusion-styles'
import { markdownToSfdt } from '../lib/sfdt'

// Community/trial — an empty key shows a banner but still renders, which is fine
// for the spike. A real key would be registered here.
registerLicense('')

// A real contract (with an AI redline in §6.1) run through our markdown→SFDT
// converter — proves it renders content + tracked changes fully client-side.
const SAMPLE_MD = `# Consulting Services Agreement

This Consulting Services Agreement is entered into between Brightline Analytics LLC ("Consultant") and the Client.

## 5. Term and Termination

5.1 This Agreement continues until terminated. Consultant may terminate at any time on thirty (30) days' notice.

## 6. Liability

6.1 Consultant's total liability under this Agreement shall not exceed <del>the fees paid in the one (1) month preceding the claim.</del><ins>the greater of twelve (12) months' fees or $250,000, applicable mutually to both parties.</ins>

6.2 Consultant shall not be liable for any indirect, special, or consequential damages.`

const SAMPLE_SFDT = markdownToSfdt(SAMPLE_MD)

export default function SyncfusionSpike(): JSX.Element {
  const ref = useRef<DocumentEditorContainerComponent>(null)

  const onCreated = (): void => {
    ref.current?.documentEditor.open(SAMPLE_SFDT)
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col bg-paper">
      <div className="h-10 shrink-0 border-b border-black/10 flex items-center px-4 text-[12px] text-ink-700 gap-3">
        <span className="font-medium">Syncfusion spike</span>
      </div>
      <div className="flex-1 min-h-0">
        <DocumentEditorContainerComponent
          ref={ref}
          height="100%"
          enableToolbar={true}
          serviceUrl=""
          created={onCreated}
        >
          <Inject services={[Toolbar]} />
        </DocumentEditorContainerComponent>
      </div>
    </div>
  )
}
