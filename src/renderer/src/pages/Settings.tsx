import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { MODELS } from '@shared/types'
import { KeyRound, Check, Loader2, FolderOpen, ShieldCheck, ExternalLink } from 'lucide-react'

export default function Settings(): JSX.Element {
  const { settings, keyPresent, saveSettings, refreshKey, setToast } = useStore()
  const [keyInput, setKeyInput] = useState('')
  const [savingKey, setSavingKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [profile, setProfile] = useState(settings?.profile ?? '')

  useEffect(() => {
    setProfile(settings?.profile ?? '')
  }, [settings?.profile])

  if (!settings) return <div className="p-8 text-ink-600">Loading…</div>

  const saveKey = async (): Promise<void> => {
    if (!keyInput.trim()) return
    setSavingKey(true)
    await window.api.key.set(keyInput.trim())
    await refreshKey()
    setKeyInput('')
    setSavingKey(false)
    setToast('API key saved securely.')
  }

  const clearKey = async (): Promise<void> => {
    await window.api.key.clear()
    await refreshKey()
    setToast('API key removed.')
  }

  const test = async (): Promise<void> => {
    setTesting(true)
    const res = await window.api.key.test()
    setTesting(false)
    setToast(res.ok ? `Connected — ${res.model} responded.` : `Connection failed: ${res.error}`)
  }

  const pickFolder = async (): Promise<void> => {
    const dir = await window.api.settings.pickMatterRoot()
    if (dir) await saveSettings({ matterRoot: dir })
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10 space-y-8">
        <h1 className="font-serif text-2xl font-semibold">Settings</h1>

        {/* API key */}
        <section className="bg-ink-900/60 border border-ink-700/60 rounded-xl p-6">
          <div className="flex items-center gap-2 mb-1">
            <KeyRound className="w-4 h-4 text-accent" />
            <h2 className="font-medium">Anthropic API key</h2>
            {keyPresent && (
              <span className="ml-2 flex items-center gap-1 text-[12px] text-emerald-400">
                <Check className="w-3.5 h-3.5" /> Saved
              </span>
            )}
          </div>
          <p className="text-[12.5px] text-ink-600 mb-3 flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5" /> Stored encrypted on this PC with Windows DPAPI. Never leaves your machine except to call the API.
          </p>
          <div className="flex gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder={keyPresent ? 'Enter a new key to replace the saved one' : 'sk-ant-…'}
              className="flex-1 bg-ink-950 border border-ink-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60"
            />
            <button
              onClick={() => void saveKey()}
              disabled={savingKey || !keyInput.trim()}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-accent text-ink-950 hover:bg-accent-soft disabled:opacity-40"
            >
              {savingKey ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
            </button>
          </div>
          <div className="flex items-center gap-3 mt-3">
            <button
              onClick={() => void test()}
              disabled={!keyPresent || testing}
              className="text-[12.5px] text-slate-300 border border-ink-700 rounded-md px-3 py-1.5 hover:bg-ink-800 disabled:opacity-40 flex items-center gap-1.5"
            >
              {testing && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Test connection
            </button>
            {keyPresent && (
              <button onClick={() => void clearKey()} className="text-[12.5px] text-red-400 hover:underline">
                Remove key
              </button>
            )}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noreferrer"
              className="text-[12.5px] text-ink-600 hover:text-accent flex items-center gap-1 ml-auto"
            >
              Get a key <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        </section>

        {/* Model */}
        <section className="bg-ink-900/60 border border-ink-700/60 rounded-xl p-6">
          <h2 className="font-medium mb-3">Model</h2>
          <div className="space-y-2">
            {MODELS.map((m) => (
              <label
                key={m.id}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border cursor-pointer transition ${
                  settings.model === m.id ? 'border-accent/60 bg-accent/10' : 'border-ink-700 hover:bg-ink-800'
                }`}
              >
                <input
                  type="radio"
                  name="model"
                  checked={settings.model === m.id}
                  onChange={() => void saveSettings({ model: m.id })}
                  className="accent-accent"
                />
                <span className="text-sm">{m.label}</span>
              </label>
            ))}
          </div>
        </section>

        {/* Matter folder */}
        <section className="bg-ink-900/60 border border-ink-700/60 rounded-xl p-6">
          <h2 className="font-medium mb-1">Export folder</h2>
          <p className="text-[12.5px] text-ink-600 mb-3">Where exported Word, PDF, and Excel deliverables are saved.</p>
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-ink-950 border border-ink-700 rounded-lg px-3 py-2 text-[12.5px] text-slate-300 truncate">
              {settings.matterRoot}
            </code>
            <button
              onClick={() => void pickFolder()}
              className="px-3 py-2 rounded-lg text-sm border border-ink-700 text-slate-300 hover:bg-ink-800 flex items-center gap-1.5"
            >
              <FolderOpen className="w-4 h-4" /> Change
            </button>
          </div>
        </section>

        {/* Practice profile */}
        <section className="bg-ink-900/60 border border-ink-700/60 rounded-xl p-6">
          <h2 className="font-medium mb-1">Practice profile</h2>
          <p className="text-[12.5px] text-ink-600 mb-3">
            House style, escalation rules, and preferences. Injected into every workflow so outputs match your playbook.
          </p>
          <textarea
            rows={7}
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            onBlur={() => void saveSettings({ profile })}
            placeholder={'e.g. We are a Delaware C-corp. Escalate anything over $250k or with uncapped liability to the GC. Prefer mutual NDAs. House citation style: Bluebook.'}
            className="w-full bg-ink-950 border border-ink-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent/60 resize-none font-mono"
          />
          <p className="text-[11.5px] text-ink-600 mt-1.5">Saved automatically.</p>
        </section>
      </div>
    </div>
  )
}
