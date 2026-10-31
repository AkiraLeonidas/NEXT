import { useState } from 'react'
import type { State } from './store.ts'
import type { Conflict, UpdatePayload } from './ai/sync.ts'
import { detectKind, execute, parseUpdate, planText, setupPrompt } from './ai/sync.ts'

type Pending = { update: UpdatePayload; hash: string; conflicts: Conflict[]; useTheirs: Set<string> }

const FIELD_LABEL: Record<string, string> = {
  title: 'Title', notes: 'Notes', category: 'Category', priority: 'Priority', deadline: 'Deadline', day: 'Day', done: 'Status', cancelled: 'Cancel',
}

export default function SyncView({ state, today, onApply, onAlready, onDump, onOpenDump }: {
  state: State
  today: string
  onApply: (update: UpdatePayload, hash: string, accept: string[]) => void
  onAlready: () => void
  onDump: (raw: string) => void
  onOpenDump: () => void
}) {
  const [manual, setManual] = useState(false)
  const [text, setText] = useState('')
  const [errors, setErrors] = useState<string[]>([])
  const [status, setStatus] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  const [fallbackCopy, setFallbackCopy] = useState('')

  const process = (raw: string) => {
    setErrors([])
    setStatus('')
    const kind = detectKind(raw)
    if (kind === 'dump') return onDump(raw)
    if (kind === 'plan') return setErrors(['That’s the plan for ChatGPT. Paste ChatGPT’s answer here instead.'])
    if (kind === 'none') return setErrors(['No NEXT update found. In ChatGPT, tap Copy on the code block and try again.'])
    const parsed = parseUpdate(raw)
    if (!parsed.ok) return setErrors(parsed.errors.slice(0, 6))
    if (state.applied.includes(parsed.hash)) return onAlready()
    const result = execute(state, parsed.update, today)
    if (!result.ok) return setErrors(result.errors.slice(0, 6))
    if (result.conflicts.length) return setPending({ update: parsed.update, hash: parsed.hash, conflicts: result.conflicts, useTheirs: new Set() })
    onApply(parsed.update, parsed.hash, [])
  }

  const pasteNow = async () => {
    try {
      const clip = await navigator.clipboard.readText()
      if (clip.trim()) return process(clip)
      setStatus('Clipboard is empty. Copy ChatGPT’s answer first.')
    } catch {
      setManual(true)
      setStatus('Long-press the box below and tap Paste.')
    }
  }

  const copy = async (content: string, done: string) => {
    try {
      await navigator.clipboard.writeText(content)
      setFallbackCopy('')
      setStatus(done)
    } catch {
      setFallbackCopy(content)
      setStatus('Couldn’t copy automatically. Select the text below and copy it.')
    }
  }

  if (pending) {
    const toggle = (key: string) => setPending((p) => {
      if (!p) return p
      const next = new Set(p.useTheirs)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return { ...p, useTheirs: next }
    })
    return (
      <section>
        <h1 className="page-title">Check changes</h1>
        <p className="hint left">You changed {pending.conflicts.length === 1 ? 'this' : 'these'} in NEXT after copying the plan. Everything else is ready.</p>
        <ul className="list">
          {pending.conflicts.map((c) => (
            <li key={c.key} className="row review">
              <div className="review-body">
                <span className="row-title wrap">{c.title}</span>
                <span className="row-meta">{FIELD_LABEL[c.field]}: yours “{c.mine}” · ChatGPT “{c.theirs}”</span>
              </div>
              <div className="segmented small two" role="radiogroup" aria-label={`${FIELD_LABEL[c.field]} for ${c.title}`}>
                <button role="radio" aria-checked={!pending.useTheirs.has(c.key)} className={pending.useTheirs.has(c.key) ? '' : 'on'}
                  onClick={() => pending.useTheirs.has(c.key) && toggle(c.key)}>Keep mine</button>
                <button role="radio" aria-checked={pending.useTheirs.has(c.key)} className={pending.useTheirs.has(c.key) ? 'on' : ''}
                  onClick={() => !pending.useTheirs.has(c.key) && toggle(c.key)}>Use ChatGPT’s</button>
              </div>
            </li>
          ))}
        </ul>
        <div className="actions sticky">
          <button className="btn primary big" onClick={() => { onApply(pending.update, pending.hash, [...pending.useTheirs]); setPending(null) }}>Apply update</button>
          <button className="btn ghost" onClick={() => setPending(null)}>Cancel (change nothing)</button>
        </div>
      </section>
    )
  }

  return (
    <section className="sync">
      <h1 className="page-title">ChatGPT</h1>
      <button className="btn primary huge" onClick={pasteNow}>Paste ChatGPT update</button>

      {manual && (
        <textarea
          className="input dump-reply"
          placeholder="Long-press → Paste"
          value={text}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="ChatGPT update"
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text')
            if (pasted.trim()) { e.preventDefault(); setText(pasted); process(pasted) }
          }}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {manual && text.trim() && <button className="btn secondary" onClick={() => process(text)}>Apply</button>}

      {errors.length > 0 && (
        <div className="errors" role="alert">
          <strong>Nothing was changed.</strong>
          <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}

      <button className="btn secondary" onClick={() => copy(planText(state, today), 'Plan copied. Paste it into your ChatGPT chat.')}>Copy plan for ChatGPT</button>

      {status && <p className="hint" role="status">{status}</p>}
      {fallbackCopy && <textarea className="input dump-reply" readOnly value={fallbackCopy} onFocus={(e) => e.target.select()} aria-label="Text to copy" />}

      <div className="sync-links">
        <button className="btn ghost small" onClick={() => copy(setupPrompt(), 'Setup copied. Paste it once into a new ChatGPT chat and pin it.')}>First time? Copy ChatGPT setup</button>
        <button className="btn ghost small" onClick={onOpenDump}>Brain dump</button>
      </div>
    </section>
  )
}
