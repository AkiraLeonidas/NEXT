import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { UpdateOp, UpdatePayload } from '../src/ai/sync.ts'
import { applyUpdate, buildPlan, detectKind, execute, parseUpdate, planText, setupPrompt, summarize } from '../src/ai/sync.ts'
import type { KeyValueStore, State } from '../src/store.ts'
import { BACKUP_KEY, STORAGE_KEY, emptyState, load, progress, queue, reduce, save } from '../src/store.ts'

const TODAY = '2026-10-31'
const TOMORROW = '2026-11-01'

const memory = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}
const upd = (base_rev: number, ops: UpdateOp[]): UpdatePayload => ({ next_update: 2, base_rev, ops })
/** Paste exactly like the UI: parse text, then apply atomically. */
function paste(state: State, payload: UpdatePayload | string, accept: string[] = [], today = TODAY) {
  const raw = typeof payload === 'string' ? payload : '```json\n' + JSON.stringify(payload, null, 2) + '\n```'
  const parsed = parseUpdate(raw)
  if (!parsed.ok) return { state, errors: parsed.errors }
  const result = execute(state, parsed.update, today, new Set(accept))
  return { state: applyUpdate(state, parsed.update, parsed.hash, new Set(accept), today), result }
}
const open = (s: State, day = TODAY) => queue(s, day).map((t) => t.title)
const byId = (s: State, id: string) => s.tasks.find((t) => t.id === id)!

const morningPlan = () =>
  paste(emptyState(), upd(0, [
    { op: 'add_task', id: 'c0-1', title: 'Svar Anna', priority: 'medium', when: 'today' },
    { op: 'add_task', id: 'c0-2', title: 'Ring til banken', priority: 'high', deadline: '2026-11-06', category: 'Økonomi', when: 'today' },
    { op: 'add_task', id: 'c0-3', title: 'Køb pærer', priority: 'low', when: 'today' },
    { op: 'add_task', id: 'c0-4', title: 'Forny pas', when: 'tomorrow' },
    { op: 'add_idea', text: 'Lære guitar' },
  ])).state

// ---------- IDs and migration

test('every task gets a permanent ID that survives edit, completion and reload', () => {
  const store = memory()
  let s = reduce(emptyState(), { type: 'add', title: 'A' }, TODAY)
  const id = s.tasks[0].id
  assert.match(id, /^t\d+$/)
  s = reduce(s, { type: 'update', id, patch: { title: 'A renamed', priority: 'high' } }, TODAY)
  s = reduce(s, { type: 'complete', id }, TODAY)
  save(store, s)
  const reloaded = load(store)
  assert.equal(reloaded.tasks[0].id, id)
  assert.equal(reloaded.tasks[0].title, 'A renamed')
  assert.deepEqual(reloaded, s)
})

test('migration: old data keeps IDs, gets IDs where missing, fixes duplicate IDs, backs up the original', () => {
  const store = memory()
  const old = JSON.stringify({
    tasks: [
      { id: 'mhe3k2x1a9f3c', title: 'Old task', notes: '', category: 'Work', day: TODAY, order: 1, done: false, createdAt: 1 },
      { title: 'No id task', day: TODAY, order: 2, done: true },
      { id: 'mhe3k2x1a9f3c', title: 'Duplicate id', day: TODAY, order: 3 },
      { id: 'broken' },
    ],
    thoughts: [{ id: 'x', text: 'idea', createdAt: 1 }],
    categories: ['Work'],
  })
  store.data.set(STORAGE_KEY, old)
  const s = load(store)
  assert.deepEqual(s.tasks.map((t) => t.title), ['Old task', 'No id task', 'Duplicate id'])
  assert.equal(s.tasks[0].id, 'mhe3k2x1a9f3c')
  const ids = s.tasks.map((t) => t.id)
  assert.equal(new Set(ids).size, 3, 'IDs are unique')
  assert.equal(s.tasks[1].done, true)
  assert.equal(s.rev, 0)
  assert.equal(store.data.get(BACKUP_KEY), old, 'original data backed up')
  // IDs assigned during migration are stable from then on
  save(store, s)
  assert.deepEqual(load(store).tasks.map((t) => t.id), ids)
})

// ---------- plan export

