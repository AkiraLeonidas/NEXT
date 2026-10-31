// Pure task logic + persistence. No React here, so it can be tested with `node --test`.

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
  day: string // YYYY-MM-DD the task is planned for
  order: number // position within its day
  done: boolean
  cancelled?: boolean // cancelled or deleted: hidden, but kept so its ID stays known
  createdAt: number
  doneAt?: number
  userRev?: Partial<Record<Field, number>> // state revision of the last manual change per field
  key?: string // ChatGPT's stable key for this task (full-plan imports)
  importRev?: Partial<Record<Field, number>> // revision at which a full-plan import last set/confirmed each field
  declined?: Partial<Record<Field, string>> // ChatGPT values the user rejected ("Keep mine"), so they don't ask again
}

export type Thought = { id: string; text: string; createdAt: number }

/** A task ready to be added, e.g. from a reviewed AI import. */
export type NewTask = { title: string; notes?: string; category?: string; priority?: Priority; deadline?: string; day?: string; id?: string }

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
  | { type: 'remove'; id: string }
  | { type: 'capture'; text: string }
  | { type: 'dropThought'; id: string }
  | { type: 'thoughtToTask'; id: string }
  | { type: 'addCategory'; name: string }
  | { type: 'rollover' }

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

const byOrder = (a: Task, b: Task) => a.order - b.order
const rank = (p?: Priority) => PRIORITIES.indexOf(p ?? 'medium')

/** Visible tasks planned for a day (cancelled ones are hidden). */
export function tasksFor(state: State, day: string): Task[] {
  return state.tasks.filter((t) => t.day === day && !t.cancelled).sort(byOrder)
}

/** Open tasks for the day, in the order they should be worked on. */
export function queue(state: State, day: string): Task[] {
  return tasksFor(state, day).filter((t) => !t.done)
}

export function progress(state: State, day: string) {
  const all = tasksFor(state, day)
  return { done: all.filter((t) => t.done).length, total: all.length }
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
      return patchTask(state, action.id, { done: false, doneAt: undefined, day: today, order: nextOrder(state.tasks, today) })
    case 'later': {
      const task = state.tasks.find((t) => t.id === action.id)
      if (!task) return state
      return patchTask(state, action.id, { order: nextOrder(state.tasks, task.day) })
    }
    case 'tomorrow':
      return transition(state, { type: 'moveTo', id: action.id, day: addDays(today, 1) }, today)
    case 'moveTo':
      return patchTask(state, action.id, { day: action.day, order: nextOrder(state.tasks, action.day) })
    case 'move': {
      const task = state.tasks.find((t) => t.id === action.id)
      if (!task || task.done) return state
      const q = queue(state, task.day)
      const i = q.findIndex((t) => t.id === task.id)
      const other = q[i + action.dir]
      if (!other) return state
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === task.id ? { ...t, order: other.order } : t.id === other.id ? { ...t, order: task.order } : t,
        ),
      }
    }
    case 'toTop': {
      const task = state.tasks.find((t) => t.id === action.id)
      if (!task) return state
      const min = Math.min(...tasksFor(state, today).map((t) => t.order), 1)
      return patchTask(state, action.id, { day: today, order: min - 1, done: false, doneAt: undefined })
    }
    case 'place': {
      // After every open task of the same or higher priority, before the first lower one.
      const task = state.tasks.find((t) => t.id === action.id)
      if (!task || task.done) return state
      const others = queue(state, task.day).filter((t) => t.id !== task.id)
      const i = others.findIndex((t) => rank(t.priority) > rank(task.priority))
      if (i < 0) return patchTask(state, task.id, { order: Math.max(0, ...others.map((t) => t.order)) + 1 })
      const before = i > 0 ? others[i - 1].order : others[i].order - 1
      return patchTask(state, task.id, { order: (before + others[i].order) / 2 })
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
    case 'rollover': {
      // Unfinished tasks from past days move to the end of today, keeping their relative order.
      const stale = state.tasks.filter((t) => !t.done && !t.cancelled && t.day < today).sort((a, b) => a.day.localeCompare(b.day) || byOrder(a, b))
      if (!stale.length) return state
      let order = nextOrder(state.tasks, today)
      const moved = new Map(stale.map((t) => [t.id, order++]))
      return {
        ...state,
        tasks: state.tasks.map((t) => (moved.has(t.id) ? { ...t, day: today, order: moved.get(t.id)! } : t)),
      }
    }
  }
}

const sameValue = (a: unknown, b: unknown) => (a ?? '') === (b ?? '') || (a === false && b === undefined) || (a === undefined && b === false)

/**
 * Bumps the revision after a change. When the change was made by the user (not a
 * ChatGPT update or the automatic day rollover), records which task fields changed.
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
  return commit(state, transition(state, action, today), action.type !== 'rollover')
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
