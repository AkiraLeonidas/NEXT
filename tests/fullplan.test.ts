import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Decisions, FullPlan, FullPlanTask } from '../src/ai/fullplan.ts'
import { FULL_PLAN_SCHEMA, applyFullPlan, fullPlanSetupPrompt, parseFullPlan, reconcile, summarizePlan } from '../src/ai/fullplan.ts'
import { applyUpdate, detectKind, parseUpdate } from '../src/ai/sync.ts'
import type { State } from '../src/store.ts'
import { emptyState, load, progress, queue, reduce, save } from '../src/store.ts'

const TODAY = '2026-11-02'
const TOMORROW = '2026-11-03'

const task = (key: string, title: string, extra: Partial<FullPlanTask> = {}): FullPlanTask => ({
  key, title, notes: null, priority: 'medium', deadline: null, category: null, when: 'today', day: null, status: 'open', ...extra,
})
const plan = (tasks: FullPlanTask[], ideas: string[] = [], date = TODAY): FullPlan => ({ next_full_plan: 1, date, tasks, ideas: ideas.map((text) => ({ text })) })

/** Paste like the UI does: ChatGPT-style fenced JSON → parse → apply atomically. */
function paste(state: State, p: FullPlan | string, decisions: Decisions = {}, today = TODAY) {
  const raw = typeof p === 'string' ? p : 'Her er din plan:\n```json\n' + JSON.stringify(p, null, 2) + '\n```'
  const parsed = parseFullPlan(raw, today)
  if (!parsed.ok) return { state, errors: parsed.errors }
  const result = reconcile(state, parsed.plan, today, decisions)
  return { state: applyFullPlan(state, parsed.plan, parsed.hash, decisions, today), result, errors: [] as string[] }
}
const open = (s: State, day = TODAY) => queue(s, day).map((t) => t.title)
const byKey = (s: State, key: string) => s.tasks.find((t) => t.key === key)!

const morning = plan([
  task('ring-banken', 'Ring til banken', { priority: 'high', deadline: '2026-11-06', category: 'Økonomi' }),
  task('svar-anna', 'Svar Anna', { status: 'done' }),
  task('koeb-paerer', 'Køb pærer', { priority: 'low', notes: 'LED' }),
  task('forny-pas', 'Book tid til nyt pas', { when: 'tomorrow' }),
  task('tandlaege', 'Ring til tandlægen', { when: 'later', day: '2026-11-05' }),
], ['Lære guitar'])

// ---------- schema & validation

test('documented schema file matches the code, and every task field is required', () => {
  const doc = JSON.parse(readFileSync(new URL('../docs/next-full-plan.schema.json', import.meta.url), 'utf8'))
  assert.deepEqual(doc, JSON.parse(JSON.stringify(FULL_PLAN_SCHEMA)))
  const item = FULL_PLAN_SCHEMA.properties.tasks.items
  assert.deepEqual([...item.required].sort(), Object.keys(item.properties).sort())
})

test('setup prompt asks for exactly this schema and covers Notion, keys and statuses', () => {
  const p = fullPlanSetupPrompt()
  for (const s of ['"next_full_plan": 2', '"urgency"', '"importance"', 'Notion', '"key"', 'SAMME key', '"status"', '"later"', 'NEXT-plan', 'ideas']) assert.ok(p.includes(s), s)
  const example = JSON.parse(p.slice(p.indexOf('{'), p.indexOf('\n}\n') + 2).replaceAll('ÅÅÅÅ-MM-DD', TODAY))
  assert.ok(parseFullPlan(JSON.stringify(example), TODAY).ok, 'the example in the prompt is itself valid')
})

