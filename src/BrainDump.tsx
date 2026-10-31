import { useEffect, useState } from 'react'
import type { Action, State } from './store.ts'
import { formatDay } from './store.ts'
import { chatHandoff } from './ai/provider.ts'
import { parseAiOutput } from './ai/schema.ts'
import type { Destination, ReviewItem } from './ai/review.ts'
import { buildReview, toImport } from './ai/review.ts'

const DRAFT_KEY = 'next.dump.v1'
type Step = 'write' | 'paste' | 'review'
type Draft = { text: string; reply: string }

const loadDraft = (): Draft => {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? '{}')
    return { text: typeof d.text === 'string' ? d.text : '', reply: typeof d.reply === 'string' ? d.reply : '' }
  } catch {
    return { text: '', reply: '' }
  }
}

const saveDraft = (d: Draft) => {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)) } catch { /* draft is a convenience only */ }
}

const DEST_LABEL: Record<Destination, string> = { today: 'Today', tomorrow: 'Tomorrow', inbox: 'Inbox' }

function reviewOf(reply: string, state: State, today: string): { items: ReviewItem[]; errors: string[] } {
  const result = parseAiOutput(reply)
  if (!result.ok) return { items: [], errors: result.errors.slice(0, 8) }
  const items = buildReview(result.data, state, today)
  return items.length ? { items, errors: [] } : { items, errors: ['The answer contained no tasks or ideas.'] }
}

