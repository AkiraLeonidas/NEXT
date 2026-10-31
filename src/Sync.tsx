import { useState } from 'react'
import type { State } from './store.ts'
import type { Conflict, UpdatePayload } from './ai/sync.ts'
import { detectKind, execute, parseUpdate, planText, setupPrompt } from './ai/sync.ts'
import type { Decisions, FullPlan } from './ai/fullplan.ts'
import { fullPlanSetupPrompt, parseFullPlan, reconcile } from './ai/fullplan.ts'

type Pending =
  | { type: 'update'; update: UpdatePayload; hash: string; conflicts: Conflict[]; useTheirs: Set<string> }
  | { type: 'plan'; plan: FullPlan; hash: string; decisions: Decisions }

const FIELD_LABEL: Record<string, string> = {
  title: 'Title', notes: 'Notes', category: 'Category', priority: 'Priority', deadline: 'Deadline', day: 'Day', done: 'Status', cancelled: 'Cancel',
}

const STEPS = ['Talk in ChatGPT', 'Copy plan', 'Paste here', 'Start day']

function Choice({ label, options, value, onChange }: { label: string; options: [string, string][]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="segmented small two" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  )
}

export default function SyncView({ state, today, onApply, onApplyPlan, onAlready, onDump, onOpenDump }: {
  state: State
  today: string
  onApply: (update: UpdatePayload, hash: string, accept: string[]) => void
  onApplyPlan: (plan: FullPlan, hash: string, decisions: Decisions) => void
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
    if (kind === 'plan') return setErrors(['That’s NEXT’s own snapshot for ChatGPT. Paste ChatGPT’s answer here instead.'])
    if (kind === 'none') return setErrors(['No NEXT plan found. In ChatGPT, write “NEXT-plan”, tap Copy on the code block, and try again.'])

    if (kind === 'fullplan') {
      const parsed = parseFullPlan(raw, today)
      if (!parsed.ok) return setErrors(parsed.errors.slice(0, 6))
      if (state.applied.includes(parsed.hash)) return onAlready()
      const result = reconcile(state, parsed.plan, today)
      if (!result.ok) return setErrors(result.errors.slice(0, 6))
      if (result.review.length) return setPending({ type: 'plan', plan: parsed.plan, hash: parsed.hash, decisions: {} })
      return onApplyPlan(parsed.plan, parsed.hash, {})
    }

    const parsed = parseUpdate(raw)
    if (!parsed.ok) return setErrors(parsed.errors.slice(0, 6))
    if (state.applied.includes(parsed.hash)) return onAlready()
    const result = execute(state, parsed.update, today)
    if (!result.ok) return setErrors(result.errors.slice(0, 6))
    if (result.conflicts.length) return setPending({ type: 'update', update: parsed.update, hash: parsed.hash, conflicts: result.conflicts, useTheirs: new Set() })
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

  // ---- review of a full plan: only uncertain matches and real conflicts
  if (pending?.type === 'plan') {
    const result = reconcile(state, pending.plan, today, pending.decisions)
    const review = result.ok ? result.review : []
    const choose = (id: string, v: string) => setPending({ ...pending, decisions: { ...pending.decisions, [id]: v as Decisions[string] } })
    return (
      <section>
        <h1 className="page-title">Check plan</h1>
        <p className="hint left">Everything else is ready. Just these:</p>
        <ul className="list">
          {review.map((r) => (
            <li key={r.id} className="row review">
              <div className="review-body">
                <span className="row-title wrap">{r.title}</span>
                <span className="row-meta">
                  {r.kind === 'match' ? `Looks like your task “${r.existing}”` : `${FIELD_LABEL[r.field]}: yours “${r.mine}” · ChatGPT “${r.theirs}”`}
                </span>
              </div>
              {r.kind === 'match'
                ? <Choice label={`Is ${r.title} the same task?`} options={[['same', 'Same task'], ['new', 'New task']]} value={pending.decisions[r.id] ?? 'same'} onChange={(v) => choose(r.id, v)} />
                : <Choice label={`${FIELD_LABEL[r.field]} for ${r.title}`} options={[['mine', 'Keep mine'], ['theirs', 'Use ChatGPT’s']]} value={pending.decisions[r.id] ?? 'mine'} onChange={(v) => choose(r.id, v)} />}
            </li>
          ))}
        </ul>
        <div className="actions sticky">
          <button className="btn primary big" onClick={() => { onApplyPlan(pending.plan, pending.hash, pending.decisions); setPending(null) }}>Start day</button>
          <button className="btn ghost" onClick={() => setPending(null)}>Cancel (change nothing)</button>
        </div>
      </section>
    )
  }

  // ---- review of an incremental update (advanced)
  if (pending?.type === 'update') {
    const toggle = (key: string, theirs: boolean) => {
      const next = new Set(pending.useTheirs)
      if (theirs) next.add(key)
      else next.delete(key)
      setPending({ ...pending, useTheirs: next })
    }
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
              <Choice label={`${FIELD_LABEL[c.field]} for ${c.title}`} options={[['mine', 'Keep mine'], ['theirs', 'Use ChatGPT’s']]}
                value={pending.useTheirs.has(c.key) ? 'theirs' : 'mine'} onChange={(v) => toggle(c.key, v === 'theirs')} />
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
      <ol className="steps" aria-label="How it works">
        {STEPS.map((s, i) => <li key={s}><span className="step-n">{i + 1}</span>{s}</li>)}
      </ol>
      <button className="btn primary huge" onClick={pasteNow}>Paste plan from ChatGPT</button>

      {manual && (
        <textarea
          className="input dump-reply"
          placeholder="Long-press → Paste"
          value={text}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-label="ChatGPT plan"
          onPaste={(e) => {
            const pasted = e.clipboardData.getData('text')
            if (pasted.trim()) { e.preventDefault(); setText(pasted); process(pasted) }
          }}
          onChange={(e) => setText(e.target.value)}
        />
      )}
      {manual && text.trim() && <button className="btn secondary" onClick={() => process(text)}>Use this plan</button>}

      {errors.length > 0 && (
        <div className="errors" role="alert">
          <strong>Nothing was changed.</strong>
          <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
        </div>
      )}
      {status && <p className="hint" role="status">{status}</p>}
      {fallbackCopy && <textarea className="input dump-reply" readOnly value={fallbackCopy} onFocus={(e) => e.target.select()} aria-label="Text to copy" />}

      <button className="btn secondary" onClick={() => copy(fullPlanSetupPrompt(), 'Setup copied. Paste it once into your ChatGPT chat and pin it.')}>
        First time? Copy ChatGPT setup
      </button>

      <details className="advanced">
        <summary>Advanced</summary>
        <p className="hint left">Incremental updates by task ID: give ChatGPT NEXT’s current tasks first.</p>
        <button className="btn ghost small" onClick={() => copy(planText(state, today), 'NEXT snapshot copied. Paste it into your ChatGPT chat.')}>Copy NEXT snapshot for ChatGPT</button>
        <button className="btn ghost small" onClick={() => copy(setupPrompt(), 'Advanced setup copied. Paste it into a ChatGPT chat.')}>Copy setup for incremental updates</button>
        <button className="btn ghost small" onClick={onOpenDump}>Brain dump</button>
      </details>
    </section>
  )
}
