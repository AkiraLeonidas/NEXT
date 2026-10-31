// Full-plan import ("ChatGPT-first" workflow).
//
// ChatGPT sends the complete plan for a day. Each task carries a `key` that ChatGPT keeps
// stable across plans, so NEXT can recognise the same task on later imports without
// ever exporting anything first. NEXT stays the source of truth:
//  - Tasks missing from a plan are never deleted.
//  - Tasks completed or deleted in NEXT stay completed/deleted.
//  - A field changed by hand in NEXT since the last import is never overwritten silently:
//    it becomes a conflict for the user to decide ("Keep mine" is remembered).
//  - Uncertain matches (similar titles) are confirmed in a review.
//  - Validation is all-or-nothing; the same plan pasted twice is a no-op.
//  - An overdue task that the plan keeps "today" keeps its original scheduled date.
//
// Version 2 adds "urgency" and "importance" (ChatGPT's semantic judgement, used by the
// local priority engine). Version 1 plans are still accepted unchanged.

import type { Field, Priority, State, Task } from '../store.ts'
import { PRIORITIES, TRACKED, addDays, commit, isRealDate, nextTaskId, transition, withApplied } from '../store.ts'
import { isSimilar, normalize } from './review.ts'
import { extractJson } from './schema.ts'
import { fingerprint } from './sync.ts'

export const FULL_PLAN_VERSION = 2
export const FULL_PLAN_VERSIONS = [1, 2] as const
export const LIMITS = { tasks: 100, ideas: 50, title: 120, notes: 500, category: 30, idea: 500 }

export type PlanStatus = 'open' | 'done' | 'cancelled'
export type FullPlanTask = {
  key: string
  title: string
  notes: string | null
  priority: Priority
  deadline: string | null
  category: string | null
  when: 'today' | 'tomorrow' | 'later'
  day: string | null // required when "when" is "later"
  status: PlanStatus
  urgency?: Priority // v2: required there
  importance?: Priority // v2: required there
}
export type FullPlan = { next_full_plan: (typeof FULL_PLAN_VERSIONS)[number]; date: string; tasks: FullPlanTask[]; ideas: { text: string }[] }

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })
const DATE = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }
const KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/

/** Strict JSON Schema (also in docs/next-full-plan.schema.json). Every field is required; use null for "none". */
export const FULL_PLAN_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'NEXT full plan v2',
  type: 'object',
  additionalProperties: false,
  required: ['next_full_plan', 'date', 'tasks', 'ideas'],
  properties: {
    next_full_plan: { type: 'integer', enum: [FULL_PLAN_VERSION] },
    date: { ...DATE, description: 'The day this plan is for (normally today)' },
    tasks: {
      type: 'array',
      maxItems: LIMITS.tasks,
      description: 'Suggested working order (NEXT ranks locally; order breaks ties). Keys and titles must be unique.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'title', 'notes', 'priority', 'urgency', 'importance', 'deadline', 'category', 'when', 'day', 'status'],
        properties: {
          key: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,39}$', description: 'Stable ID chosen by ChatGPT; keep it the same for the same task in every plan' },
          title: { type: 'string', minLength: 1, maxLength: LIMITS.title },
          notes: nullable({ type: 'string', maxLength: LIMITS.notes }),
          priority: { type: 'string', enum: PRIORITIES },
          urgency: { type: 'string', enum: PRIORITIES, description: 'How time-critical it is' },
          importance: { type: 'string', enum: PRIORITIES, description: 'How much it matters' },
          deadline: { ...nullable(DATE), description: 'Hard deadline only (a real consequence if missed); otherwise null' },
          category: nullable({ type: 'string', maxLength: LIMITS.category }),
          when: { type: 'string', enum: ['today', 'tomorrow', 'later'], description: 'Flexible scheduled day, not a deadline' },
          day: { ...nullable(DATE), description: 'Required when "when" is "later", otherwise null' },
          status: { type: 'string', enum: ['open', 'done', 'cancelled'] },
        },
      },
    },
    ideas: {
      type: 'array',
      maxItems: LIMITS.ideas,
      items: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: LIMITS.idea } } },
    },
  },
} as const

// ---------- validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const V1_TASK_FIELDS = FULL_PLAN_SCHEMA.properties.tasks.items.required.filter((k) => k !== 'urgency' && k !== 'importance')

export type ParsedPlan = { ok: true; plan: FullPlan; hash: string } | { ok: false; errors: string[] }

