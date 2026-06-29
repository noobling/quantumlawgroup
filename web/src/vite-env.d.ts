/// <reference types="vite/client" />

declare module 'mammoth/mammoth.browser' {
  export function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>
  const _default: { extractRawText: typeof extractRawText }
  export default _default
}