test('plan snapshot: date, rev, IDs, priorities, deadlines, when, done, ideas; hides cancelled', () => {
  let s = morningPlan()
  s = reduce(s, { type: 'complete', id: 'c0-1' }, TODAY)
  s = reduce(s, { type: 'add', title: 'Later thing', day: '2026-11-05' }, TODAY)
  s = reduce(s, { type: 'remove', id: 'c0-3' }, TODAY)
  const p = buildPlan(s, TODAY)
  assert.equal(p.date, TODAY)
  assert.equal(p.weekday, 'lørdag')
  assert.equal(p.rev, s.rev)
  assert.equal(p.new_id_prefix, `c${s.rev}-`)
  assert.deepEqual(p.tasks.map((t) => [t.id, t.when, t.done ?? false]), [
    ['c0-2', 'today', false], ['c0-1', 'today', true], ['c0-4', 'tomorrow', false], [p.tasks[3].id, 'later', false],
  ])
  assert.deepEqual(p.tasks[0], { id: 'c0-2', title: 'Ring til banken', when: 'today', priority: 'high', deadline: '2026-11-06', category: 'Økonomi' })
  assert.equal(p.tasks[3].day, '2026-11-05')
  assert.deepEqual(p.ideas, ['Lære guitar'])
  const text = planText(s, TODAY)
  assert.equal(detectKind(text), 'plan')
  assert.ok(text.includes(`base_rev ${s.rev}`))
})

test('setup prompt documents every operation and the ID/revision rules', () => {
  const p = setupPrompt()
  for (const op of ['add_task', 'update_task', 'complete_task', 'postpone_task', 'cancel_task', 'add_idea', 'base_rev', 'new_id_prefix', '"next_update":2']) {
    assert.ok(p.includes(op), op)
  }
})

// ---------- initial import and a day of updates

test('initial plan import: tasks ordered by priority, ideas to Inbox, tomorrow scheduled', () => {
  const s = morningPlan()
  assert.deepEqual(open(s), ['Ring til banken', 'Svar Anna', 'Køb pærer'])
  assert.deepEqual(open(s, TOMORROW), ['Forny pas'])
  assert.deepEqual(s.thoughts.map((t) => t.text), ['Lære guitar'])
  assert.ok(s.categories.includes('Økonomi'))
})

test('multiple updates through the day, all based on the same morning plan, never conflict with each other', () => {
  let s = morningPlan() // the morning plan was copied at rev 0
  // 10:00 – update an existing task by ID, complete one, add one
  s = paste(s, upd(0, [
    { op: 'update_task', id: 'c0-1', title: 'Svar Anna om fredag', priority: 'high' },
    { op: 'complete_task', id: 'c0-2' },
    { op: 'add_task', id: 'c0-5', title: 'Hent pakke', when: 'today' },
  ])).state
  assert.equal(byId(s, 'c0-1').title, 'Svar Anna om fredag')
  assert.equal(byId(s, 'c0-2').done, true)
  assert.equal(open(s)[0], 'Svar Anna om fredag', 'high priority moves first')
  // 14:00 – ChatGPT changes a task it changed earlier and completes the task it added
  const r = paste(s, upd(0, [
    { op: 'update_task', id: 'c0-1', priority: 'low' },
    { op: 'complete_task', id: 'c0-5' },
    { op: 'postpone_task', id: 'c0-3', to: 'tomorrow' },
  ]))
  assert.equal(r.result?.ok && r.result.conflicts.length, 0)
  s = r.state
  assert.equal(byId(s, 'c0-1').priority, 'low')
  assert.equal(byId(s, 'c0-5').done, true)
  assert.deepEqual(open(s, TOMORROW), ['Forny pas', 'Køb pærer'])
  assert.deepEqual(progress(s, TODAY), { done: 2, total: 3 })
})

test('tasks absent from an update are never touched; completed tasks are preserved', () => {
  let s = morningPlan()
  s = reduce(s, { type: 'complete', id: 'c0-1' }, TODAY)
  const before = JSON.stringify(s.tasks.filter((t) => t.id !== 'c0-3'))
  s = paste(s, upd(0, [{ op: 'update_task', id: 'c0-3', notes: 'LED' }])).state
  assert.equal(JSON.stringify(s.tasks.filter((t) => t.id !== 'c0-3')), before)
  // postponing or cancelling a done task is skipped, completion kept
  const r = paste(s, upd(0, [{ op: 'postpone_task', id: 'c0-1', to: 'tomorrow' }, { op: 'cancel_task', id: 'c0-1' }]))
  assert.equal(byId(r.state, 'c0-1').done, true)
  assert.equal(byId(r.state, 'c0-1').day, TODAY)
  assert.ok(r.result?.ok && r.result.skipped.length === 2)
})

