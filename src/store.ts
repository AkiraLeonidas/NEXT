// Pure task logic + persistence. No React here, so it can be tested with `node --test`.

import { movePatch, rankTasks } from './priority.ts'

export type Priority = 'high' | 'medium' | 'low'
export const PRIORITIES: Priority[] = ['high', 'medium', 'low']

/** Task fields whose last manual change is tracked, so ChatGPT updates never silently overwrite them. */
export type Field = 'title' | 'notes' | 'category' | 'priority' | 'deadline' | 'day' | 'done' | 'cancelled'
export const TRACKED: Field[] = ['title', 'notes', 'category', 'priority', 'deadline', 'day', 'done', 'cancelled']

export type Task = {
  id: string // permanent; never derived from the title
  title: string
  notes: string
  category: string // '' = none
  priority?: Priority
  deadline?: string // YYYY-MM-DD
  day: string // YYYY-MM-DD the task is planned for (flexible). Never changed by the daily rollover.
  order: number // manual position; tie-breaker after the priority score
  done: boolean
  cancelled?: boolean // cancelled or deleted: hidden, but kept so its ID stays known
  createdAt: number
  doneAt?: number
  userRev?: Partial<Record<Field, number>> // state revision of the last manual change per field
  key?: string // ChatGPT's stable key for this task (full-plan imports)
  importRev?: Partial<Record<Field, number>> // revision at which a full-plan import last set/confirmed each field
  declined?: Partial<Record<Field, string>> // ChatGPT values the user rejected ("Keep mine"), so they don't ask again
  urgency?: Priority // semantic urgency from ChatGPT (full plan v2)
  importance?: Priority // semantic importance from ChatGPT (full plan v2)
  pinnedAt?: number // "Do this now": pinned above everything, newest pin first
  laterOn?: string // day the user tapped "Later"; sorts last for that day only
  laterAt?: number
  adjust?: number // score delta from a manual ↑/↓ move
}

export type Thought = { id: string; text: string; createdAt: number }

/** A task ready to be added, e.g. from a reviewed AI import. */
export type NewTask = {
  title: string; notes?: string; category?: string; priority?: Priority; deadline?: string; day?: string; id?: string
  urgency?: Priority; importance?: Priority
}

export type State = {
  tasks: Task[]
  thoughts: Thought[]
  categories: string[]
  rev: number // increases on every change; ChatGPT updates refer to it
  seq: number // counter for task IDs created in NEXT (t1, t2, …)
  applied: string[] // fingerprints of applied ChatGPT updates, so re-pasting is harmless
}

export type Action =
  | ({ type: 'add' } & NewTask)
  | { type: 'import'; tasks: NewTask[]; ideas: string[] }
  | { type: 'complete'; id: string }
  | { type: 'reopen'; id: string }
  | { type: 'later'; id: string }
  | { type: 'tomorrow'; id: string }
  | { type: 'moveTo'; id: string; day: string }
  | { type: 'move'; id: string; dir: -1 | 1 }
  | { type: 'toTop'; id: string }
  | { type: 'place'; id: string } // position among the day's open tasks by priority
  | { type: 'update'; id: string; patch: Partial<Pick<Task, 'title' | 'notes' | 'category' | 'priority' | 'deadline'>> }
  | { type: 'autoOrder'; id: string } // drop pin, "Later" and manual moves
  | { type: 'remove'; id: string }
  | { type: 'capture'; text: string }
  | { type: 'dropThought'; id: string }
  | { type: 'thoughtToTask'; id: string }
  | { type: 'addCategory'; name: string }

export const STORAGE_KEY = 'next.v1'
export const BACKUP_KEY = 'next.v1.backup-before-ids'
export const DEFAULT_CATEGORIES = ['Work', 'Home', 'Health', 'Errands']
const MAX_APPLIED = 200

export const emptyState = (): State => ({ tasks: [], thoughts: [], categories: [...DEFAULT_CATEGORIES], rev: 0, seq: 0, applied: [] })

// crypto.randomUUID is unavailable over plain http (e.g. testing on a phone via LAN IP).
const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8)

/** Next free NEXT-created task ID: t1, t2, … */
export function nextTaskId(state: State, alsoUsed: Set<string> = new Set()): { id: string; seq: number } {
  const used = new Set([...alsoUsed, ...state.tasks.map((t) => t.id)])
  let seq = state.seq
  do seq++
  while (used.has(`t${seq}`))
  return { id: `t${seq}`, seq }
}