test('rejects invalid plans with readable errors (nothing applied)', () => {
  const cases: [string, unknown, string][] = [
    ['missing field', { ...morning, tasks: [{ key: 'a', title: 'A' }] }, 'missing "notes"'],
    ['unknown field', { ...morning, extra: 1 }, 'unknown field "extra"'],
    ['later without day', plan([task('a', 'A', { when: 'later' })]), '"day"'],
    ['day with today', plan([task('a', 'A', { day: TOMORROW })]), 'must be null'],
    ['duplicate key', plan([task('a', 'A'), task('a', 'B')]), 'used twice'],
    ['duplicate title', plan([task('a', 'Køb mælk'), task('b', 'køb mælk!')]), 'appears twice'],
    ['bad key', plan([task('Ring Banken', 'A')]), '"key"'],
    ['past plan', plan([task('a', 'A')], [], '2026-11-01'), 'has passed'],
    ['bad status', plan([task('a', 'A', { status: 'maybe' as never })]), '"status"'],
  ]
  for (const [name, p, expected] of cases) {
    const r = parseFullPlan(JSON.stringify(p), TODAY)
    assert.ok(!r.ok, name)
    assert.ok(r.errors.join(' ').includes(expected), `${name}: ${r.errors.join(' | ')}`)
  }
  assert.equal(detectKind(JSON.stringify(morning)), 'fullplan')
})

// ---------- first import into an empty app

test('empty app: first import needs no snapshot; order, done, tomorrow, later and ideas are right', () => {
  const { state: s, result } = paste(emptyState(), morning)
  assert.ok(result?.ok && result.review.length === 0)
  assert.deepEqual(open(s), ['Ring til banken', 'Køb pærer'])
  assert.deepEqual(progress(s, TODAY), { done: 1, total: 3 })
  assert.deepEqual(open(s, TOMORROW), ['Book tid til nyt pas'])
  assert.deepEqual(open(s, '2026-11-05'), ['Ring til tandlægen'])
  assert.deepEqual(s.thoughts.map((t) => t.text), ['Lære guitar'])
  const bank = byKey(s, 'ring-banken')
  assert.match(bank.id, /^t\d+$/)
  assert.equal(bank.priority, 'high')
  assert.equal(bank.deadline, '2026-11-06')
  assert.ok(s.categories.includes('Økonomi'))
  assert.equal(summarizePlan(result.counts), 'Day planned · 5 new · 1 to Inbox')
})

// ---------- repeated imports

test('same plan pasted again changes nothing; re-sent content never duplicates', () => {
  const s1 = paste(emptyState(), morning).state
  assert.equal(paste(s1, morning).state, s1, 'identical paste is ignored')
  // Same content, different formatting/prose: also recognised
  assert.equal(paste(s1, JSON.stringify(morning)).state, s1)
  // Even if it were applied again (fingerprint forgotten), nothing is duplicated or changed
  const again = paste({ ...s1, applied: [] }, morning).state
  assert.equal(again.tasks.length, s1.tasks.length)
  assert.deepEqual(again.tasks.map((t) => [t.id, t.title, t.done, t.day]), s1.tasks.map((t) => [t.id, t.title, t.done, t.day]))
})

test('later plan in the day: IDs stay stable by key (even when renamed), new tasks added, missing tasks kept', () => {
  const s1 = paste(emptyState(), morning).state
  const bankId = byKey(s1, 'ring-banken').id
  const s2 = paste(s1, plan([
    task('ring-banken', 'Ring til banken om lånet', { priority: 'high' }), // renamed
    task('hent-pakke', 'Hent pakke', { priority: 'high' }), // new
    task('koeb-paerer', 'Køb pærer', { status: 'done', priority: 'low', notes: 'LED' }), // done
  ])).state
  assert.equal(byKey(s2, 'ring-banken').id, bankId)
  assert.equal(byKey(s2, 'ring-banken').title, 'Ring til banken om lånet')
  assert.equal(byKey(s2, 'ring-banken').deadline, undefined, 'deadline cleared by the plan')
  assert.equal(byKey(s2, 'koeb-paerer').done, true)
  assert.deepEqual(open(s2), ['Ring til banken om lånet', 'Hent pakke'])
  assert.ok(byKey(s2, 'forny-pas') && byKey(s2, 'tandlaege'), 'tasks missing from the plan are kept')
  assert.equal(s2.thoughts.length, 1)
})

// ---------- completed tasks

