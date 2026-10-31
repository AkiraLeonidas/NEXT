import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { Action, Priority, State, Task } from './store.ts'
import { PRIORITIES, addDays, dayKey, doneToday, formatDay, isOverdue, isRealDate, load, msUntilNextDay, nowQueue, progress, queue, reduce, save, tasksFor, weekCounts } from './store.ts'
import { explain } from './priority.ts'
import { deletePhotosFor, photoCounts } from './attachments.ts'
import TaskPhotos from './Photos.tsx'
import BrainDump from './BrainDump.tsx'
import SyncView from './Sync.tsx'
import type { UpdatePayload } from './ai/sync.ts'
import { applyUpdate, execute, summarize } from './ai/sync.ts'
import type { Decisions, FullPlan } from './ai/fullplan.ts'
import { applyFullPlan, reconcile, summarizePlan } from './ai/fullplan.ts'

type Tab = 'now' | 'today' | 'inbox' | 'dump' | 'chat'

type AppAction =
  | Action
  | { type: 'applyUpdate'; update: UpdatePayload; hash: string; accept: string[] }
  | { type: 'applyPlan'; plan: FullPlan; hash: string; decisions: Decisions }
  | { type: 'restore'; state: State } // undo a whole ChatGPT update or plan

type Notice = { text: string; undo?: () => void }

const PRIORITY_LABEL: Record<Priority, string> = { high: 'High', medium: 'Medium', low: 'Low' }

/** Short labels; only "high" priority is shown to keep things calm. Scheduled ≠ deadline. */
function taskMeta(t: Task, today: string, photos = 0): string[] {
  const meta: string[] = []
  if (!t.done && t.pinnedAt) meta.push('Pinned')
  if (!t.done && t.laterOn === today) meta.push('Later')
  if (isOverdue(t, today)) meta.push(`Overdue · planned ${formatDay(t.day)}`)
  if (t.priority === 'high') meta.push('High priority')
  if (t.deadline) meta.push(t.deadline < today ? `Deadline passed (${formatDay(t.deadline)})` : t.deadline === today ? 'Deadline today' : `Deadline ${formatDay(t.deadline)}`)
  if (photos) meta.push(`📎 ${photos}`)
  return meta
}

/**
 * Local calendar day, kept current: at local midnight, when the app returns to the
 * foreground or is reopened, and once a minute (covers sleep and timezone changes).
 */
function useToday(): string {
  const [today, setToday] = useState(dayKey)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const check = () => setToday(dayKey())
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => { check(); arm() }, Math.min(msUntilNextDay() + 500, 60_000))
    }
    const onShow = () => { if (document.visibilityState === 'visible') { check(); arm() } }
    arm()
    document.addEventListener('visibilitychange', onShow)
    window.addEventListener('focus', onShow)
    window.addEventListener('pageshow', onShow)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onShow)
      window.removeEventListener('focus', onShow)
      window.removeEventListener('pageshow', onShow)
    }
  }, [])
  return today
}

/** Photo count per task ID (from IndexedDB). Empty if photos are unavailable. */
function usePhotoCounts(): [Map<string, number>, () => void] {
  const [counts, setCounts] = useState<Map<string, number>>(new Map())
  const refresh = useCallback(() => { photoCounts().then(setCounts).catch(() => setCounts(new Map())) }, [])
  useEffect(refresh, [refresh])
  return [counts, refresh]
}

function appReducer(s: State, a: AppAction): State {
  if (a.type === 'applyUpdate') return applyUpdate(s, a.update, a.hash, new Set(a.accept), dayKey())
  if (a.type === 'applyPlan') return applyFullPlan(s, a.plan, a.hash, a.decisions, dayKey())
  if (a.type === 'restore') return { ...a.state, rev: s.rev + 1 } // revisions only ever increase
  return reduce(s, a, dayKey())
}

