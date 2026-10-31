import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FullPlan, FullPlanTask } from '../src/ai/fullplan.ts'
import { applyFullPlan, parseFullPlan, reconcile } from '../src/ai/fullplan.ts'
import { buildHandover, sensitiveHints, snapshotTasks } from '../src/ai/handover.ts'
import { buildPlan } from '../src/ai/sync.ts'
import { PhotoError, fitWithin, toPhotoError } from '../src/photoErrors.ts'
import { WEIGHTS, daysBetween, explain, rankTasks, score } from '../src/priority.ts'
import type { Action, State, Task } from '../src/store.ts'
import { addDays, dayKey, doneToday, emptyState, load, msUntilNextDay, nowQueue, progress, queue, reduce, save, weekCounts } from '../src/store.ts'

const D = '2026-11-02'
const run = (actions: Action[], start: State = emptyState(), today = D) => actions.reduce((s, a) => reduce(s, a, today), start)
const idOf = (s: State, title: string) => s.tasks.find((t) => t.title === title)!.id
const titles = (tasks: Task[]) => tasks.map((t) => t.title)
const mem = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }
}
const withTZ = <T>(tz: string, fn: () => T): T => {
  const old = process.env.TZ
  process.env.TZ = tz
  try { return fn() } finally { if (old === undefined) delete process.env.TZ; else process.env.TZ = old }
}

// ---------- Feature 1: daily rollover

test('rollover: unfinished past tasks are actionable today, keep their dates, and are marked overdue', () => {
  const s = run([{ type: 'add', title: 'Old', day: '2026-10-30' }, { type: 'add', title: 'Today' }, { type: 'add', title: 'Future', day: '2026-11-05' }])
  assert.deepEqual(titles(nowQueue(s, D)).sort(), ['Old', 'Today'])
  assert.equal(s.tasks.find((t) => t.title === 'Old')!.day, '2026-10-30', 'date untouched')
  assert.deepEqual(titles(queue(s, '2026-11-05')), ['Future'], 'future stays scheduled')
  assert.ok(!titles(nowQueue(s, D)).includes('Future'))
})

test('rollover: completed, cancelled and deleted tasks never roll over', () => {
  let s = run([{ type: 'add', title: 'Done', day: '2026-10-30' }, { type: 'add', title: 'Gone', day: '2026-10-30' }, { type: 'add', title: 'Open', day: '2026-10-30' }])
  s = run([{ type: 'complete', id: idOf(s, 'Done') }, { type: 'remove', id: idOf(s, 'Gone') }], s)
  assert.deepEqual(titles(nowQueue(s, D)), ['Open'])
  assert.deepEqual(titles(nowQueue(s, '2026-12-01')), ['Open'])
})

test('rollover: crossing midnight, month and year boundaries', () => {
  const s = run([{ type: 'add', title: 'NYE', day: '2026-12-31' }], emptyState(), '2026-12-31')
  assert.deepEqual(titles(nowQueue(s, '2026-12-31')), ['NYE'])
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2028-02-28', 1), '2028-02-29', 'leap year')
  assert.deepEqual(titles(nowQueue(s, '2027-01-01')), ['NYE'])
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1)
  assert.match(explain(nowQueue(s, '2027-01-01')[0], '2027-01-01').map((r) => r.label).join(), /Scheduled 1 day ago/)
})

test('rollover: multi-day inactivity is derived, so there are no duplicates and nothing is rewritten', () => {
  const s = run([{ type: 'add', title: 'A', day: '2026-10-20' }, { type: 'add', title: 'B' }])
  const before = JSON.stringify(s)
  for (const day of ['2026-11-03', '2026-11-10', '2027-03-01']) {
    assert.deepEqual(titles(nowQueue(s, day)).sort(), ['A', 'B'])
    assert.equal(nowQueue(s, day).length, 2)
  }
  assert.equal(JSON.stringify(s), before, 'state is never mutated by the day changing')
  const reloaded = load((() => { const m = mem(); save(m, s); return m })())
  assert.deepEqual(reloaded, s, 'reload/reopen gives the same tasks')
})