export function parseFullPlan(raw: string, today: string): ParsedPlan {
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
  const exact = (obj: Record<string, unknown>, keys: readonly string[], at: string) => {
    for (const k of keys) if (!(k in obj)) errors.push(`${at}: missing "${k}".`)
    for (const k of Object.keys(obj)) if (!keys.includes(k)) errors.push(`${at}: unknown field "${k}".`)
  }
  exact(data, FULL_PLAN_SCHEMA.required, 'Plan')
  const version = data.next_full_plan
  if (!FULL_PLAN_VERSIONS.includes(version as 1 | 2)) errors.push(`next_full_plan must be ${FULL_PLAN_VERSION}.`)
  const taskFields = version === 1 ? V1_TASK_FIELDS : FULL_PLAN_SCHEMA.properties.tasks.items.required
  if (typeof data.date !== 'string' || !isRealDate(data.date)) errors.push('date must be a real date YYYY-MM-DD.')
  else if (data.date < today) errors.push(`This plan is for ${data.date}, which has passed. Ask ChatGPT for today's plan (${today}).`)
  const tasks = Array.isArray(data.tasks) ? data.tasks : (errors.push('tasks must be a list.'), [])
  const ideas = Array.isArray(data.ideas) ? data.ideas : (errors.push('ideas must be a list.'), [])
  if (tasks.length > LIMITS.tasks) errors.push(`At most ${LIMITS.tasks} tasks.`)
  if (ideas.length > LIMITS.ideas) errors.push(`At most ${LIMITS.ideas} ideas.`)

  const keys = new Set<string>()
  const titles = new Set<string>()
  tasks.forEach((t: unknown, i: number) => {
    const at = `Task ${i + 1}`
    if (!isObj(t)) return void errors.push(`${at}: must be an object.`)
    exact(t, taskFields, at)
    const name = typeof t.title === 'string' && t.title.trim() ? `${at} (“${t.title.trim().slice(0, 40)}”)` : at
    const text = (k: string, max: number, nullable: boolean) => {
      const v = t[k]
      if (v === null && nullable) return
      if (typeof v !== 'string' || !v.trim()) errors.push(`${name}: "${k}" must be ${nullable ? 'text or null' : 'non-empty text'}.`)
      else if (v.length > max) errors.push(`${name}: "${k}" is longer than ${max} characters.`)
    }
    if (typeof t.key !== 'string' || !KEY_RE.test(t.key)) errors.push(`${name}: "key" must be lowercase letters, digits and dashes (e.g. "ring-banken").`)
    else if (keys.has(t.key)) errors.push(`${name}: key "${t.key}" is used twice.`)
    else keys.add(t.key)
    text('title', LIMITS.title, false)
    if (typeof t.title === 'string' && t.title.trim()) {
      const n = normalize(t.title)
      if (titles.has(n)) errors.push(`${name}: the same task appears twice.`)
      titles.add(n)
    }
    text('notes', LIMITS.notes, true)
    text('category', LIMITS.category, true)
    for (const k of version === 1 ? ['priority'] : ['priority', 'urgency', 'importance']) {
      if (!PRIORITIES.includes(t[k] as Priority)) errors.push(`${name}: "${k}" must be high, medium or low.`)
    }
    if (t.deadline !== null && !(typeof t.deadline === 'string' && isRealDate(t.deadline))) errors.push(`${name}: "deadline" must be YYYY-MM-DD or null.`)
    if (!['today', 'tomorrow', 'later'].includes(t.when as string)) errors.push(`${name}: "when" must be today, tomorrow or later.`)
    if (t.when === 'later') {
      if (!(typeof t.day === 'string' && isRealDate(t.day))) errors.push(`${name}: "day" (YYYY-MM-DD) is required when "when" is "later".`)
      else if (typeof data.date === 'string' && t.day < data.date) errors.push(`${name}: "day" is before the plan date.`)
    } else if (t.day !== null && t.day !== undefined) errors.push(`${name}: "day" must be null unless "when" is "later".`)
    if (!['open', 'done', 'cancelled'].includes(t.status as string)) errors.push(`${name}: "status" must be open, done or cancelled.`)
  })
  ideas.forEach((idea: unknown, i: number) => {
    const at = `Idea ${i + 1}`
    if (!isObj(idea)) return void errors.push(`${at}: must be an object.`)
    exact(idea, ['text'], at)
    if (typeof idea.text !== 'string' || !idea.text.trim()) errors.push(`${at}: "text" must be non-empty text.`)
    else if (idea.text.length > LIMITS.idea) errors.push(`${at}: "text" is too long.`)
  })

  if (errors.length) return { ok: false, errors }
  return { ok: true, plan: data as FullPlan, hash: fingerprint(`plan:${JSON.stringify(data)}`) }
}