// ---------- duplicates and idempotency

test('pasting the same update twice changes nothing the second time', () => {
  const s1 = morningPlan()
  const u = upd(0, [{ op: 'add_task', id: 'c0-9', title: 'Vask tøj' }, { op: 'complete_task', id: 'c0-1' }])
  const s2 = paste(s1, u).state
  const s3 = paste(s2, u).state
  assert.equal(s3, s2, 'identical object: no change at all')
  // same JSON with different formatting / fences is also recognised
  const s4 = paste(s3, JSON.stringify(u)).state
  assert.equal(s4, s2)
})

test('a re-sent add_task (same ID or same title) is skipped, not duplicated', () => {
  let s = morningPlan()
  s = paste(s, upd(0, [
    { op: 'add_task', id: 'c0-1', title: 'svar anna!' }, // same ID, same title
    { op: 'add_task', id: 'c0-7', title: 'Køb pærer' }, // new ID, same open task title
    { op: 'add_idea', text: 'lære guitar' },
  ])).state
  assert.equal(s.tasks.filter((t) => t.title === 'Køb pærer').length, 1)
  assert.equal(s.tasks.length, 4)
  assert.equal(s.thoughts.length, 1)
})

// ---------- stale snapshots, conflicts, manual edits

test('manual edit after the plan → conflict for that field only; default keeps the user value', () => {
  let s = morningPlan()
  const planRev = s.rev
  s = reduce(s, { type: 'update', id: 'c0-3', patch: { title: 'Køb 3 LED-pærer' } }, TODAY) // user edits in NEXT
  const u = upd(planRev, [
    { op: 'update_task', id: 'c0-3', title: 'Køb pærer i Bauhaus', priority: 'high' },
    { op: 'complete_task', id: 'c0-1' },
  ])
  const dry = execute(s, u, TODAY)
  assert.ok(dry.ok)
  assert.deepEqual(dry.conflicts.map((c) => [c.taskId, c.field, c.mine, c.theirs]), [['c0-3', 'title', 'Køb 3 LED-pærer', 'Køb pærer i Bauhaus']])
  const kept = paste(s, u).state
  assert.equal(byId(kept, 'c0-3').title, 'Køb 3 LED-pærer', 'user value kept')
  assert.equal(byId(kept, 'c0-3').priority, 'high', 'non-conflicting field applied')
  assert.equal(byId(kept, 'c0-1').done, true, 'other ops applied')
  const theirs = paste(s, u, [dry.conflicts[0].key]).state
  assert.equal(byId(theirs, 'c0-3').title, 'Køb pærer i Bauhaus')
})

test('manual move/reopen after the plan conflict with postpone/complete; a fresh plan resolves it', () => {
  let s = morningPlan()
  const planRev = s.rev
  s = reduce(s, { type: 'tomorrow', id: 'c0-1' }, TODAY)
  s = reduce(s, { type: 'complete', id: 'c0-3' }, TODAY)
  s = reduce(s, { type: 'reopen', id: 'c0-3' }, TODAY)
  const u = upd(planRev, [{ op: 'postpone_task', id: 'c0-1', to: '2026-11-03' }, { op: 'complete_task', id: 'c0-3' }])
  const r = execute(s, u, TODAY)
  assert.ok(r.ok)
  assert.deepEqual(r.conflicts.map((c) => c.field), ['day', 'done'])
  const fresh = execute(s, { ...u, base_rev: s.rev }, TODAY)
  assert.ok(fresh.ok && fresh.conflicts.length === 0, 'no conflict when based on a plan copied after the edits')
})