export default function BrainDump({ state, today, dispatch, onFinished, initialReply }: {
  state: State; today: string; dispatch: (a: Action) => void; onFinished: () => void
  initialReply?: string // a brain-dump answer pasted on the ChatGPT screen: open straight at review
}) {
  const [initial] = useState(() => (initialReply ? reviewOf(initialReply, state, today) : null))
  const [draft, setDraft] = useState<Draft>(() => (initialReply ? { ...loadDraft(), reply: initialReply } : loadDraft()))
  const [step, setStep] = useState<Step>(initial ? (initial.items.length ? 'review' : 'paste') : 'write')
  const [status, setStatus] = useState('')
  const [errors, setErrors] = useState<string[]>(initial?.errors ?? [])
  const [items, setItems] = useState<ReviewItem[]>(initial?.items ?? [])

  // Keep the draft so a dictated dump survives switching to ChatGPT and back.
  useEffect(() => saveDraft(draft), [draft])

  const prompt = () => chatHandoff.buildPrompt({ text: draft.text, today, categories: state.categories })
  const canShare = typeof navigator.share === 'function'
  const canReadClipboard = typeof navigator.clipboard?.readText === 'function'

  const share = async () => {
    try {
      await navigator.share({ text: prompt() })
      setStep('paste')
      setStatus('')
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setStatus('Sharing failed. Use “Copy prompt” instead.')
    }
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt())
      setStatus('Prompt copied. Paste it into ChatGPT, then copy its answer.')
      setStep('paste')
    } catch {
      setStatus('Couldn’t copy automatically. Your browser blocked clipboard access.')
    }
  }

  const pasteFromClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText()
      setDraft((d) => ({ ...d, reply: text }))
    } catch {
      setStatus('Clipboard access was blocked. Long-press the box and choose Paste.')
    }
  }

  const review = () => {
    const r = reviewOf(draft.reply, state, today)
    setErrors(r.errors)
    if (r.errors.length) return
    setItems(r.items)
    setStep('review')
  }

  const setItem = (key: string, patch: Partial<ReviewItem>) =>
    setItems((list) => list.map((it) => (it.key === key ? { ...it, ...patch } : it)))

  const importSelected = () => {
    dispatch({ type: 'import', ...toImport(items, today) })
    // Save now: this screen closes right away, before the draft effect would run.
    saveDraft({ text: '', reply: '' })
    setDraft({ text: '', reply: '' })
    setItems([])
    setStep('write')
    onFinished()
  }

  const selected = items.filter((i) => i.include).length

  return (
    <section className="dump">
      <h1 className="page-title">Brain dump</h1>

      {step === 'write' && (
        <>
          <p className="hint left">Write or dictate everything on your mind, in Danish or English. Tap the microphone on the iPhone keyboard to dictate.</p>
          <textarea
            className="input dump-text"
            lang="da"
            autoCapitalize="sentences"
            autoCorrect="on"
            spellCheck
            enterKeyHint="enter"
            placeholder="Fx: skal ringe til tandlægen inden fredag, købe mælk, måske lære at spille guitar…"
            value={draft.text}
            onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
            aria-label="Brain dump"
          />
          <div className="actions">
            {canShare && <button className="btn primary big" disabled={!draft.text.trim()} onClick={share}>Share to ChatGPT…</button>}
            <button className={`btn ${canShare ? 'secondary' : 'primary big'}`} disabled={!draft.text.trim()} onClick={copy}>Copy prompt</button>
            <a className="btn ghost link" href={chatHandoff.url} target="_blank" rel="noopener noreferrer">Open ChatGPT</a>
            <button className="btn ghost" onClick={() => setStep('paste')}>I already have an answer</button>
          </div>
        </>
      )}

      {step === 'paste' && (
        <>
          <p className="hint left">Copy ChatGPT’s whole answer and paste it here.</p>
          <textarea
            className="input dump-reply"
            placeholder='{"version": 1, "tasks": [...], "ideas": [...]}'
            value={draft.reply}
            onChange={(e) => setDraft((d) => ({ ...d, reply: e.target.value }))}
            aria-label="AI answer"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
          {errors.length > 0 && (
            <ul className="errors" role="alert">
              {errors.map((e) => <li key={e}>{e}</li>)}
            </ul>
          )}
          <div className="actions">
            <button className="btn primary big" disabled={!draft.reply.trim()} onClick={review}>Review</button>
            {canReadClipboard && <button className="btn secondary" onClick={pasteFromClipboard}>Paste from clipboard</button>}
            <button className="btn ghost" onClick={() => { setErrors([]); setStep('write') }}>Back</button>
          </div>
        </>
      )}

      {step === 'review' && (
        <>
          <p className="hint left">Choose what to keep. Possible duplicates are unchecked.</p>
          <ul className="list">
            {items.map((it) => (
              <li key={it.key} className={`row review ${it.include ? '' : 'off'}`}>
                <div className="review-top">
                  <button className={`check ${it.include ? 'checked' : ''}`} aria-pressed={it.include}
                    aria-label={`${it.include ? 'Skip' : 'Include'} ${it.title}`} onClick={() => setItem(it.key, { include: !it.include })}>
                    {it.include ? '✓' : ''}
                  </button>
                  <div className="review-body">
                    <span className="row-title wrap">{it.title}</span>
                    <span className="row-meta">
                      {[it.kind === 'idea' ? 'Idea' : null,
                        it.task?.priority === 'high' ? 'High priority' : it.task?.priority === 'low' ? 'Low priority' : null,
                        it.task?.deadline ? `Due ${formatDay(it.task.deadline)}` : null,
                        it.task?.category].filter(Boolean).join(' · ')}
                    </span>
                    {it.duplicateOf && <span className="dup">Possible duplicate of “{it.duplicateOf}”</span>}
                  </div>
                </div>
                <div className="segmented small" role="radiogroup" aria-label={`Destination for ${it.title}`}>
                  {(['today', 'tomorrow', 'inbox'] as Destination[]).map((d) => (
                    <button key={d} role="radio" aria-checked={it.destination === d} className={it.destination === d ? 'on' : ''}
                      onClick={() => setItem(it.key, { destination: d })}>
                      {DEST_LABEL[d]}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
          <div className="actions sticky">
            <button className="btn primary big" disabled={!selected} onClick={importSelected}>
              {selected ? `Add ${selected} item${selected === 1 ? '' : 's'}` : 'Nothing selected'}
            </button>
            <button className="btn ghost" onClick={() => setStep('paste')}>Back</button>
          </div>
        </>
      )}

      {status && <p className="hint" role="status">{status}</p>}
    </section>
  )
}