test('tasks completed in NEXT stay completed even if the plan still says open', () => {
  let s = paste(emptyState(), morning).state
  s = reduce(s, { type: 'complete', id: byKey(s, 'ring-banken').id }, TODAY)
  const { state: s2, result } = paste(s, plan([task('ring-banken', 'Ring til banken', { priority: 'high', deadline: '2026-11-06', category: 'Økonomi' }), task('koeb-paerer', 'Køb pærer', { priority: 'low', notes: 'LED' })]))
  assert.ok(result?.ok && result.review.length === 0, 'no question asked')
  assert.equal(byKey(s2, 'ring-banken').done, true)
  assert.equal(s2.tasks.filter((t) => t.title === 'Ring til banken').length, 1, 'not re-created')
  assert.ok(result.ok && result.counts.keptDone === 1)
})

test('done tasks from an earlier day are matched by key, not re-created; recurring tasks use dated keys', () => {
  let s = paste(emptyState(), plan([task('gaa-tur-2026-11-02', 'Gå en tur', { status: 'done' }), task('vand', 'Vand planter', { status: 'done' })])).state
  const tomorrow = paste(s, plan([task('gaa-tur-2026-11-03', 'Gå en tur'), task('vand', 'Vand planter')], [], TOMORROW), {}, TOMORROW).state
  assert.deepEqual(open(tomorrow, TOMORROW), ['Gå en tur'], 'recurring task with a new key is new; same key stays done')
})

// ---------- tomorrow tasks

test('tomorrow and later tasks are scheduled relative to the plan date', () => {
  const s = paste(emptyState(), plan([task('a', 'A', { when: 'tomorrow' }), task('b', 'B', { when: 'later', day: '2026-11-10' })], [], TOMORROW), {}, TODAY).state
  assert.deepEqual(open(s, '2026-11-04'), ['A'])
  assert.deepEqual(open(s, '2026-11-10'), ['B'])
})

// ---------- duplicates

test('duplicate detection: exact title with a new key is the same task; similar title asks', () => {
  let s = reduce(emptyState(), { type: 'add', title: 'Køb mælk' }, TODAY) // made manually in NEXT
  s = reduce(s, { type: 'add', title: 'Ring til tandlægen i dag' }, TODAY)
  const p = plan([task('maelk', 'køb mælk'), task('tand', 'Ring til tandlægen')])
  const { result } = paste(s, p)
  assert.ok(result?.ok)
  assert.deepEqual(result.review.map((r) => [r.kind, r.title]), [['match', 'Ring til tandlægen']])
  const same = paste(s, p).state // default: same task
  assert.equal(same.tasks.length, 2)
  assert.equal(same.tasks[0].key, 'maelk', 'manual task adopted by key')
  const asNew = paste(s, p, { 'm:tand': 'new' }).state
  assert.equal(asNew.tasks.length, 3)
})

// ---------- conflicts with manual edits

test('manual edit since the last import → conflict; "Keep mine" is remembered; a new ChatGPT value asks again', () => {
  let s = paste(emptyState(), morning).state
  s = reduce(s, { type: 'update', id: byKey(s, 'koeb-paerer').id, patch: { title: 'Køb 3 LED-pærer' } }, TODAY)
  const p2 = plan([task('koeb-paerer', 'Køb pærer', { priority: 'high', notes: 'LED' })])
  const r = paste(s, p2)
  assert.ok(r.result?.ok)
  assert.deepEqual(r.result.review.map((x) => x.kind === 'conflict' && [x.field, x.mine, x.theirs]), [['title', 'Køb 3 LED-pærer', 'Køb pærer']])
  let s2 = r.state
  assert.equal(byKey(s2, 'koeb-paerer').title, 'Køb 3 LED-pærer', 'default keeps mine')
  assert.equal(byKey(s2, 'koeb-paerer').priority, 'high', 'untouched fields still update')
  // Next plan repeats the old title: no question again
  const p3 = plan([task('koeb-paerer', 'Køb pærer', { priority: 'high', notes: 'LED' }), task('ny', 'Ny opgave')])
  const r3 = paste(s2, p3)
  assert.ok(r3.result?.ok && r3.result.review.length === 0)
  s2 = r3.state
  assert.equal(byKey(s2, 'koeb-paerer').title, 'Køb 3 LED-pærer')
  // A different ChatGPT value asks again; accepting applies it
  const p4 = plan([task('koeb-paerer', 'Køb pærer i Bauhaus', { priority: 'high', notes: 'LED' })])
  const r4 = paste(s2, p4)
  assert.ok(r4.result?.ok && r4.result.review.length === 1)
  const s4 = paste(s2, p4, { 'c:koeb-paerer:title': 'theirs' }).state
  assert.equal(byKey(s4, 'koeb-paerer').title, 'Køb pærer i Bauhaus')
})