test('rollover: daylight-saving changes (EU and US) keep day keys and the midnight timer right', () => {
  withTZ('Europe/Copenhagen', () => {
    // 25 Oct 2026: clocks go back, a 25-hour day.
    const noon = new Date(2026, 9, 25, 12, 0)
    assert.equal(dayKey(noon), '2026-10-25')
    assert.equal(msUntilNextDay(noon), 12 * 3_600_000)
    const late = new Date(2026, 9, 24, 23, 30)
    assert.equal(msUntilNextDay(late), 30 * 60_000)
    // 29 Mar 2026: clocks go forward, a 23-hour day.
    assert.equal(msUntilNextDay(new Date(2026, 2, 29, 0, 0)), 23 * 3_600_000)
    assert.equal(addDays('2026-03-28', 1), '2026-03-29')
    assert.equal(addDays('2026-03-29', 1), '2026-03-30')
  })
  withTZ('America/New_York', () => {
    assert.equal(addDays('2026-10-31', 1), '2026-11-01')
    assert.equal(addDays('2026-11-01', 1), '2026-11-02')
    assert.equal(msUntilNextDay(new Date(2026, 10, 1, 0, 0)), 25 * 3_600_000)
  })
  assert.equal(daysBetween('2026-10-24', '2026-10-26'), 2, 'day differences ignore DST')
})

test('rollover: timezone change uses the new local date', () => {
  const instant = new Date(Date.UTC(2026, 10, 2, 23, 30)) // 23:30 UTC on 2 Nov
  assert.equal(withTZ('Europe/Copenhagen', () => dayKey(instant)), '2026-11-03')
  assert.equal(withTZ('America/Los_Angeles', () => dayKey(instant)), '2026-11-02')
  assert.equal(withTZ('Asia/Tokyo', () => dayKey(instant)), '2026-11-03')
  const s = run([{ type: 'add', title: 'X', day: '2026-11-02' }])
  assert.equal(nowQueue(s, '2026-11-03')[0].day, '2026-11-02', 'still the original date after travelling')
})

test('progress and done list count tasks completed today, including overdue ones', () => {
  let s = run([{ type: 'add', title: 'Old', day: '2026-10-30' }, { type: 'add', title: 'New' }])
  s = reduce(s, { type: 'complete', id: idOf(s, 'Old') }, D)
  const today = dayKey()
  assert.deepEqual(titles(doneToday(s, today)).includes('Old'), true)
  assert.equal(progress(s, today).done >= 1, true)
})

test('reopen keeps the original date; undo of Done puts the task back', () => {
  let s = run([{ type: 'add', title: 'Old', day: '2026-10-30' }])
  s = reduce(s, { type: 'complete', id: idOf(s, 'Old') }, D)
  s = reduce(s, { type: 'reopen', id: idOf(s, 'Old') }, D)
  assert.equal(s.tasks[0].day, '2026-10-30')
  assert.deepEqual(titles(nowQueue(s, D)), ['Old'])
})

// ---------- Feature 2: priority engine

const mk = (over: Partial<Task>): Task => ({ id: over.id ?? over.title ?? 'x', title: 'x', notes: '', category: '', day: D, order: 1, done: false, createdAt: 1, ...over })

test('priority: weights are applied as documented', () => {
  assert.equal(score(mk({}), D), WEIGHTS.priority.medium + WEIGHTS.urgency.medium + WEIGHTS.importance.medium)
  assert.equal(score(mk({ deadline: D }), D) - score(mk({}), D), WEIGHTS.deadlineToday)
  assert.equal(score(mk({ deadline: '2026-11-01' }), D) - score(mk({}), D), WEIGHTS.deadlineOverdue)
  assert.equal(score(mk({ day: '2026-10-01' }), D) - score(mk({}), D), WEIGHTS.overdueMax, 'overdue bonus is capped')
})

test('priority: hard deadlines outrank flexible scheduled dates', () => {
  const late = mk({ title: 'scheduled long ago', day: '2026-10-01', order: 1 })
  const due = mk({ title: 'deadline tomorrow', deadline: '2026-11-03', order: 2 })
  assert.deepEqual(titles(rankTasks([late, due], D)), ['deadline tomorrow', 'scheduled long ago'])
})

