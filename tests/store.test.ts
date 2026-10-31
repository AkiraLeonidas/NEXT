import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Action, KeyValueStore, State } from '../src/store.ts'
import { STORAGE_KEY, addDays, emptyState, load, nowQueue, progress, queue, reduce, save } from '../src/store.ts'

const TODAY = '2026-10-31'
const run = (actions: Action[], start: State = emptyState(), today = TODAY) =>
  actions.reduce((s, a) => reduce(s, a, today), start)
const titles = (s: State, day = TODAY) => queue(s, day).map((t) => t.title)
const idOf = (s: State, title: string) => s.tasks.find((t) => t.title === title)!.id

const memoryStore = (): KeyValueStore & { data: Map<string, string> } => {
  const data = new Map<string, string>()
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }
}

const abc = () => run([{ type: 'add', title: 'A' }, { type: 'add', title: 'B' }, { type: 'add', title: 'C' }])

test('add creates tasks in order and ignores blank titles', () => {
  const s = run([{ type: 'add', title: '  A ' }, { type: 'add', title: '   ' }, { type: 'add', title: 'B' }])
  assert.deepEqual(titles(s), ['A', 'B'])
})

test('done advances to the next task and updates progress', () => {
  let s = abc()
  s = reduce(s, { type: 'complete', id: idOf(s, 'A') }, TODAY)
  assert.equal(queue(s, TODAY)[0].title, 'B')
  assert.deepEqual(progress(s, TODAY), { done: 1, total: 3 })
})

test('later moves the current task to the end of the queue', () => {
  let s = abc()
  s = reduce(s, { type: 'later', id: idOf(s, 'A') }, TODAY)
  assert.deepEqual(titles(s), ['B', 'C', 'A'])
})

test('reorder up/down and "do now"', () => {
  let s = abc()
  s = reduce(s, { type: 'move', id: idOf(s, 'C'), dir: -1 }, TODAY)
  assert.deepEqual(titles(s), ['A', 'C', 'B'])
  s = reduce(s, { type: 'move', id: idOf(s, 'A'), dir: -1 }, TODAY) // already first: no-op
  assert.deepEqual(titles(s), ['A', 'C', 'B'])
  s = reduce(s, { type: 'toTop', id: idOf(s, 'B') }, TODAY)
  assert.deepEqual(titles(s), ['B', 'A', 'C'])
})

test('undo after done puts the task back on top', () => {
  let s = abc()
  s = reduce(s, { type: 'complete', id: idOf(s, 'A') }, TODAY)
  s = reduce(s, { type: 'toTop', id: idOf(s, 'A') }, TODAY)
  assert.deepEqual(titles(s), ['A', 'B', 'C'])
  assert.deepEqual(progress(s, TODAY), { done: 0, total: 3 })
})

test('move to tomorrow; next day unfinished tasks are actionable without changing their dates', () => {
  let s = abc()
  s = reduce(s, { type: 'tomorrow', id: idOf(s, 'A') }, TODAY)
  s = reduce(s, { type: 'complete', id: idOf(s, 'B') }, TODAY)
  assert.deepEqual(titles(s), ['C'])
  const tomorrow = addDays(TODAY, 1)
  // C is overdue by one day (+2), so it comes before A.
  assert.deepEqual(nowQueue(s, tomorrow).map((t) => t.title), ['C', 'A'])
  assert.equal(s.tasks.find((t) => t.title === 'C')!.day, TODAY, 'overdue task keeps its date')
  assert.equal(s.tasks.find((t) => t.title === 'B')!.day, TODAY, 'done tasks stay on their day')
})

test('details: edit title/notes/category; empty title is rejected', () => {
  let s = abc()
  const id = idOf(s, 'A')
  s = run([
    { type: 'update', id, patch: { title: 'Write intro', notes: 'first paragraph', category: 'Work' } },
    { type: 'update', id, patch: { title: '   ' } },
    { type: 'addCategory', name: 'Study' },
    { type: 'addCategory', name: 'study' },
  ], s)
  const t = s.tasks.find((x) => x.id === id)!
  assert.equal(t.title, 'Write intro')
  assert.equal(t.notes, 'first paragraph')
  assert.equal(t.category, 'Work')
  assert.equal(s.categories.filter((c) => c.toLowerCase() === 'study').length, 1)
})

test('quick capture: thought → task, and clearing a thought', () => {
  let s = run([{ type: 'capture', text: 'Call dentist' }, { type: 'capture', text: 'Idea' }, { type: 'capture', text: '  ' }])
  assert.equal(s.thoughts.length, 2)
  s = reduce(s, { type: 'thoughtToTask', id: s.thoughts.find((t) => t.text === 'Call dentist')!.id }, TODAY)
  s = reduce(s, { type: 'dropThought', id: s.thoughts[0].id }, TODAY)
  assert.deepEqual(titles(s), ['Call dentist'])
  assert.equal(s.thoughts.length, 0)
})

test('delete removes a task', () => {
  let s = abc()
  s = reduce(s, { type: 'remove', id: idOf(s, 'B') }, TODAY)
  assert.deepEqual(titles(s), ['A', 'C'])
})

test('persistence: save then load restores identical state (simulated restart)', () => {
  const store = memoryStore()
  let s = abc()
  s = run([{ type: 'complete', id: idOf(s, 'A') }, { type: 'capture', text: 'parked' }], s)
  assert.equal(save(store, s), true)
  const restored = load(store)
  assert.deepEqual(restored, s)
  assert.deepEqual(titles(restored), ['B', 'C'])
})

test('persistence: corrupt or partial data never crashes', () => {
  const store = memoryStore()
  store.data.set(STORAGE_KEY, '{not json')
  assert.deepEqual(load(store), emptyState())
  store.data.set(STORAGE_KEY, JSON.stringify({ tasks: [{ id: 'x', title: 'ok', day: TODAY, order: 1 }, { bad: true }, null] }))
  const s = load(store)
  assert.deepEqual(titles(s), ['ok'])
  assert.ok(s.categories.length > 0)
})

test('persistence: save reports failure instead of throwing', () => {
  const full: KeyValueStore = { getItem: () => null, setItem: () => { throw new Error('QuotaExceededError') } }
  assert.equal(save(full, emptyState()), false)
})

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
})
