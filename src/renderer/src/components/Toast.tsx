import { useEffect } from 'react'
import { useStore } from '../state/store'
import { X } from 'lucide-react'

export default function Toast(): JSX.Element | null {
  const { toast, setToast } = useStore()
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(null), 6000)
      return () => clearTimeout(t)
    }
  }, [toast, setToast])

  if (!toast) return null
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 max-w-lg">
      <div className="bg-ink-800 border border-ink-600 rounded-lg shadow-xl px-4 py-3 flex items-start gap-3 text-[13px] text-slate-200">
        <span className="flex-1 break-words">{toast}</span>
        <button onClick={() => setToast(null)} className="text-ink-600 hover:text-slate-200">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