export default function App() {
  const [state, dispatch] = useReducer(appReducer, undefined, () => load(localStorage))
  const [tab, setTab] = useState<Tab>('now')
  const [capturing, setCapturing] = useState(false)
  const [detailId, setDetailId] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [saveFailed, setSaveFailed] = useState(false)
  const today = useToday()
  const [photos, refreshPhotos] = usePhotoCounts()
  const [dumpReply, setDumpReply] = useState<{ raw: string; n: number } | null>(null)

  useEffect(() => setSaveFailed(!save(localStorage, state)), [state])

  // Photos of deleted tasks are removed at startup. Only tasks that still exist as
  // deleted records count; photos are never removed just because a task is missing.
  const [startState] = useState(state)
  useEffect(() => {
    const deleted = startState.tasks.filter((t) => t.cancelled).map((t) => t.id)
    deletePhotosFor(deleted).then((n) => n && refreshPhotos()).catch(() => {})
  }, [startState, refreshPhotos])

  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(null), 5000)
    return () => clearTimeout(t)
  }, [notice])

  const complete = (task: Task) => {
    dispatch({ type: 'complete', id: task.id })
    setNotice({ text: `Done: ${task.title}`, undo: () => dispatch({ type: 'reopen', id: task.id }) })
  }

  const applyChatUpdate = (update: UpdatePayload, hash: string, accept: string[]) => {
    const before = state
    const result = execute(state, update, today, new Set(accept))
    dispatch({ type: 'applyUpdate', update, hash, accept })
    const text = result.ok ? summarize(result.counts, result.skipped.length, result.conflicts.length) : 'Updated'
    setNotice({ text, undo: () => dispatch({ type: 'restore', state: before }) })
    setTab('now')
  }

  const applyChatPlan = (plan: FullPlan, hash: string, decisions: Decisions) => {
    const before = state
    const result = reconcile(state, plan, today, decisions)
    dispatch({ type: 'applyPlan', plan, hash, decisions })
    setNotice({ text: result.ok ? summarizePlan(result.counts) : 'Day planned', undo: () => dispatch({ type: 'restore', state: before }) })
    setTab('now')
  }

  const detail = state.tasks.find((t) => t.id === detailId && !t.cancelled)

  return (
    <div className="app">
      <main className="content">
        {tab === 'now' && <NowView state={state} today={today} photos={photos} onDone={complete} dispatch={dispatch} onOpen={setDetailId} onAdd={() => setCapturing(true)} />}
        {tab === 'today' && <TodayView state={state} today={today} photos={photos} dispatch={dispatch} onOpen={setDetailId} onDone={complete} />}
        {tab === 'inbox' && <InboxView state={state} dispatch={dispatch} onDump={() => setTab('dump')} />}
        {tab === 'dump' && (
          <BrainDump key={dumpReply?.n ?? 0} state={state} today={today} dispatch={dispatch} initialReply={dumpReply?.raw}
            onFinished={() => { setDumpReply(null); setTab('today') }} />
        )}
        {tab === 'chat' && (
          <SyncView state={state} today={today} onApply={applyChatUpdate} onApplyPlan={applyChatPlan}
            onAlready={() => { setNotice({ text: 'Already applied ✓' }); setTab('now') }}
            onDump={(raw) => { setDumpReply({ raw, n: Date.now() }); setTab('dump') }}
            onOpenDump={() => { setDumpReply(null); setTab('dump') }} />
        )}
      </main>

      {saveFailed && <div className="banner" role="alert">Couldn’t save. Changes may be lost if you close the app.</div>}

      {notice && (
        <div className="toast" role="status">
          <span className="toast-text">{notice.text}</span>
          {notice.undo && (
            <button className="toast-btn" onClick={() => { notice.undo?.(); setNotice(null) }}>
              Undo
            </button>
          )}
        </div>
      )}

      <nav className="tabbar five" aria-label="Sections">
        <TabButton label="Now" active={tab === 'now'} onClick={() => setTab('now')} />
        <TabButton label="Today" active={tab === 'today'} onClick={() => setTab('today')} />
        <button className="tab-capture" aria-label="Quick capture" onClick={() => setCapturing(true)}>+</button>
        <TabButton label={state.thoughts.length ? `Inbox ${state.thoughts.length}` : 'Inbox'} active={tab === 'inbox'} onClick={() => setTab('inbox')} />
        <TabButton label="ChatGPT" active={tab === 'chat'} onClick={() => setTab('chat')} />
      </nav>

      {capturing && <CaptureSheet onClose={() => setCapturing(false)} dispatch={dispatch} onDump={() => { setCapturing(false); setTab('dump') }} />}
      {detail && <DetailSheet task={detail} state={state} today={today} photos={photos.get(detail.id) ?? 0} onPhotos={refreshPhotos} dispatch={dispatch} onClose={() => setDetailId(null)} />}
    </div>
  )
}

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button className={`tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}>
      {label}
    </button>
  )
}

type ViewProps = { state: State; today: string; photos: Map<string, number>; dispatch: (a: Action) => void; onOpen: (id: string) => void }

function Progress({ state, today }: { state: State; today: string }) {
  const { done, total } = progress(state, today)
  if (!total) return null
  return (
    <div className="progress" aria-label={`${done} of ${total} tasks done today`}>
      <div className="progress-track"><div className="progress-fill" style={{ width: `${(done / total) * 100}%` }} /></div>
      <span className="progress-label">{done} of {total} done</span>
    </div>
  )
}

function NowView({ state, today, photos, dispatch, onOpen, onDone, onAdd }: ViewProps & { onDone: (t: Task) => void; onAdd: () => void }) {
  const q = nowQueue(state, today)
  const current = q[0]
  const { total } = progress(state, today)
  const meta = current ? taskMeta(current, today, photos.get(current.id)) : []

  return (
    <section className="now">
      <Progress state={state} today={today} />
      {current ? (
        <>
          <button className="card" onClick={() => onOpen(current.id)} aria-label={`Task: ${current.title}. Open details`}>
            {(current.category || meta.length > 0) && (
              <span className="card-tags">
                {current.category && <span className="chip static">{current.category}</span>}
                {meta.map((m) => <span key={m} className={`chip static ${m.startsWith('Overdue') || m.startsWith('Deadline passed') ? 'alert' : ''}`}>{m}</span>)}
              </span>
            )}
            <h1 className="card-title">{current.title}</h1>
            {current.notes && <p className="card-notes">{current.notes}</p>}
          </button>
          <div className="actions">
            <button className="btn primary big" onClick={() => onDone(current)}>Done</button>
            <button className="btn secondary" onClick={() => dispatch({ type: 'later', id: current.id })} disabled={q.length < 2}>
              {q.length < 2 ? 'Last task today' : 'Later'}
            </button>
          </div>
          {q.length > 1 && <p className="hint">{q.length - 1} more after this</p>}
        </>
      ) : (
        <div className="empty">
          <h1 className="empty-title">{total ? 'All done for today.' : 'Nothing planned.'}</h1>
          <p className="hint">{total ? 'Rest, or add one more thing.' : 'Add the one thing you want to do next.'}</p>
          <button className="btn primary" onClick={onAdd}>Add a task</button>
        </div>
      )}
    </section>
  )
}

const LONG_DAY = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })
}

/** Today + the next six local days, with open-task counts. Not a calendar. */
function DayStrip({ state, today, selected, onSelect }: { state: State; today: string; selected: string; onSelect: (day: string) => void }) {
  return (
    <div className="daystrip" role="group" aria-label="Next 7 days">
      {weekCounts(state, today).map(({ day, open, overdue }, i) => {
        const [y, m, d] = day.split('-').map(Number)
        const date = new Date(y, m - 1, d)
        const label = `${i === 0 ? 'Today, ' : ''}${LONG_DAY(day)}: ${open} open${overdue ? `, ${overdue} overdue` : ''}`
        return (
          <button key={day} className={`day ${day === selected ? 'on' : ''}`} aria-pressed={day === selected} aria-label={label} onClick={() => onSelect(day)}>
            <span className="day-name">{i === 0 ? 'Today' : date.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
            <span className="day-num">{d}</span>
            <span className={`day-count ${overdue ? 'alert' : ''}`}>{open || '·'}</span>
          </button>
        )
      })}
    </div>
  )
}

function TaskRow({ t, today, photos, onOpen, onDone, extra, children }: {
  t: Task; today: string; photos: Map<string, number>; onOpen: (id: string) => void; onDone: (t: Task) => void; extra?: ReactNode; children?: ReactNode
}) {
  const meta = [t.category, ...taskMeta(t, today, photos.get(t.id))].filter(Boolean)
  const overdue = isOverdue(t, today)
  return (
    <li className={`row ${overdue ? 'overdue' : ''}`}>
      <button className="check" aria-label={`Mark ${t.title} done`} onClick={() => onDone(t)} />
      <button className="row-main" onClick={() => onOpen(t.id)}>
        <span className="row-title">{extra}{t.title}</span>
        {meta.length > 0 && <span className="row-meta">{meta.join(' · ')}</span>}
      </button>
      {children}
    </li>
  )
}

function DoneList({ tasks, dispatch, onOpen }: { tasks: Task[]; dispatch: (a: Action) => void; onOpen: (id: string) => void }) {
  if (!tasks.length) return null
  return (
    <>
      <h2 className="section-title">Done</h2>
      <ul className="list">
        {tasks.map((t) => (
          <li key={t.id} className="row done">
            <button className="check checked" aria-label={`Reopen ${t.title}`} onClick={() => dispatch({ type: 'reopen', id: t.id })}>✓</button>
            <button className="row-main" onClick={() => onOpen(t.id)}><span className="row-title">{t.title}</span><span className="row-meta">Completed</span></button>
          </li>
        ))}
      </ul>
    </>
  )
}

function TodayView({ state, today, photos, dispatch, onOpen, onDone }: ViewProps & { onDone: (t: Task) => void }) {
  const [picked, setPicked] = useState(today)
  const lastDay = addDays(today, 6)
  // Falls back to today when the picked day has passed (e.g. after midnight).
  const selected = picked >= today && picked <= lastDay ? picked : today
  const isToday = selected === today
  const q = isToday ? nowQueue(state, today) : queue(state, selected)
  const overdue = q.filter((t) => isOverdue(t, today))
  const done = isToday ? doneToday(state, today) : tasksFor(state, selected).filter((t) => t.done)
  const later = state.tasks.filter((t) => !t.done && !t.cancelled && t.day > lastDay).sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order)

  const reorder = (t: Task) => {
    const i = q.findIndex((x) => x.id === t.id)
    return (
      <div className="reorder">
        <button className="icon-btn" aria-label={`Move ${t.title} up`} disabled={i === 0} onClick={() => dispatch({ type: 'move', id: t.id, dir: -1 })}>↑</button>
        <button className="icon-btn" aria-label={`Move ${t.title} down`} disabled={i === q.length - 1} onClick={() => dispatch({ type: 'move', id: t.id, dir: 1 })}>↓</button>
      </div>
    )
  }
  const row = (t: Task) => (
    <TaskRow key={t.id} t={t} today={today} photos={photos} onOpen={onOpen} onDone={onDone}
      extra={isToday && t.id === q[0]?.id ? <span className="now-dot" aria-label="Current task" /> : undefined}>
      {reorder(t)}
    </TaskRow>
  )

  return (
    <section>
      <h1 className="page-title">{isToday ? 'Today' : formatDay(selected)}</h1>
      <DayStrip state={state} today={today} selected={selected} onSelect={setPicked} />
      {isToday && <Progress state={state} today={today} />}
      {!q.length && !done.length && <p className="hint">{isToday ? 'No tasks yet. Tap + to add one.' : 'Nothing planned for this day.'}</p>}

      {/* Overdue and today's tasks form one ranked queue; overdue rows are marked. */}
      <ul className="list" aria-label={isToday ? 'Today’s queue' : `Scheduled for ${formatDay(selected)}`}>{q.map(row)}</ul>
      {isToday && overdue.length > 0 && (
        <p className="hint left small-gap">{overdue.length} overdue from earlier days, kept on {overdue.length === 1 ? 'its' : 'their'} original date.</p>
      )}

      <DoneList tasks={done} dispatch={dispatch} onOpen={onOpen} />

      {isToday && later.length > 0 && (
        <>
          <h2 className="section-title">Later</h2>
          <ul className="list">
            {later.map((t) => (
              <li key={t.id} className="row">
                <button className="row-main" onClick={() => onOpen(t.id)}>
                  <span className="row-title">{t.title}</span>
                  <span className="row-meta">{formatDay(t.day)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function InboxView({ state, dispatch, onDump }: { state: State; dispatch: (a: Action) => void; onDump: () => void }) {
  return (
    <section>
      <h1 className="page-title">Inbox</h1>
      <button className="btn secondary wide" onClick={onDump}>Brain dump → tasks with ChatGPT</button>
      <p className="hint">Thoughts you parked. Turn them into tasks or let them go.</p>
      {!state.thoughts.length && <p className="hint">Empty. Your head is clear.</p>}
      <ul className="list">
        {state.thoughts.map((t) => (
          <li key={t.id} className="row thought">
            <span className="row-title wrap">{t.text}</span>
            <div className="thought-actions">
              <button className="btn small" onClick={() => dispatch({ type: 'thoughtToTask', id: t.id })}>Make task</button>
              <button className="btn small ghost" onClick={() => dispatch({ type: 'dropThought', id: t.id })}>Clear</button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2 className="sheet-title">{title}</h2>
          <button className="btn ghost small" onClick={onClose}>Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

function CaptureSheet({ onClose, dispatch, onDump }: { onClose: () => void; dispatch: (a: Action) => void; onDump: () => void }) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<'task' | 'thought'>('task')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])

  const submit = () => {
    if (!text.trim()) return
    dispatch(kind === 'task' ? { type: 'add', title: text } : { type: 'capture', text })
    onClose()
  }

  return (
    <Sheet title="Capture" onClose={onClose}>
      <div className="segmented" role="radiogroup" aria-label="Save as">
        <button role="radio" aria-checked={kind === 'task'} className={kind === 'task' ? 'on' : ''} onClick={() => setKind('task')}>Task for today</button>
        <button role="radio" aria-checked={kind === 'thought'} className={kind === 'thought' ? 'on' : ''} onClick={() => setKind('thought')}>Thought for later</button>
      </div>
      <textarea
        ref={ref}
        className="input"
        rows={3}
        placeholder={kind === 'task' ? 'What needs doing?' : 'What’s on your mind?'}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
      />
      <button className="btn primary big" onClick={submit} disabled={!text.trim()}>Save</button>
      <button className="btn ghost" onClick={onDump}>Lots on your mind? Brain dump →</button>
    </Sheet>
  )
}

function DetailSheet({ task, state, today, photos, onPhotos, dispatch, onClose }: {
  task: Task; state: State; today: string; photos: number; onPhotos: () => void; dispatch: (a: Action) => void; onClose: () => void
}) {
  const [title, setTitle] = useState(task.title)
  const [notes, setNotes] = useState(task.notes)
  const [newCat, setNewCat] = useState('')
  const [why, setWhy] = useState(false)

  const close = () => {
    dispatch({ type: 'update', id: task.id, patch: { title, notes } })
    onClose()
  }
  const act = (a: Action) => { dispatch({ type: 'update', id: task.id, patch: { title, notes } }); dispatch(a); onClose() }

  const addCategory = () => {
    const name = newCat.trim()
    if (!name) return
    dispatch({ type: 'addCategory', name })
    dispatch({ type: 'update', id: task.id, patch: { category: name } })
    setNewCat('')
  }

  const remove = () => {
    const extra = photos ? ` Its ${photos} photo${photos === 1 ? '' : 's'} will be deleted from this device.` : ''
    if (!confirm(`Delete “${task.title}”?${extra}`)) return
    dispatch({ type: 'remove', id: task.id })
    if (photos) deletePhotosFor([task.id]).finally(onPhotos)
    onClose()
  }

  const reasons = explain(task, today)
  const manual = !task.done && (task.pinnedAt || task.laterOn === today || task.adjust)

  return (
    <Sheet title="Task" onClose={close}>
      <label className="field">
        <span className="label">Title</span>
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="field">
        <span className="label">Notes</span>
        <textarea className="input" rows={3} value={notes} placeholder="Optional details or first step" onChange={(e) => setNotes(e.target.value)} />
      </label>
      <div className="field">
        <span className="label">Category</span>
        <div className="chips">
          {state.categories.map((c) => (
            <button key={c} className={`chip ${task.category === c ? 'on' : ''}`} aria-pressed={task.category === c}
              onClick={() => dispatch({ type: 'update', id: task.id, patch: { category: task.category === c ? '' : c } })}>
              {c}
            </button>
          ))}
        </div>
        <div className="inline-add">
          <input className="input" value={newCat} placeholder="New category" onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCategory()} />
          <button className="btn small" onClick={addCategory} disabled={!newCat.trim()}>Add</button>
        </div>
      </div>
      <div className="field">
        <span className="label">Priority</span>
        <div className="chips">
          {PRIORITIES.map((p) => (
            <button key={p} className={`chip ${task.priority === p ? 'on' : ''}`} aria-pressed={task.priority === p}
              onClick={() => dispatch({ type: 'update', id: task.id, patch: { priority: task.priority === p ? undefined : p } })}>
              {PRIORITY_LABEL[p]}
            </button>
          ))}
        </div>
      </div>
      <label className="field">
        <span className="label">Planned for (flexible)</span>
        <input className="input" type="date" value={task.day}
          onChange={(e) => isRealDate(e.target.value) && dispatch({ type: 'moveTo', id: task.id, day: e.target.value })} />
        {isOverdue(task, today) && <span className="field-note alert">Overdue since {formatDay(task.day)}. Still in today’s queue.</span>}
      </label>
      <label className="field">
        <span className="label">Hard deadline</span>
        <div className="inline-add">
          <input className="input" type="date" value={task.deadline ?? ''}
            onChange={(e) => dispatch({ type: 'update', id: task.id, patch: { deadline: e.target.value } })} />
          {task.deadline && <button className="btn small" onClick={(e) => { e.preventDefault(); dispatch({ type: 'update', id: task.id, patch: { deadline: '' } }) }}>Clear</button>}
        </div>
      </label>

      <TaskPhotos taskId={task.id} onChange={onPhotos} />

      {!task.done && (
        <div className="field">
          <button className="why-toggle" aria-expanded={why} onClick={() => setWhy(!why)}>Why is it here? {why ? '▴' : '▾'}</button>
          {why && (
            <ul className="why">
              {task.pinnedAt && <li>Pinned with “Do this now”: shown before everything else.</li>}
              {task.laterOn === today && <li>Sent “Later” today: shown last until tomorrow.</li>}
              {reasons.map((r) => <li key={r.label}><span>{r.label}</span><span>{r.points > 0 ? `+${r.points}` : r.points}</span></li>)}
              <li className="why-total"><span>Score</span><span>{reasons.reduce((n, r) => n + r.points, 0)}</span></li>
            </ul>
          )}
        </div>
      )}

      <div className="detail-actions">
        {task.done ? (
          <button className="btn secondary" onClick={() => act({ type: 'reopen', id: task.id })}>Not done yet</button>
        ) : (
          <>
            <button className="btn secondary" onClick={() => act({ type: 'toTop', id: task.id })}>Do this now</button>
            {manual && <button className="btn secondary" onClick={() => act({ type: 'autoOrder', id: task.id })}>Use automatic order</button>}
            {task.day <= today && <button className="btn secondary" onClick={() => act({ type: 'tomorrow', id: task.id })}>Move to tomorrow</button>}
          </>
        )}
        <button className="btn danger" onClick={remove}>Delete task</button>
      </div>
    </Sheet>
  )
}