test('priority: a new urgent task outranks older low-priority tasks', () => {
  const old = mk({ title: 'old low', priority: 'low', day: '2026-10-20', createdAt: 1, order: 1 })
  const urgent = mk({ title: 'new urgent', priority: 'high', urgency: 'high', createdAt: 99, order: 9 })
  assert.deepEqual(titles(rankTasks([old, urgent], D)), ['new urgent', 'old low'])
})

test('priority: stable, deterministic tie-breaking regardless of input order', () => {
  const tasks = Array.from({ length: 12 }, (_, i) => mk({ id: `t${i}`, title: `T${i}`, order: i % 3, createdAt: i % 2, priority: i % 4 === 0 ? 'high' : undefined }))
  const first = titles(rankTasks(tasks, D))
  for (let k = 0; k < 20; k++) {
    const shuffled = [...tasks].sort(() => Math.random() - 0.5)
    assert.deepEqual(titles(rankTasks(shuffled, D)), first)
  }
})

test('priority: pinned first (newest pin first), "Later" last until tomorrow', () => {
  let s = run([{ type: 'add', title: 'A', priority: 'high' }, { type: 'add', title: 'B' }, { type: 'add', title: 'C', priority: 'low' }])
  s = reduce(s, { type: 'toTop', id: idOf(s, 'C') }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['C', 'A', 'B'])
  s = reduce(s, { type: 'toTop', id: idOf(s, 'B') }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['B', 'C', 'A'])
  s = reduce(s, { type: 'later', id: idOf(s, 'B') }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['C', 'A', 'B'], 'later unpins and sends to the end')
  s = reduce(s, { type: 'autoOrder', id: idOf(s, 'C') }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['A', 'C', 'B'], 'automatic order drops the pin')
})

test('priority: "Later" lasts only for today', () => {
  let s = run([{ type: 'add', title: 'Urgent', priority: 'high' }, { type: 'add', title: 'Other' }])
  s = reduce(s, { type: 'later', id: idOf(s, 'Urgent') }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['Other', 'Urgent'])
  assert.deepEqual(titles(nowQueue(s, addDays(D, 1))), ['Urgent', 'Other'], 'back to its score the next day')
  assert.equal(s.tasks.find((t) => t.title === 'Urgent')!.day, D, 'date untouched')
})

test('priority: manual ↑/↓ moves exactly one step, across score levels, and persist', () => {
  let s = run([{ type: 'add', title: 'High', priority: 'high' }, { type: 'add', title: 'Mid' }, { type: 'add', title: 'Low', priority: 'low' }])
  assert.deepEqual(titles(nowQueue(s, D)), ['High', 'Mid', 'Low'])
  s = reduce(s, { type: 'move', id: idOf(s, 'Low'), dir: -1 }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['High', 'Low', 'Mid'])
  s = reduce(s, { type: 'move', id: idOf(s, 'Low'), dir: -1 }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['Low', 'High', 'Mid'])
  s = reduce(s, { type: 'move', id: idOf(s, 'High'), dir: 1 }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['Low', 'Mid', 'High'])
  const m = mem()
  save(m, s)
  assert.deepEqual(titles(nowQueue(load(m), D)), ['Low', 'Mid', 'High'], 'manual order survives reload')
  // Edge: moving the first up / last down is a no-op
  assert.equal(reduce(s, { type: 'move', id: idOf(s, 'Low'), dir: -1 }, D).tasks, s.tasks)
})

test('priority: manual move is a delta, so a later deadline still raises the task', () => {
  let s = run([{ type: 'add', title: 'A' }, { type: 'add', title: 'B' }])
  s = reduce(s, { type: 'move', id: idOf(s, 'A'), dir: 1 }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['B', 'A'])
  s = reduce(s, { type: 'update', id: idOf(s, 'A'), patch: { deadline: D } }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['A', 'B'], 'recalculated after an edit')
})

test('priority: postponing and date changes recalculate', () => {
  let s = run([{ type: 'add', title: 'A', priority: 'high' }, { type: 'add', title: 'B' }])
  s = reduce(s, { type: 'tomorrow', id: idOf(s, 'A') }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['B'])
  s = reduce(s, { type: 'moveTo', id: idOf(s, 'A'), day: '2026-10-30' }, D)
  assert.deepEqual(titles(nowQueue(s, D)), ['A', 'B'])
})

