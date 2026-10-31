// NEXT ⇄ ChatGPT sync (protocol v2).
//
// NEXT is the source of truth. ChatGPT only ever sends *operations* that target
// stable task IDs, based on a plan snapshot ("NEXT-PLAN") the user copied earlier.
//
// Safety rules:
//  - An update is validated completely first; if anything is wrong, nothing changes.
//  - Tasks missing from an update are never touched. Completed tasks are never undone or moved.
//  - Pasting the same update twice is a no-op (fingerprint check).
//  - A field the user changed manually *after* the plan was copied is a conflict:
//    the user decides (default: keep theirs). Changes ChatGPT made itself never conflict.

import type { Field, Priority, State, Task } from '../store.ts'
import { PRIORITIES, TRACKED, addDays, commit, doneDay, isRealDate, nowQueue, transition, withApplied } from '../store.ts'
import { normalize } from './review.ts'
import { extractJson } from './schema.ts'

export const UPDATE_VERSION = 2
export const MAX_OPS = 100

type Nullable<T> = T | null

export type AddTaskOp = {
  op: 'add_task'; id: string; title: string
  notes?: Nullable<string>; priority?: Nullable<Priority>; deadline?: Nullable<string>; category?: Nullable<string>
  when?: string // today | tomorrow | YYYY-MM-DD
  first?: boolean
}
export type UpdateTaskOp = {
  op: 'update_task'; id: string
  title?: string; notes?: Nullable<string>; priority?: Nullable<Priority>; deadline?: Nullable<string>; category?: Nullable<string>
  first?: boolean
}
export type CompleteTaskOp = { op: 'complete_task'; id: string }
export type PostponeTaskOp = { op: 'postpone_task'; id: string; to: string } // later_today | tomorrow | YYYY-MM-DD
export type CancelTaskOp = { op: 'cancel_task'; id: string }
export type AddIdeaOp = { op: 'add_idea'; text: string }
export type UpdateOp = AddTaskOp | UpdateTaskOp | CompleteTaskOp | PostponeTaskOp | CancelTaskOp | AddIdeaOp

export type UpdatePayload = { next_update: typeof UPDATE_VERSION; base_rev: number; summary?: string; ops: UpdateOp[] }

// ---------- structural validation

const OP_FIELDS: Record<UpdateOp['op'], { required: string[]; optional: string[] }> = {
  add_task: { required: ['op', 'id', 'title'], optional: ['notes', 'priority', 'deadline', 'category', 'when', 'first'] },
  update_task: { required: ['op', 'id'], optional: ['title', 'notes', 'priority', 'deadline', 'category', 'first'] },
  complete_task: { required: ['op', 'id'], optional: [] },
  postpone_task: { required: ['op', 'id', 'to'], optional: [] },
  cancel_task: { required: ['op', 'id'], optional: [] },
  add_idea: { required: ['op', 'text'], optional: [] },
}
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export type Kind = 'fullplan' | 'update' | 'dump' | 'plan' | 'none'

/** What kind of JSON the user pasted: a full plan, a v2 update, a v1 brain dump answer, NEXT's own snapshot, or nothing usable. */
export function detectKind(raw: string): Kind {
  const json = extractJson(raw)
  if (!json) return 'none'
  try {
    const data = JSON.parse(json)
    if (!isObj(data)) return 'none'
    if ('next_full_plan' in data) return 'fullplan'
    if ('next_update' in data) return 'update'
    if ('next_plan' in data) return 'plan'
    if ('version' in data && ('tasks' in data || 'ideas' in data)) return 'dump'
  } catch { /* fall through */ }
  return 'none'
}

/** Short, stable fingerprint of an update (FNV-1a), used to ignore repeated pastes. */
export function fingerprint(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `u${(h >>> 0).toString(36)}${text.length.toString(36)}`
}

export type ParsedUpdate = { ok: true; update: UpdatePayload; hash: string } | { ok: false; errors: string[] }