// ---------- reconciliation

export type Review =
  | { kind: 'conflict'; id: string; taskId: string; title: string; field: Field; mine: string; theirs: string }
  | { kind: 'match'; id: string; taskId: string; title: string; existing: string }

/** Decisions by review id: conflicts "mine" (default) | "theirs"; matches "same" (default) | "new". */
export type Decisions = Record<string, 'mine' | 'theirs' | 'same' | 'new'>

export type PlanCounts = { added: number; updated: number; completed: number; cancelled: number; ideas: number; keptDone: number; keptDeleted: number; keptMine: number }
export type ReconcileResult = { ok: true; state: State; review: Review[]; counts: PlanCounts } | { ok: false; errors: string[] }

const EDIT_FIELDS = ['title', 'notes', 'category', 'priority', 'deadline', 'day'] as const
type EditField = (typeof EDIT_FIELDS)[number]
const show = (v: unknown) => (v === undefined || v === '' ? '—' : String(v))

/** Dry-runs (or, with decisions, prepares) a full-plan import. Never mutates the input state. */
export function reconcile(state: State, plan: FullPlan, today: string, decisions: Decisions = {}): ReconcileResult {
  if (plan.date < today) return { ok: false, errors: [`This plan is for ${plan.date}, which has passed.`] }
  const rev = state.rev + 1 // the revision this import will be committed as
  const review: Review[] = []
  const counts: PlanCounts = { added: 0, updated: 0, completed: 0, cancelled: 0, ideas: 0, keptDone: 0, keptDeleted: 0, keptMine: 0 }
  const claimed = new Set<string>()
  const planned: { id: string; day: string }[] = [] // plan order, for re-ordering open tasks
  let s = state

  const set = (id: string, patch: Partial<Task>) => { s = { ...s, tasks: s.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) } }
  const get = (id: string) => s.tasks.find((t) => t.id === id)!
  const dayFor = (t: FullPlanTask) => (t.when === 'today' ? plan.date : t.when === 'tomorrow' ? addDays(plan.date, 1) : t.day!)

  for (const inc of plan.tasks) {
    const title = inc.title.trim()
    const n = normalize(title)
    const free = (t: Task) => !claimed.has(t.id)
    // 1) same key (or a NEXT ID given as key)  2) same title  3) similar title (user confirms)
    let match = s.tasks.find((t) => free(t) && (t.key === inc.key || t.id === inc.key))
    if (!match) match = s.tasks.find((t) => free(t) && normalize(t.title) === n && (!t.cancelled || t.day >= today) && (!t.done || t.day >= today))
    if (!match) {
      const similar = s.tasks.find((t) => free(t) && !t.done && !t.cancelled && isSimilar(t.title, title))
      if (similar) {
        const id = `m:${inc.key}`
        review.push({ kind: 'match', id, taskId: similar.id, title, existing: similar.title })
        if (decisions[id] !== 'new') match = similar
      }
    }

    if (!match) {
      if (inc.status === 'cancelled') continue
      const { id } = nextTaskId(s)
      const day = dayFor(inc)
      s = transition(s, {
        type: 'add', id, title, day, notes: inc.notes ?? undefined, category: inc.category?.trim() || undefined,
        priority: inc.priority, deadline: inc.deadline ?? undefined, urgency: inc.urgency, importance: inc.importance,
      }, today)
      s = { ...s, seq: Math.max(s.seq, Number(id.slice(1)) || s.seq) }
      if (inc.category?.trim()) s = transition(s, { type: 'addCategory', name: inc.category }, today)
      const stamp = Object.fromEntries(TRACKED.map((f) => [f, rev]))
      set(id, { key: inc.key, importRev: stamp })
      if (inc.status === 'done') s = transition(s, { type: 'complete', id }, today)
      claimed.add(id)
      planned.push({ id, day })
      counts.added++
      continue
    }

    claimed.add(match.id)
    set(match.id, { key: inc.key })
    const t = get(match.id)
    if (t.cancelled) { counts.keptDeleted++; continue } // deleted in NEXT stays deleted
    if (t.done) { if (inc.status !== 'done') counts.keptDone++; continue } // completed stays completed, untouched

    const changedByUser = (f: Field) => (t.userRev?.[f] ?? 0) > (t.importRev?.[f] ?? 0)
    const importRev = { ...t.importRev }
    const declined = { ...t.declined }
    const patch: Partial<Task> = {}
    let changed = false

    // Decide one field: apply ChatGPT's value, keep the user's, or ask.
    const decide = (f: Field, mine: unknown, theirs: unknown, apply: () => void) => {
      if ((mine ?? '') === (theirs ?? '')) { importRev[f] = rev; delete declined[f]; return }
      if (changedByUser(f)) {
        const id = `c:${inc.key}:${f}`
        const sig = JSON.stringify(theirs ?? null)
        if (declined[f] === sig && !decisions[id]) { counts.keptMine++; return } // already answered "Keep mine" for this value
        review.push({ kind: 'conflict', id, taskId: t.id, title: t.title, field: f, mine: show(mine), theirs: show(theirs) })
        if (decisions[id] !== 'theirs') { declined[f] = sig; counts.keptMine++; return }
      }
      apply()
      importRev[f] = rev
      delete declined[f]
      changed = true
    }

    // "today" for a task that is already overdue means "still actionable": keep its original date.
    const day = t.day < today && dayFor(inc) === today ? t.day : dayFor(inc)
    const theirs: Record<EditField, string | undefined> = {
      title, notes: inc.notes?.trim() ?? '', category: inc.category?.trim() ?? '',
      priority: inc.priority, deadline: inc.deadline ?? undefined, day,
    }
    // A task ChatGPT cancels only gets the single "cancel?" decision, not field-by-field ones.
    if (inc.status !== 'cancelled') {
      for (const f of EDIT_FIELDS) {
        decide(f, t[f], theirs[f], () => { (patch as Record<string, unknown>)[f] = theirs[f] })
      }
    }
    if (patch.category) s = transition(s, { type: 'addCategory', name: patch.category }, today)
    // Semantic hints (v2) can't be edited in NEXT, so they never conflict.
    if (inc.status !== 'cancelled') {
      for (const f of ['urgency', 'importance'] as const) {
        if (inc[f] && inc[f] !== t[f]) { patch[f] = inc[f]; changed = true }
      }
    }

    let complete = false
    let cancel = false
    if (inc.status === 'done') decide('done', false, true, () => { complete = true })
    if (inc.status === 'cancelled') {
      const touched = TRACKED.some((f) => changedByUser(f))
      const id = `c:${inc.key}:cancelled`
      if (touched && decisions[id] !== 'theirs') {
        review.push({ kind: 'conflict', id, taskId: t.id, title: t.title, field: 'cancelled', mine: 'keep (you edited it)', theirs: 'cancel' })
        counts.keptMine++
      } else cancel = true
    }

    set(t.id, { ...patch, importRev, declined: Object.keys(declined).length ? declined : undefined })
    if ('day' in patch) set(t.id, { order: Number.MAX_SAFE_INTEGER })
    if (complete) { s = transition(s, { type: 'complete', id: t.id }, today); counts.completed++ }
    else if (cancel) { s = transition(s, { type: 'remove', id: t.id }, today); counts.cancelled++ }
    else if (changed) counts.updated++
    planned.push({ id: t.id, day: get(t.id).day })
  }

  // Ideas: add new ones, never remove existing.
  for (const idea of [...plan.ideas].reverse()) {
    if (s.thoughts.some((th) => normalize(th.text) === normalize(idea.text))) continue
    s = transition(s, { type: 'capture', text: idea.text }, today)
    counts.ideas++
  }

  // Order: open plan tasks in plan order, then the day's other open tasks in their existing order.
  for (const day of new Set(planned.map((p) => p.day))) {
    const fromPlan = planned.filter((p) => p.day === day).map((p) => get(p.id)).filter((t) => t.day === day && !t.done && !t.cancelled)
    const ids = new Set(fromPlan.map((t) => t.id))
    const rest = s.tasks.filter((t) => t.day === day && !t.done && !t.cancelled && !ids.has(t.id)).sort((a, b) => a.order - b.order)
    ;[...fromPlan, ...rest].forEach((t, i) => set(t.id, { order: i + 1 }))
  }

  return { ok: true, state: s, review, counts }
}