// ---------- Feature 3: 7-day counts

test('7-day strip: today + 6 days, today includes overdue, completed excluded', () => {
  let s = run([
    { type: 'add', title: 'Old', day: '2026-10-29' }, { type: 'add', title: 'T' }, { type: 'add', title: 'Tue', day: '2026-11-03' },
    { type: 'add', title: 'Sun', day: '2026-11-08' }, { type: 'add', title: 'Far', day: '2026-11-09' }, { type: 'add', title: 'Done', day: '2026-11-03' },
  ])
  s = reduce(s, { type: 'complete', id: idOf(s, 'Done') }, D)
  const w = weekCounts(s, D)
  assert.equal(w.length, 7)
  assert.deepEqual(w.map((x) => x.day), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08'])
  assert.deepEqual(w.map((x) => x.open), [2, 1, 0, 0, 0, 0, 1])
  assert.equal(w[0].overdue, 1)
  assert.equal(weekCounts(s, '2026-12-29').at(-1)!.day, '2027-01-04', 'crosses the year')
})

// ---------- imports (full plan v2 + compatibility)

const pt = (key: string, title: string, extra: Partial<FullPlanTask> = {}): FullPlanTask => ({
  key, title, notes: null, priority: 'medium', urgency: 'medium', importance: 'medium', deadline: null, category: null, when: 'today', day: null, status: 'open', ...extra,
})
const plan2 = (tasks: FullPlanTask[], date = D): FullPlan => ({ next_full_plan: 2, date, tasks, ideas: [] })
const paste = (s: State, p: FullPlan, today = D) => {
  const parsed = parseFullPlan(JSON.stringify(p), today)
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.errors.join(' | '))
  return applyFullPlan(s, parsed.plan, parsed.hash, {}, today)
}

test('plan v2: urgency/importance are validated, stored and used for ranking', () => {
  const bad = parseFullPlan(JSON.stringify(plan2([{ ...pt('a', 'A'), urgency: 'extreme' as never }])), D)
  assert.ok(!bad.ok && bad.errors.join().includes('"urgency"'))
  const missing = parseFullPlan(JSON.stringify(plan2([(({ urgency: _u, ...rest }) => rest)(pt('a', 'A')) as FullPlanTask])), D)
  assert.ok(!missing.ok && missing.errors.join().includes('missing "urgency"'))
  const s = paste(emptyState(), plan2([pt('calm', 'Calm', { urgency: 'low', importance: 'low' }), pt('fire', 'Fire', { urgency: 'high', importance: 'high' })]))
  assert.deepEqual(titles(nowQueue(s, D)), ['Fire', 'Calm'])
  assert.equal(s.tasks.find((t) => t.key === 'fire')!.urgency, 'high')
  const s2 = paste(s, plan2([pt('calm', 'Calm', { urgency: 'high', importance: 'high' }), pt('fire', 'Fire', { urgency: 'low', importance: 'low' })]))
  assert.deepEqual(titles(nowQueue(s2, D)), ['Calm', 'Fire'], 'recalculated after import')
})

test('plan v1 is still accepted (compatibility)', () => {
  const v1 = { next_full_plan: 1, date: D, tasks: [{ key: 'a', title: 'A', notes: null, priority: 'high', deadline: null, category: null, when: 'today', day: null, status: 'open' }], ideas: [] }
  const r = parseFullPlan(JSON.stringify(v1), D)
  assert.ok(r.ok)
  const s = applyFullPlan(emptyState(), r.plan, r.hash, {}, D)
  assert.equal(s.tasks[0].urgency, undefined)
  const v1WithV2Field = { ...v1, tasks: [{ ...v1.tasks[0], urgency: 'high' }] }
  assert.ok(!parseFullPlan(JSON.stringify(v1WithV2Field), D).ok, 'v1 stays strict')
})