export function dayKey(d: Date = new Date()): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Milliseconds until the next local calendar day starts (DST-aware: uses local midnight, not +24h). */
export function msUntilNextDay(now: Date = new Date()): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return Math.max(1000, next.getTime() - now.getTime())
}

/** The device's IANA timezone, e.g. "Europe/Copenhagen" ('' if unknown). */
export function timeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '' } catch { return '' }
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + n))
}

/** e.g. "Fri 6 Nov" */
export function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
}

export const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

const rank = (p?: Priority) => PRIORITIES.indexOf(p ?? 'medium')

/** Visible tasks planned for a day (cancelled ones are hidden), ranked. */
export function tasksFor(state: State, day: string): Task[] {
  return rankTasks(state.tasks.filter((t) => t.day === day && !t.cancelled), day)
}

/** Open tasks scheduled exactly on `day`, ranked. */
export function queue(state: State, day: string): Task[] {
  return tasksFor(state, day).filter((t) => !t.done)
}

/**
 * Daily rollover, derived (nothing is rewritten): every open task scheduled today or
 * earlier is actionable today, ranked by the priority engine. Future tasks wait.
 */
export function nowQueue(state: State, today: string): Task[] {
  return rankTasks(state.tasks.filter((t) => !t.done && !t.cancelled && t.day <= today), today)
}

export const isOverdue = (t: Task, today: string) => !t.done && !t.cancelled && t.day < today

/** Local calendar day a task was completed on (falls back to its planned day for old data). */
export const doneDay = (t: Task) => (t.doneAt ? dayKey(new Date(t.doneAt)) : t.day)

/** Tasks completed today, plus today's scheduled tasks that are done. */
export function doneToday(state: State, today: string): Task[] {
  return state.tasks.filter((t) => t.done && !t.cancelled && (doneDay(t) === today || t.day === today)).sort((a, b) => (a.doneAt ?? 0) - (b.doneAt ?? 0))
}

export function progress(state: State, today: string) {
  const done = doneToday(state, today).length
  return { done, total: done + nowQueue(state, today).length }
}

/** Open tasks per day for `today` + the next `n - 1` days. Today's count includes overdue tasks. */
export function weekCounts(state: State, today: string, n = 7): { day: string; open: number; overdue: number }[] {
  return Array.from({ length: n }, (_, i) => {
    const day = addDays(today, i)
    const open = state.tasks.filter((t) => !t.done && !t.cancelled && (i === 0 ? t.day <= day : t.day === day))
    return { day, open: open.length, overdue: open.filter((t) => t.day < today).length }
  })
}

const nextOrder = (tasks: Task[], day: string) =>
  tasks.reduce((max, t) => (t.day === day ? Math.max(max, t.order) : max), 0) + 1

const patchTask = (state: State, id: string, patch: Partial<Task>): State => ({
  ...state,
  tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)),
})