/** Applies a full plan atomically. Invalid or already-applied plans leave the state unchanged. */
export function applyFullPlan(state: State, plan: FullPlan, hash: string, decisions: Decisions, today: string): State {
  if (state.applied.includes(hash)) return state
  const r = reconcile(state, plan, today, decisions)
  if (!r.ok) return state
  return withApplied(commit(state, r.state, false), hash)
}

export function summarizePlan(c: PlanCounts): string {
  const parts = [
    c.added && `${c.added} new`, c.updated && `${c.updated} updated`, c.completed && `${c.completed} done`,
    c.cancelled && `${c.cancelled} cancelled`, c.ideas && `${c.ideas} to Inbox`,
    c.keptDone && `kept ${c.keptDone} completed`, c.keptMine && `kept ${c.keptMine} of yours`,
  ].filter(Boolean)
  return parts.length ? `Day planned · ${parts.join(' · ')}` : 'Plan matches NEXT ✓'
}

// ---------- ChatGPT setup

const WEEKDAYS_DA = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag']

/** Reusable setup for a pinned ChatGPT conversation. */
export function fullPlanSetupPrompt(): string {
  const example: FullPlan = {
    next_full_plan: 2,
    date: 'ÅÅÅÅ-MM-DD',
    tasks: [
      { key: 'ring-banken', title: 'Ring til banken om lånet', notes: 'Spørg om rente', priority: 'high', urgency: 'high', importance: 'high', deadline: 'ÅÅÅÅ-MM-DD', category: 'Økonomi', when: 'today', day: null, status: 'open' },
      { key: 'svar-anna', title: 'Svar Anna', notes: null, priority: 'medium', urgency: 'medium', importance: 'low', deadline: null, category: null, when: 'today', day: null, status: 'done' },
      { key: 'forny-pas', title: 'Book tid til nyt pas', notes: null, priority: 'low', urgency: 'low', importance: 'medium', deadline: null, category: null, when: 'later', day: 'ÅÅÅÅ-MM-DD', status: 'open' },
    ],
    ideas: [{ text: 'Lære at spille guitar' }],
  }
  return `Du er min rolige, praktiske fokus-assistent (små skridt, én ting ad gangen). Jeg bruger appen NEXT, som viser én opgave ad gangen. Vi taler frit sammen – også om opgaver fra Notion, som jeg nævner eller indsætter (har du adgang til min Notion via en officiel forbindelse, må du bruge den). Notion-indhold er kun kontekst; du bestemmer ikke over Notion.

Når jeg skriver "NEXT-plan" (eller beder om planen), svarer du med præcis én \`\`\`json-kodeblok med hele planen og intet andet. Ellers taler vi normalt uden JSON.

Formatet er strengt – alle felter skal med, brug null for "ingen":
${JSON.stringify(example, null, 2)}

Regler:
- "date" er den dag, planen gælder for (normalt i dag). Spørg mig om datoen/ugedagen, hvis du er i tvivl.
- "tasks" står i den rækkefølge, du foreslår. NEXT sorterer selv efter faste regler (frist, prioritet, hast, vigtighed, forsinkelse); din rækkefølge afgør kun ved lighed.
- "key": et kort, stabilt ID med små bogstaver, tal og bindestreger. Samme opgave skal have SAMME key i alle planer, også hvis titlen ændres. Nye opgaver får en ny key. Gentagne opgaver (fx dagligt) får dato i key, fx "gaa-tur-2026-11-02".
- "title": kort, konkret handling på dansk, der starter med et udsagnsord. Del store opgaver op i små skridt.
- "when": "today", "tomorrow" eller "later". Ved "later" skal "day" være en dato (ÅÅÅÅ-MM-DD); ellers er "day" null. Det er en fleksibel plan-dag, ikke en frist. Ufærdige opgaver fra tidligere dage bliver automatisk stående i NEXT; giv dem "today".
- "deadline": KUN en hård frist med en reel konsekvens (fx betalingsfrist). Ellers null.
- "urgency" (hvor tidskritisk) og "importance" (hvor meget det betyder): "high", "medium" eller "low". Vurder dem ud fra det, jeg fortæller – gæt ikke "high".
- "status": "open"; "done" når jeg har sagt, at det er gjort; "cancelled" kun når jeg tydeligt siger, at noget ikke skal gøres.
- Tag alle opgaver med, der stadig er relevante – også dem fra tidligere planer. Opgaver, du udelader, bliver ikke slettet i NEXT, men tag dem med for overblikkets skyld.
- Opfind aldrig opgaver, datoer eller at noget er gjort. NEXT har ingen påmindelser, notifikationer eller synkronisering.
- "priority": "high" kun ved tydelig hast eller konsekvens, ellers "medium" eller "low".
- Vage ønsker og "måske engang" kommer i "ideas".
- Ingen dubletter: hver opgave og hver key må kun optræde én gang.

Svar nu kun: "Klar. Fortæl mig om din dag – skriv 'NEXT-plan', når du vil have planen."`
}

export const weekdayDa = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return WEEKDAYS_DA[new Date(y, m - 1, d).getDay()]
}