test('import: an overdue task that the plan keeps "today" keeps its original date; duplicates are idempotent', () => {
  let s = paste(emptyState(), plan2([pt('a', 'A')], '2026-10-30'), '2026-10-30')
  const id = s.tasks[0].id
  s = paste(s, plan2([pt('a', 'A'), pt('b', 'B')]))
  assert.equal(s.tasks.find((t) => t.id === id)!.day, '2026-10-30', 'not rewritten to today')
  assert.equal(s.tasks.length, 2)
  const again = paste(s, plan2([pt('a', 'A'), pt('b', 'B')]))
  assert.equal(again, s, 'same plan twice is a no-op')
  const forgotten = paste({ ...s, applied: [] }, plan2([pt('a', 'A'), pt('b', 'B')]))
  assert.equal(forgotten.tasks.length, 2, 'never duplicated')
})

test('import keeps pins, manual moves and the stable task ID (photo associations)', () => {
  let s = paste(emptyState(), plan2([pt('a', 'A'), pt('b', 'B', { priority: 'high' })]))
  const idA = s.tasks.find((t) => t.key === 'a')!.id
  s = reduce(s, { type: 'toTop', id: idA }, D)
  s = paste(s, plan2([pt('a', 'A renamed'), pt('b', 'B', { priority: 'high' }), pt('c', 'C')]))
  const a = s.tasks.find((t) => t.key === 'a')!
  assert.equal(a.id, idA)
  assert.equal(a.title, 'A renamed')
  assert.equal(nowQueue(s, D)[0].id, idA, 'still pinned')
})

test('advanced snapshot includes overdue tasks', () => {
  const s = run([{ type: 'add', title: 'Old', day: '2026-10-30' }])
  const p = buildPlan(s, D)
  assert.equal(p.tasks[0].when, 'today')
  assert.equal(p.tasks[0].overdue_since, '2026-10-30')
})

// ---------- Feature 4: handover

const handoverState = () => {
  let s = run([
    { type: 'add', title: 'Betal faktura', notes: 'Beløb og reference på billedet', deadline: '2026-11-04', priority: 'high' },
    { type: 'add', title: 'Gammel opgave', day: '2026-10-28' },
    { type: 'add', title: 'Fremtid', day: '2026-11-10' },
    { type: 'add', title: 'Færdig' },
    { type: 'add', title: 'Slettet' },
    { type: 'capture', text: 'Lære guitar' },
  ])
  s = reduce(s, { type: 'complete', id: idOf(s, 'Færdig') }, D)
  s = reduce(s, { type: 'remove', id: idOf(s, 'Slettet') }, D)
  return s
}
const snapshotOf = (text: string) => JSON.parse(text.slice(text.indexOf('{\n  "next_handover"'), text.lastIndexOf('}') + 1))
const NOW = new Date(2026, 10, 2, 9, 15)

test('handover: versioned, self-contained, with schema, rules, rollover, date and timezone', () => {
  const text = withTZ('Europe/Copenhagen', () => buildHandover(handoverState(), NOW, D))
  for (const s of ['NEXT-HANDOVER v1', 'next_full_plan 2', '"urgency"', '"importance"', 'Opfind aldrig', 'påmindelser', 'Dagsskifte', `+${WEIGHTS.deadlineOverdue}`, `+${WEIGHTS.overdueMax}`, 'Europe/Copenhagen', 'UTC+01:00', D, 'mandag', 'NEXT-plan']) {
    assert.ok(text.includes(s), s)
  }
  const snap = snapshotOf(text)
  assert.equal(snap.next_handover, 1)
  assert.equal(snap.timezone, 'Europe/Copenhagen')
})

test('handover: task snapshot is faithful (ids, statuses, overdue, tombstones, ideas)', () => {
  const s = handoverState()
  const snap = snapshotOf(buildHandover(s, NOW, D))
  const by = (title: string) => snap.tasks.find((t: { title: string }) => t.title === title)
  assert.equal(by('Betal faktura').key, idOf(s, 'Betal faktura'), 'NEXT ID used as key when ChatGPT has none')
  assert.equal(by('Betal faktura').deadline, '2026-11-04')
  assert.equal(by('Gammel opgave').overdue, true)
  assert.equal(by('Gammel opgave').scheduled, '2026-10-28')
  assert.equal(by('Fremtid').status, 'open')
  assert.equal(by('Færdig').status, 'done')
  assert.equal(by('Slettet').status, 'cancelled', 'deleted tasks listed to prevent re-creation')
  assert.deepEqual(snap.ideas, ['Lære guitar'])
  assert.equal(snap.counts.open, 3)
  assert.equal(snap.tasks[0].title, 'Betal faktura', 'open tasks in NEXT order')
})