/** Raw state transition. Use `reduce` from the UI; it also tracks revisions. */
export function transition(state: State, action: Action, today: string): State {
  switch (action.type) {
    case 'add': {
      const title = action.title.trim()
      if (!title) return state
      const day = action.day ?? today
      const { id, seq } = action.id ? { id: action.id, seq: state.seq } : nextTaskId(state)
      const task: Task = {
        id,
        title,
        notes: action.notes?.trim() ?? '',
        category: action.category ?? '',
        day,
        order: nextOrder(state.tasks, day),
        done: false,
        createdAt: Date.now(),
      }
      if (action.priority) task.priority = action.priority
      if (action.deadline) task.deadline = action.deadline
      if (action.urgency) task.urgency = action.urgency
      if (action.importance) task.importance = action.importance
      return { ...state, seq, tasks: [...state.tasks, task] }
    }
    case 'import': {
      // Most urgent first: priority, then earliest deadline. Ideas land in the Inbox.
      const sorted = [...action.tasks].sort((a, b) => rank(a.priority) - rank(b.priority) || (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'))
      let next = sorted.reduce((s, t) => transition(s, { type: 'add', ...t }, today), state)
      for (const c of new Set(sorted.map((t) => t.category).filter(isStr))) next = transition(next, { type: 'addCategory', name: c }, today)
      for (const text of [...action.ideas].reverse()) next = transition(next, { type: 'capture', text }, today)
      return next
    }
    case 'complete':
      return patchTask(state, action.id, { done: true, doneAt: Date.now() })
    case 'reopen':
      // Keeps its date: an old task simply shows as overdue again.
      return patchTask(state, action.id, { done: false, doneAt: undefined })
    case 'later': {
      // Last in today's queue until tomorrow; the scheduled date is untouched.
      const task = state.tasks.find((t) => t.id === action.id)
      if (!task) return state
      const last = Math.max(0, ...state.tasks.filter((t) => t.laterOn === today).map((t) => t.laterAt ?? 0))
      return patchTask(state, action.id, { pinnedAt: undefined, laterOn: today, laterAt: Math.max(Date.now(), last + 1) })
    }
    case 'tomorrow':
      return transition(state, { type: 'moveTo', id: action.id, day: addDays(today, 1) }, today)
    case 'moveTo':
      return patchTask(state, action.id, { day: action.day, order: nextOrder(state.tasks, action.day), laterOn: undefined, laterAt: undefined })
    case 'move': {
      // Swap with the neighbour in the ranked list the user sees (today's queue, or that day's list).
      const task = state.tasks.find((t) => t.id === action.id)
      if (!task || task.done || task.cancelled) return state
      const q = task.day <= today ? nowQueue(state, today) : queue(state, task.day)
      const ref = task.day <= today ? today : task.day
      const patch = movePatch(q, q.findIndex((t) => t.id === task.id), action.dir, ref)
      return patch ? patchTask(state, task.id, patch) : state
    }
    case 'toTop': {
      // Pin above everything. A future task is brought to today; an overdue one keeps its date.
      const task = state.tasks.find((t) => t.id === action.id)
      if (!task) return state
      const top = Math.max(Date.now(), ...state.tasks.map((t) => (t.pinnedAt ?? 0) + 1))
      return patchTask(state, action.id, { day: task.day > today ? today : task.day, pinnedAt: top, laterOn: undefined, laterAt: undefined, done: false, doneAt: undefined })
    }
    case 'autoOrder':
      return patchTask(state, action.id, { pinnedAt: undefined, laterOn: undefined, laterAt: undefined, adjust: undefined })
    case 'place': {
      // The engine ranks by score; among equal scores a placed task goes last.
      const task = state.tasks.find((t) => t.id === action.id)
      if (!task || task.done) return state
      return patchTask(state, task.id, { order: nextOrder(state.tasks.filter((t) => t.id !== task.id), task.day) })
    }
    case 'update': {
      const patch = { ...action.patch }
      if (patch.title !== undefined) {
        patch.title = patch.title.trim()
        if (!patch.title) delete patch.title // never allow an empty title
      }
      if (patch.deadline === '') patch.deadline = undefined
      return patchTask(state, action.id, patch)
    }
    case 'remove':
      // Keep a hidden record so ChatGPT updates that mention this ID are recognised, not rejected.
      return patchTask(state, action.id, { cancelled: true })
    case 'capture': {
      const text = action.text.trim()
      if (!text) return state
      return { ...state, thoughts: [{ id: newId(), text, createdAt: Date.now() }, ...state.thoughts] }
    }
    case 'dropThought':
      return { ...state, thoughts: state.thoughts.filter((t) => t.id !== action.id) }
    case 'thoughtToTask': {
      const thought = state.thoughts.find((t) => t.id === action.id)
      if (!thought) return state
      const next = transition(state, { type: 'add', title: thought.text }, today)
      return { ...next, thoughts: next.thoughts.filter((t) => t.id !== action.id) }
    }
    case 'addCategory': {
      const name = action.name.trim()
      if (!name || state.categories.some((c) => c.toLowerCase() === name.toLowerCase())) return state
      return { ...state, categories: [...state.categories, name] }
    }
  }
}

const sameValue = (a: unknown, b: unknown) => (a ?? '') === (b ?? '') || (a === false && b === undefined) || (a === undefined && b === false)

/**
 * Bumps the revision after a change. When the change was made by the user (not a
 * ChatGPT update), records which task fields changed.
 */
export function commit(prev: State, next: State, byUser: boolean): State {
  if (next === prev) return prev
  const rev = prev.rev + 1
  if (!byUser) return { ...next, rev }
  const before = new Map(prev.tasks.map((t) => [t.id, t]))
  const tasks = next.tasks.map((t) => {
    const old = before.get(t.id)
    if (!old) return t
    let userRev = t.userRev
    for (const f of TRACKED) if (!sameValue(old[f], t[f])) userRev = { ...userRev, [f]: rev }
    return userRev === t.userRev ? t : { ...t, userRev }
  })
  return { ...next, tasks, rev }
}

/** Applies a user action and tracks the revision. */
export function reduce(state: State, action: Action, today: string = dayKey()): State {
  return commit(state, transition(state, action, today), true)
}

/** Records an applied ChatGPT update fingerprint (bounded list). */
export const withApplied = (state: State, hash: string): State => ({ ...state, applied: [...state.applied, hash].slice(-MAX_APPLIED) })

// Matches localStorage; declared here so tests can pass an in-memory stand-in.
export type KeyValueStore = { getItem(key: string): string | null; setItem(key: string, value: string): void }

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * Loads saved state, dropping anything unusable instead of crashing.
 * Data from older versions is migrated: tasks without an ID get one, duplicate IDs
 * are made unique, and the original data is backed up once before it's rewritten.
 */
export function load(storage: KeyValueStore): State {
  let data: Record<string, unknown>
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (!raw) return emptyState()
    data = JSON.parse(raw)
    if (typeof data !== 'object' || data === null) return emptyState()
    if (!isNum(data.rev)) {
      try { if (!storage.getItem(BACKUP_KEY)) storage.setItem(BACKUP_KEY, raw) } catch { /* backup is best effort */ }
    }
  } catch {
    return emptyState()
  }

  const state: State = { ...emptyState(), rev: isNum(data.rev) ? data.rev : 0, seq: isNum(data.seq) ? data.seq : 0 }
  state.applied = Array.isArray(data.applied) ? data.applied.filter(isStr).slice(-MAX_APPLIED) : []
  state.categories = Array.isArray(data.categories) ? data.categories.filter(isStr) : [...DEFAULT_CATEGORIES]
  state.thoughts = Array.isArray(data.thoughts) ? data.thoughts.filter((t: Thought) => t && isStr(t.id) && isStr(t.text)) : []

  const seen = new Set<string>()
  const raws: Task[] = Array.isArray(data.tasks) ? data.tasks.filter((t: Task) => t && isStr(t.title) && t.title.trim() && isStr(t.day) && isRealDate(t.day)) : []
  const existingIds = new Set(raws.map((t) => t.id).filter(isStr))
  raws.forEach((t, i) => {
    const task: Task = {
      ...t,
      notes: isStr(t.notes) ? t.notes : '',
      category: isStr(t.category) ? t.category : '',
      order: isNum(t.order) ? t.order : i + 1,
      done: t.done === true,
      createdAt: isNum(t.createdAt) ? t.createdAt : 0,
    }
    if (!isStr(task.id) || !task.id || seen.has(task.id)) {
      const { id, seq } = nextTaskId(state, existingIds)
      task.id = id
      state.seq = seq
    }
    if (!PRIORITIES.includes(task.priority as Priority)) delete task.priority
    for (const k of ['urgency', 'importance'] as const) if (!PRIORITIES.includes(task[k] as Priority)) delete task[k]
    for (const k of ['pinnedAt', 'laterAt', 'adjust'] as const) if (!isNum(task[k]) || task[k] === 0) delete task[k]
    if (!isStr(task.laterOn) || !isRealDate(task.laterOn)) delete task.laterOn
    if (!isStr(task.deadline) || !isRealDate(task.deadline)) delete task.deadline
    if (task.cancelled !== true) delete task.cancelled
    for (const k of ['userRev', 'importRev', 'declined'] as const) if (typeof task[k] !== 'object' || task[k] === null) delete task[k]
    if (!isStr(task.key)) delete task.key
    seen.add(task.id)
    state.tasks.push(task)
  })
  return state
}

/** Returns false if the browser refused to save (e.g. storage full or disabled). */
export function save(storage: KeyValueStore, state: State): boolean {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state))
    return true
  } catch {
    return false
  }
}