export function parseUpdate(raw: string): ParsedUpdate {
  const json = extractJson(raw)
  if (!json) return { ok: false, errors: ['No JSON found.'] }
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON (${(e as Error).message}).`] }
  }
  if (!isObj(data)) return { ok: false, errors: ['Top level must be a JSON object.'] }
  const errors: string[] = []
  for (const k of Object.keys(data)) if (!['next_update', 'base_rev', 'summary', 'ops'].includes(k)) errors.push(`Unknown field "${k}".`)
  if (data.next_update !== UPDATE_VERSION) errors.push(`next_update must be ${UPDATE_VERSION}.`)
  if (!Number.isInteger(data.base_rev) || (data.base_rev as number) < 0) errors.push('base_rev must be the "rev" number from the NEXT plan.')
  if ('summary' in data && (typeof data.summary !== 'string' || data.summary.length > 300)) errors.push('summary must be short text.')
  if (!Array.isArray(data.ops) || !data.ops.length) errors.push('ops must be a non-empty list.')
  else if (data.ops.length > MAX_OPS) errors.push(`At most ${MAX_OPS} operations per update.`)

  const ops = Array.isArray(data.ops) ? data.ops : []
  ops.forEach((op: unknown, i: number) => {
    const at = `Step ${i + 1}`
    if (!isObj(op) || typeof op.op !== 'string' || !(op.op in OP_FIELDS)) {
      errors.push(`${at}: unknown operation${isObj(op) && typeof op.op === 'string' ? ` "${op.op}"` : ''}.`)
      return
    }
    const spec = OP_FIELDS[op.op as UpdateOp['op']]
    const name = `${at} (${op.op})`
    for (const k of spec.required) if (!(k in op)) errors.push(`${name}: missing "${k}".`)
    for (const k of Object.keys(op)) if (!spec.required.includes(k) && !spec.optional.includes(k)) errors.push(`${name}: unknown field "${k}".`)

    const text = (k: string, max: number, nullable: boolean) => {
      if (!(k in op)) return
      const v = op[k]
      if (v === null && nullable) return
      if (typeof v !== 'string' || (!nullable && !v.trim())) errors.push(`${name}: "${k}" must be ${nullable ? 'text or null' : 'non-empty text'}.`)
      else if (v.length > max) errors.push(`${name}: "${k}" is longer than ${max} characters.`)
    }
    if ('id' in op && (typeof op.id !== 'string' || !ID_RE.test(op.id))) errors.push(`${name}: "id" must be a short ID like t3 or c12-1.`)
    if (op.op === 'add_task' && typeof op.id === 'string' && !/^c/.test(op.id)) errors.push(`${name}: new task IDs must start with "c" (use new_id_prefix from the plan).`)
    text('title', 120, false)
    text('notes', 500, true)
    text('category', 30, true)
    text('text', 500, false)
    if ('priority' in op && op.priority !== null && !PRIORITIES.includes(op.priority as Priority)) errors.push(`${name}: "priority" must be high, medium, low or null.`)
    if ('deadline' in op && op.deadline !== null && !(typeof op.deadline === 'string' && isRealDate(op.deadline))) errors.push(`${name}: "deadline" must be a real date YYYY-MM-DD or null.`)
    if ('when' in op && !(op.when === 'today' || op.when === 'tomorrow' || (typeof op.when === 'string' && isRealDate(op.when)))) errors.push(`${name}: "when" must be today, tomorrow or YYYY-MM-DD.`)
    if ('to' in op && !(op.to === 'later_today' || op.to === 'tomorrow' || (typeof op.to === 'string' && isRealDate(op.to)))) errors.push(`${name}: "to" must be later_today, tomorrow or YYYY-MM-DD.`)
    if ('first' in op && typeof op.first !== 'boolean') errors.push(`${name}: "first" must be true or false.`)
    if (op.op === 'update_task' && !Object.keys(op).some((k) => spec.optional.includes(k))) errors.push(`${name}: nothing to change.`)
  })

  if (errors.length) return { ok: false, errors }
  return { ok: true, update: data as UpdatePayload, hash: fingerprint(JSON.stringify(data)) }
}

// ---------- merging against the current state

export type Conflict = { key: string; taskId: string; title: string; field: Field; mine: string; theirs: string }
export type Skip = { title: string; reason: string }
export type Counts = { added: number; updated: number; completed: number; postponed: number; cancelled: number; ideas: number }
export type ExecResult =
  | { ok: true; state: State; conflicts: Conflict[]; skipped: Skip[]; counts: Counts }
  | { ok: false; errors: string[] }

const EDITABLE = ['title', 'notes', 'category', 'priority', 'deadline'] as const
type Editable = (typeof EDITABLE)[number]

/** ChatGPT's value in NEXT's representation (null clears). */
const incoming = (f: Editable, v: unknown): string | undefined => {
  if (v === null) return f === 'priority' || f === 'deadline' ? undefined : ''
  return typeof v === 'string' ? v.trim() : undefined
}
const same = (a: unknown, b: unknown) => (a ?? '') === (b ?? '')
const show = (v: unknown) => (v === undefined || v === '' ? '—' : String(v))

/**
 * Runs an update against the state without side effects. Conflicts whose key is in
 * `accept` take ChatGPT's value; all other conflicts keep the user's value.
 */
export function execute(state: State, u: UpdatePayload, today: string, accept: Set<string> = new Set()): ExecResult {
  const errors: string[] = []
  const conflicts: Conflict[] = []
  const skipped: Skip[] = []
  const counts: Counts = { added: 0, updated: 0, completed: 0, postponed: 0, cancelled: 0, ideas: 0 }
  if (u.base_rev > state.rev) {
    return { ok: false, errors: [`This update is based on plan rev ${u.base_rev}, but this device is at rev ${state.rev}. Copy a fresh plan for ChatGPT.`] }
  }
  const tomorrow = addDays(today, 1)
  const changedByUser = (t: Task, f: Field) => (t.userRev?.[f] ?? 0) > u.base_rev
  let s = state

  u.ops.forEach((op, i) => {
    const name = `Step ${i + 1} (${op.op})`
    const key = (f: Field) => `${i}:${f}`
    const task = 'id' in op ? s.tasks.find((t) => t.id === op.id) : undefined
    if (op.op !== 'add_task' && op.op !== 'add_idea' && !task) {
      errors.push(`${name}: unknown task ID "${op.id}". Copy a fresh plan for ChatGPT.`)
      return
    }

    switch (op.op) {
      case 'add_task': {
        if (task) {
          if (normalize(task.title) === normalize(op.title)) skipped.push({ title: op.title, reason: 'already added' })
          else errors.push(`${name}: ID "${op.id}" is already used by “${task.title}”.`)
          return
        }
        const day = op.when === 'tomorrow' ? tomorrow : !op.when || op.when === 'today' ? today : op.when
        if (day < today) return void errors.push(`${name}: "when" is in the past.`)
        const dup = s.tasks.find((t) => !t.cancelled && !t.done && normalize(t.title) === normalize(op.title))
        if (dup) return void skipped.push({ title: op.title, reason: 'already on your list' })
        s = transition(s, {
          type: 'add', id: op.id, title: op.title, day,
          notes: op.notes ?? undefined, category: op.category?.trim() || undefined,
          priority: op.priority ?? undefined, deadline: op.deadline ?? undefined,
        }, today)
        if (op.category?.trim()) s = transition(s, { type: 'addCategory', name: op.category }, today)
        s = transition(s, op.first && day === today ? { type: 'toTop', id: op.id } : { type: 'place', id: op.id }, today)
        counts.added++
        return
      }
      case 'update_task': {
        const t = task!
        if (t.cancelled) return void skipped.push({ title: t.title, reason: 'deleted in NEXT' })
        const patch: Partial<Record<Editable, string | undefined>> = {}
        for (const f of EDITABLE) {
          if (!(f in op)) continue
          const theirs = incoming(f, op[f])
          if (same(t[f], theirs)) continue
          if (changedByUser(t, f) && !accept.has(key(f))) {
            conflicts.push({ key: key(f), taskId: t.id, title: t.title, field: f, mine: show(t[f]), theirs: show(theirs) })
            continue
          }
          patch[f] = theirs
        }
        let changed = Object.keys(patch).length > 0
        if (changed) {
          s = transition(s, { type: 'update', id: t.id, patch: patch as Partial<Pick<Task, Editable>> }, today)
          if ('priority' in patch && !op.first) s = transition(s, { type: 'place', id: t.id }, today)
        }
        if (op.first && !t.done) {
          s = transition(s, { type: 'toTop', id: t.id }, today)
          changed = true
        }
        if (changed) counts.updated++
        return
      }
      case 'complete_task': {
        const t = task!
        if (t.cancelled) return void skipped.push({ title: t.title, reason: 'deleted in NEXT' })
        if (t.done) return
        if (changedByUser(t, 'done') && !accept.has(key('done'))) {
          conflicts.push({ key: key('done'), taskId: t.id, title: t.title, field: 'done', mine: 'not done (you reopened it)', theirs: 'done' })
          return
        }
        s = transition(s, { type: 'complete', id: t.id }, today)
        counts.completed++
        return
      }
      case 'postpone_task': {
        const t = task!
        if (t.cancelled) return void skipped.push({ title: t.title, reason: 'deleted in NEXT' })
        if (t.done) return void skipped.push({ title: t.title, reason: 'already done' })
        const day = op.to === 'later_today' ? today : op.to === 'tomorrow' ? tomorrow : op.to
        if (day < today) return void errors.push(`${name}: "to" is in the past.`)
        if (day !== t.day && changedByUser(t, 'day') && !accept.has(key('day'))) {
          conflicts.push({ key: key('day'), taskId: t.id, title: t.title, field: 'day', mine: show(t.day), theirs: day })
          return
        }
        s = transition(s, day === t.day ? { type: 'later', id: t.id } : { type: 'moveTo', id: t.id, day }, today)
        counts.postponed++
        return
      }
      case 'cancel_task': {
        const t = task!
        if (t.cancelled) return
        if (t.done) return void skipped.push({ title: t.title, reason: 'already done, kept' })
        if (TRACKED.some((f) => changedByUser(t, f)) && !accept.has(key('cancelled'))) {
          conflicts.push({ key: key('cancelled'), taskId: t.id, title: t.title, field: 'cancelled', mine: 'keep (you edited it)', theirs: 'cancel' })
          return
        }
        s = transition(s, { type: 'remove', id: t.id }, today)
        counts.cancelled++
        return
      }
      case 'add_idea': {
        if (s.thoughts.some((th) => normalize(th.text) === normalize(op.text))) return void skipped.push({ title: op.text, reason: 'already in Inbox' })
        s = transition(s, { type: 'capture', text: op.text }, today)
        counts.ideas++
        return
      }
    }
  })

  if (errors.length) return { ok: false, errors }
  return { ok: true, state: s, conflicts, skipped, counts }
}

/** Applies an update atomically. Invalid or already-applied updates leave the state unchanged. */
export function applyUpdate(state: State, u: UpdatePayload, hash: string, accept: Set<string>, today: string): State {
  if (state.applied.includes(hash)) return state
  const r = execute(state, u, today, accept)
  if (!r.ok) return state
  return withApplied(commit(state, r.state, false), hash)
}

/** "2 new · 1 done · 1 moved" */
export function summarize(c: Counts, skipped: number, kept: number): string {
  const parts = [
    c.added && `${c.added} new`, c.updated && `${c.updated} updated`, c.completed && `${c.completed} done`,
    c.postponed && `${c.postponed} moved`, c.cancelled && `${c.cancelled} cancelled`, c.ideas && `${c.ideas} to Inbox`,
    kept && `${kept} kept yours`, skipped && `${skipped} skipped`,
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Nothing new'
}

// ---------- plan export and ChatGPT setup

const WEEKDAYS_DA = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag']

export type PlanTask = {
  id: string; title: string; when: 'today' | 'tomorrow' | 'later'; day?: string
  priority?: Priority; deadline?: string; category?: string; notes?: string; done?: true
  overdue_since?: string // still actionable today; originally scheduled for this day
}
export type Plan = {
  next_plan: typeof UPDATE_VERSION; rev: number; date: string; weekday: string; new_id_prefix: string
  tasks: PlanTask[]; ideas: string[]
}

/** Compact snapshot for ChatGPT: today's queue in order (incl. overdue), today's done tasks, then upcoming. */
export function buildPlan(state: State, today: string): Plan {
  const tomorrow = addDays(today, 1)
  const now = nowQueue(state, today)
  const done = state.tasks.filter((t) => !t.cancelled && t.done && (t.day === today || doneDay(t) === today))
  const upcoming = state.tasks.filter((t) => !t.cancelled && !t.done && t.day > today).sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order)
  const visible = [...now, ...done, ...upcoming]
  const [y, m, d] = today.split('-').map(Number)
  return {
    next_plan: UPDATE_VERSION,
    rev: state.rev,
    date: today,
    weekday: WEEKDAYS_DA[new Date(y, m - 1, d).getDay()],
    new_id_prefix: `c${state.rev}-`,
    tasks: visible.map((t) => {
      const when = t.day <= today || t.done ? 'today' : t.day === tomorrow ? 'tomorrow' : 'later'
      const p: PlanTask = { id: t.id, title: t.title, when }
      if (!t.done && t.day < today) p.overdue_since = t.day
      if (when === 'later') p.day = t.day
      if (t.priority) p.priority = t.priority
      if (t.deadline) p.deadline = t.deadline
      if (t.category) p.category = t.category
      if (t.notes) p.notes = t.notes.length > 100 ? `${t.notes.slice(0, 99)}…` : t.notes
      if (t.done) p.done = true
      return p
    }),
    ideas: state.thoughts.slice(0, 20).map((t) => t.text),
  }
}

export function planText(state: State, today: string): string {
  const plan = buildPlan(state, today)
  return `NEXT-PLAN rev ${plan.rev}. Brug base_rev ${plan.rev} og nye ID'er ${plan.new_id_prefix}1, ${plan.new_id_prefix}2 … i dine NEXT-opdateringer.\n${JSON.stringify(plan)}`
}