test('handover → new chat → plan with the same keys updates, never re-creates', () => {
  const s = handoverState()
  const snap = snapshotOf(buildHandover(s, NOW, D))
  const tasks = snap.tasks.map((t: { key: string; title: string; status: 'open' | 'done' | 'cancelled' }) => pt(t.key, t.title, { status: t.status }))
  const r = reconcile(s, plan2(tasks), D)
  assert.ok(r.ok)
  assert.equal(r.counts.added, 0)
  assert.equal(r.state.tasks.length, s.tasks.length)
  assert.equal(r.state.tasks.find((t) => t.title === 'Slettet')!.cancelled, true)
  assert.equal(r.state.tasks.find((t) => t.title === 'Gammel opgave')!.day, '2026-10-28')
})

test('handover example plan is itself valid JSON for import', () => {
  const text = buildHandover(handoverState(), NOW, D)
  const ex = text.slice(text.indexOf('Eksempel:\n') + 10, text.indexOf('\n\nJSON-skema'))
  assert.ok(parseFullPlan(ex, D).ok)
})

test('handover and exports never include attachment data, even if a task object carried it', () => {
  const s = handoverState()
  const leaky = { ...s, tasks: s.tasks.map((t) => ({ ...t, attachments: [{ filename: 'faktura-IMG_4411.jpg', url: 'blob:https://x/1', data: 'data:image/jpeg;base64,AAAA' }] })) } as State
  const outputs = [buildHandover(leaky, NOW, D), JSON.stringify(buildPlan(leaky, D)), JSON.stringify(snapshotTasks(leaky, D))]
  for (const out of outputs) {
    for (const bad of ['IMG_4411', 'blob:', 'data:image', 'attachments', '.jpg']) assert.ok(!out.includes(bad), bad)
  }
})

test('sensitive-content hints', () => {
  assert.deepEqual(sensitiveHints('Ring til mor'), [])
  assert.ok(sensitiveHints('CPR 010190-1234').length)
  assert.ok(sensitiveHints('Konto DK50 0040 0440 1162 43').length)
  assert.ok(sensitiveHints('mail jens@example.com').length)
  assert.ok(sensitiveHints('MitID kode').length)
})

// ---------- Feature 5: attachment helpers and data safety

test('photo resize keeps aspect ratio and never upscales', () => {
  assert.deepEqual(fitWithin(4032, 3024), { width: 1600, height: 1200 })
  assert.deepEqual(fitWithin(3024, 4032), { width: 1200, height: 1600 })
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600 })
})

test('storage errors map to readable kinds (quota, unavailable)', () => {
  assert.equal(toPhotoError({ name: 'QuotaExceededError' }).kind, 'quota')
  assert.equal(toPhotoError({ name: 'InvalidStateError' }).kind, 'unavailable')
  assert.equal(toPhotoError(new Error('x')).kind, 'failed')
  const e = new PhotoError('unsupported', 'm')
  assert.equal(toPhotoError(e), e)
})

test('V1 data loads unchanged; new fields are validated; storage key unchanged', () => {
  const v1 = { rev: 5, seq: 2, applied: [], categories: ['Work'], thoughts: [], tasks: [
    { id: 't1', title: 'A', notes: '', category: '', day: '2026-10-30', order: 1, done: false, createdAt: 1 },
    { id: 't2', title: 'B', notes: '', category: '', day: D, order: 1, done: false, createdAt: 2, pinnedAt: 'x', urgency: 'mega', laterOn: 'nope', adjust: 3 },
  ] }
  const m = mem()
  m.setItem('next.v1', JSON.stringify(v1))
  const s = load(m)
  assert.deepEqual(s.tasks[0], v1.tasks[0])
  assert.equal(s.tasks[1].pinnedAt, undefined)
  assert.equal(s.tasks[1].urgency, undefined)
  assert.equal(s.tasks[1].laterOn, undefined)
  assert.equal(s.tasks[1].adjust, 3)
  assert.deepEqual(titles(nowQueue(s, D)).sort(), ['A', 'B'])
})