test('manual move to tomorrow, reopen, and delete are respected', () => {
  let s = paste(emptyState(), morning).state
  s = reduce(s, { type: 'tomorrow', id: byKey(s, 'ring-banken').id }, TODAY)
  s = reduce(s, { type: 'remove', id: byKey(s, 'koeb-paerer').id }, TODAY)
  s = reduce(s, { type: 'reopen', id: byKey(s, 'svar-anna').id }, TODAY)
  assert.equal(paste(s, morning).state, s, 'the exact morning plan again is ignored')
  const p = plan(morning.tasks.map((t) => ({ ...t })), ['Ny idé'])
  const r2 = paste(s, p)
  assert.ok(r2.result?.ok)
  assert.deepEqual(r2.result.review.map((x) => x.kind === 'conflict' && x.field).sort(), ['day', 'done'])
  const s2 = r2.state
  assert.equal(byKey(s2, 'ring-banken').day, TOMORROW, 'kept on tomorrow')
  assert.equal(byKey(s2, 'koeb-paerer').cancelled, true, 'deleted stays deleted')
  assert.equal(byKey(s2, 'svar-anna').done, false, 'reopened stays open')
  assert.ok(r2.result.counts.keptDeleted === 1)
})

test('status "cancelled" removes an untouched task, but asks if you edited it', () => {
  let s = paste(emptyState(), morning).state
  s = reduce(s, { type: 'update', id: byKey(s, 'koeb-paerer').id, patch: { notes: 'vigtigt' } }, TODAY)
  const p = plan([task('ring-banken', 'Ring til banken', { status: 'cancelled' }), task('koeb-paerer', 'Køb pærer', { status: 'cancelled' })])
  const r = paste(s, p)
  assert.ok(r.result?.ok)
  assert.deepEqual(r.result.review.map((x) => x.taskId), [byKey(s, 'koeb-paerer').id])
  assert.equal(byKey(r.state, 'ring-banken').cancelled, true)
  assert.equal(byKey(r.state, 'koeb-paerer').cancelled, undefined)
})

// ---------- atomicity, undo data, persistence, compatibility

test('an invalid plan changes nothing; a valid one is applied in one step', () => {
  const s = paste(emptyState(), morning).state
  const bad = JSON.stringify({ ...plan([task('x', 'X')]), tasks: [task('x', 'X'), { key: 'y' }] })
  const r = paste(s, bad)
  assert.equal(r.state, s)
  assert.ok(r.errors.length > 0)
  const ok = paste(s, plan([task('x', 'X')])).state
  assert.equal(ok.rev, s.rev + 1, 'one revision per import (undo restores the previous state as a whole)')
})

test('keys, import markers and remembered choices survive reload', () => {
  let s = paste(emptyState(), morning).state
  s = reduce(s, { type: 'update', id: byKey(s, 'koeb-paerer').id, patch: { title: 'Mine' } }, TODAY)
  s = paste(s, plan([task('koeb-paerer', 'Køb pærer', { priority: 'low', notes: 'LED' })])).state
  const mem = new Map<string, string>()
  const store = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) }
  save(store, s)
  const r = load(store)
  assert.deepEqual(r, s)
  const again = paste(r, plan([task('koeb-paerer', 'Køb pærer', { priority: 'low', notes: 'LED' }), task('z', 'Z')]))
  assert.ok(again.result?.ok && again.result.review.length === 0, 'remembered "Keep mine" after reload')
})

test('incremental updates (advanced) still work on tasks created by a full plan', () => {
  const s = paste(emptyState(), morning).state
  const id = byKey(s, 'ring-banken').id
  const parsed = parseUpdate(JSON.stringify({ next_update: 2, base_rev: s.rev, ops: [{ op: 'complete_task', id }] }))
  assert.ok(parsed.ok)
  const s2 = applyUpdate(s, parsed.update, parsed.hash, new Set(), TODAY)
  assert.equal(s2.tasks.find((t) => t.id === id)!.done, true)
})
