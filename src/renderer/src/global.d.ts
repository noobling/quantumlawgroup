// React 19 exposes the JSX namespace as React.JSX. Re-expose it globally so
// existing `JSX.Element` return annotations continue to resolve.
import type * as React from 'react'

declare global {
  namespace JSX {
    interface Element extends React.JSX.Element {}
    interface ElementClass extends React.JSX.ElementClass {}
    interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute extends React.JSX.ElementChildrenAttribute {}
    interface IntrinsicElements extends React.JSX.IntrinsicElements {}
    interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  }

  // Vite env vars exposed to the renderer (electron-vite injects these at build).
  interface ImportMetaEnv {
    readonly VITE_SYNCFUSION_LICENSE?: string
  }
  interface ImportMeta {
    readonly env: ImportMetaEnv
  }
}

export {}