/** One-time instructions for the user's pinned ChatGPT conversation. */
export function setupPrompt(): string {
  return `Du er min rolige, praktiske fokus-assistent (små skridt, én ting ad gangen) og arbejder sammen med min app NEXT. NEXT er sandheden om mine opgaver. Du ændrer dem kun via JSON-opdateringer, som jeg kopierer ind i NEXT.

Sådan arbejder vi:
1. Jeg indsætter en NEXT-PLAN (JSON med "next_plan"). Den viser mine opgaver med faste ID'er, dagens dato og "rev".
2. Når jeg fortæller dig noget (tale, tanker, status), svarer du med højst én kort linje på dansk om, hvad du ændrer, og derefter præcis én \`\`\`json-kodeblok med en NEXT-opdatering.
3. Jeg kopierer kodeblokken ind i NEXT.

NEXT-opdatering:
{"next_update":2,"base_rev":<rev fra seneste NEXT-PLAN>,"summary":"<valgfri, kort>","ops":[...]}

Operationer (kun ændringer – udelad alt, der ikke ændres):
- {"op":"add_task","id":"<new_id_prefix><nr>","title":"Ring til tandlægen","priority":"high|medium|low","deadline":"ÅÅÅÅ-MM-DD" eller null,"category":"…" eller null,"notes":"…" eller null,"when":"today|tomorrow|ÅÅÅÅ-MM-DD","first":false}
- {"op":"update_task","id":"<id>"} + kun de felter, der ændres: title, notes, priority, deadline, category, first
- {"op":"complete_task","id":"<id>"}
- {"op":"postpone_task","id":"<id>","to":"later_today|tomorrow|ÅÅÅÅ-MM-DD"}
- {"op":"cancel_task","id":"<id>"}
- {"op":"add_idea","text":"…"}

Regler:
- Brug kun ID'er fra den seneste NEXT-PLAN eller ID'er, du selv har oprettet i denne samtale. Opfind aldrig andre.
- Nye opgaver får ID = new_id_prefix + løbenummer (fx c42-1, c42-2). Fortsæt nummereringen i senere svar, og genbrug aldrig et ID.
- base_rev er altid "rev" fra den seneste NEXT-PLAN, jeg har indsat – også ved flere opdateringer i træk.
- Slet aldrig opgaver, bare fordi de ikke nævnes. Brug cancel_task kun, når jeg tydeligt siger, at noget ikke skal gøres.
- Opgavetitler er korte, konkrete handlinger på dansk, der starter med et udsagnsord. Del store opgaver op i små skridt.
- Vage ønsker og "måske engang" bliver til add_idea.
- "first": true kun når jeg siger, at noget skal gøres nu eller først.
- priority "high" kun ved tydelig hast eller konsekvens.
- Datoer skrives ÅÅÅÅ-MM-DD ud fra "date" og "weekday" i NEXT-PLAN.
- Er du i tvivl om, hvilken opgave jeg mener, så spørg kort i stedet for at gætte (uden JSON).

Svar nu kun: "Klar. Indsæt din NEXT-PLAN."`
}