test('cancel of a task the user edited after the plan asks first; otherwise hides it but keeps the ID', () => {
  let s = morningPlan()
  const planRev = s.rev
  s = reduce(s, { type: 'update', id: 'c0-1', patch: { notes: 'vigtigt' } }, TODAY)
  const r = execute(s, upd(planRev, [{ op: 'cancel_task', id: 'c0-1' }, { op: 'cancel_task', id: 'c0-3' }]), TODAY)
  assert.ok(r.ok)
  assert.deepEqual(r.conflicts.map((c) => c.taskId), ['c0-1'])
  s = paste(s, upd(planRev, [{ op: 'cancel_task', id: 'c0-1' }, { op: 'cancel_task', id: 'c0-3' }])).state
  assert.ok(!open(s).includes('Køb pærer'))
  assert.ok(open(s).includes('Svar Anna'))
  assert.equal(byId(s, 'c0-3').cancelled, true)
  // later updates mentioning the cancelled ID are skipped, not rejected
  const later = paste(s, upd(planRev, [{ op: 'update_task', id: 'c0-3', title: 'x' }, { op: 'add_idea', text: 'ny idé' }]))
  assert.ok(later.result?.ok && later.result.skipped[0].reason === 'deleted in NEXT')
  assert.equal(later.state.thoughts[0].text, 'ny idé')
})

// ---------- validation is atomic

test('any invalid operation rejects the whole update and changes nothing', () => {
  const s = morningPlan()
  const cases: [string, unknown][] = [
    ['unknown ID', upd(0, [{ op: 'complete_task', id: 'c0-1' }, { op: 'complete_task', id: 't999' }])],
    ['ID reused for a different task', upd(0, [{ op: 'add_task', id: 'c0-1', title: 'Noget helt andet' }])],
    ['bad date', upd(0, [{ op: 'postpone_task', id: 'c0-1', to: '2026-02-30' }])],
    ['past date', upd(0, [{ op: 'postpone_task', id: 'c0-1', to: '2026-10-01' }])],
    ['unknown op', { next_update: 2, base_rev: 0, ops: [{ op: 'delete_everything' }] }],
    ['unknown field', { next_update: 2, base_rev: 0, ops: [{ op: 'complete_task', id: 'c0-1', force: true }] }],
    ['future rev', upd(s.rev + 5, [{ op: 'complete_task', id: 'c0-1' }])],
    ['empty ops', { next_update: 2, base_rev: 0, ops: [] }],
    ['new ID without c prefix', upd(0, [{ op: 'add_task', id: 't50', title: 'X' }])],
  ]
  for (const [name, payload] of cases) {
    const raw = JSON.stringify(payload)
    const parsed = parseUpdate(raw)
    const errors = parsed.ok ? (() => { const r = execute(s, parsed.update, TODAY); return r.ok ? [] : r.errors })() : parsed.errors
    assert.ok(errors.length > 0, `${name} should be rejected`)
    if (parsed.ok) assert.equal(applyUpdate(s, parsed.update, parsed.hash, new Set(), TODAY), s, `${name}: state untouched`)
  }
})

test('detectKind keeps the brain dump v1 path working', () => {
  assert.equal(detectKind('```json\n{"version":1,"tasks":[],"ideas":[]}\n```'), 'dump')
  assert.equal(detectKind('{"next_update":2,"base_rev":0,"ops":[]}'), 'update')
  assert.equal(detectKind('hej'), 'none')
})

// ---------- persistence of sync state

test('revision, applied fingerprints and manual-change tracking survive reload', () => {
  const store = memory()
  let s = morningPlan()
  s = reduce(s, { type: 'update', id: 'c0-1', patch: { title: 'Manual' } }, TODAY)
  save(store, s)
  const r = load(store)
  assert.equal(r.rev, s.rev)
  assert.deepEqual(r.applied, s.applied)
  assert.equal(byId(r, 'c0-1').userRev?.title, s.rev)
  // a stale update is still detected as a conflict after reload
  const ex = execute(r, upd(0, [{ op: 'update_task', id: 'c0-1', title: 'From chat' }]), TODAY)
  assert.ok(ex.ok && ex.conflicts.length === 1)
})

test('summary text is short', () => {
  assert.equal(summarize({ added: 2, updated: 0, completed: 1, postponed: 0, cancelled: 0, ideas: 1 }, 1, 0), '2 new · 1 done · 1 to Inbox · 1 skipped')
  assert.equal(summarize({ added: 0, updated: 0, completed: 0, postponed: 0, cancelled: 0, ideas: 0 }, 0, 0), 'Nothing new')
})
