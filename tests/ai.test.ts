import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildPrompt } from '../src/ai/prompt.ts'
import { extractWith } from '../src/ai/provider.ts'
import type { DirectProvider } from '../src/ai/provider.ts'
import { buildReview, isSimilar, normalize, toImport } from '../src/ai/review.ts'
import { AI_OUTPUT_SCHEMA, parseAiOutput } from '../src/ai/schema.ts'
import type { AiOutput } from '../src/ai/schema.ts'
import { emptyState, load, queue, reduce, save } from '../src/store.ts'
import type { KeyValueStore, State } from '../src/store.ts'

const TODAY = '2026-10-31' // a Saturday
const valid: AiOutput = {
  version: 1,
  tasks: [
    { title: 'Køb mælk', notes: null, priority: 'low', deadline: null, category: 'Errands', when: 'today' },
    { title: 'Ring til tandlægen', notes: 'Nummer på køleskabet', priority: 'high', deadline: '2026-11-06', category: 'Health', when: 'today' },
    { title: 'Forny pas', notes: null, priority: 'medium', deadline: null, category: 'Papirer', when: 'tomorrow' },
    { title: 'Rydde op i garagen', notes: null, priority: 'low', deadline: null, category: null, when: 'later' },
  ],
  ideas: [{ text: 'Lære at spille guitar' }],
}

// ---- schema / validation

test('accepts valid output, also inside ```json fences with chat prose around it', () => {
  assert.equal(parseAiOutput(JSON.stringify(valid)).ok, true)
  const chatty = `Her er dine opgaver:\n\`\`\`json\n${JSON.stringify(valid, null, 2)}\n\`\`\`\nHeld og lykke!`
  const r = parseAiOutput(chatty)
  assert.ok(r.ok)
  assert.equal(r.data.tasks[1].title, 'Ring til tandlægen')
})

test('rejects missing fields, unknown fields, bad enums, bad dates and wrong version', () => {
  const bad = {
    version: 2,
    tasks: [
      { title: '', notes: null, priority: 'urgent', deadline: '2026-02-30', category: null, when: 'today', extra: 1 },
      { title: 'Ok', priority: 'low', deadline: '06/11/2026', category: null, when: 'soon' },
    ],
    ideas: [{ text: 'x', mood: 'happy' }],
  }
  const r = parseAiOutput(JSON.stringify(bad))
  assert.equal(r.ok, false)
  const errs = r.ok ? '' : r.errors.join('\n')
  for (const expected of ['version must be 1', 'task 1 title: must not be empty', 'task 1 priority', 'task 1 deadline', 'unknown field "extra"',
    'task 2: missing "notes"', 'task 2 deadline', 'task 2 when', 'idea 1: unknown field "mood"']) {
    assert.ok(errs.includes(expected), `expected error containing: ${expected}\n${errs}`)
  }
})

test('rejects non-JSON and non-object answers with readable messages', () => {
  assert.deepEqual(parseAiOutput('Beklager, det kan jeg ikke.'), { ok: false, errors: ['No JSON object found. Paste the whole answer from the AI.'] })
  const r = parseAiOutput('{ "version": 1, tasks: [] }')
  assert.ok(!r.ok && r.errors[0].startsWith('Not valid JSON'))
})

test('schema object follows strict-mode rules (all properties required, no extra keys)', () => {
  const task = AI_OUTPUT_SCHEMA.properties.tasks.items
  assert.deepEqual([...task.required].sort(), Object.keys(task.properties).sort())
  assert.equal(task.additionalProperties, false)
  assert.equal(AI_OUTPUT_SCHEMA.additionalProperties, false)
})

// ---- prompt

test('prompt is Danish, includes today with weekday, categories, schema and the dump', () => {
  const p = buildPrompt({ text: '  ring til tandlægen inden fredag  ', today: TODAY, categories: ['Work', 'Health'] })
  assert.ok(p.includes('lørdag 2026-10-31'))
  assert.ok(p.includes('Work, Health'))
  assert.ok(p.includes('"additionalProperties":false'))
  assert.ok(p.includes('"""\nring til tandlægen inden fredag\n"""'))
})

// ---- provider interface

test('direct providers plug into the same validation pipeline', async () => {
  const fake: DirectProvider = { kind: 'direct', id: 'fake', name: 'Fake', complete: async (prompt) => (prompt.includes('mælk') ? JSON.stringify(valid) : '') }
  const ok = await extractWith(fake, { text: 'køb mælk', today: TODAY, categories: [] })
  assert.ok(ok.ok)
  const failing: DirectProvider = { kind: 'direct', id: 'down', name: 'Down', complete: async () => { throw new Error('offline') } }
  assert.deepEqual(await extractWith(failing, { text: 'x', today: TODAY, categories: [] }), { ok: false, errors: ['Down failed: offline'] })
})

// ---- duplicates

test('normalize keeps Danish letters and drops punctuation/case', () => {
  assert.equal(normalize('  Ring til TANDLÆGEN!! '), 'ring til tandlægen')
})

test('isSimilar: exact, contained, mostly same words; not unrelated', () => {
  assert.ok(isSimilar('Køb mælk.', 'køb mælk'))
  assert.ok(isSimilar('Ring til tandlægen', 'Ring til tandlægen i morgen'))
  assert.ok(isSimilar('forny mit pas nu', 'Forny pas nu mit'))
  assert.ok(!isSimilar('Køb mælk', 'Køb brød'))
  assert.ok(!isSimilar('Ring til mor', 'Ring til tandlægen'))
})

test('review flags duplicates against tasks, thoughts and within the batch; unchecks them', () => {
  let s: State = emptyState()
  s = reduce(s, { type: 'add', title: 'Køb mælk' }, TODAY)
  s = reduce(s, { type: 'capture', text: 'lære at spille guitar' }, TODAY)
  const out: AiOutput = { ...valid, tasks: [...valid.tasks, { ...valid.tasks[1], title: 'Ring til tandlægen!' }] }
  const items = buildReview(out, s, TODAY)
  const byTitle = (t: string) => items.find((i) => i.title === t)!
  assert.equal(byTitle('Køb mælk').duplicateOf, 'Køb mælk')
  assert.equal(byTitle('Køb mælk').include, false)
  assert.equal(byTitle('Lære at spille guitar').duplicateOf, 'lære at spille guitar')
  assert.equal(byTitle('Ring til tandlægen!').duplicateOf, 'Ring til tandlægen')
  assert.equal(byTitle('Ring til tandlægen').include, true)
  assert.equal(byTitle('Rydde op i garagen').destination, 'inbox', '"later" defaults to Inbox')
  assert.equal(byTitle('Forny pas').destination, 'tomorrow')
})

// ---- import into the store

test('import: urgent first, tomorrow scheduled, later → inbox, new categories, persists', () => {
  let s: State = emptyState()
  s = reduce(s, { type: 'add', title: 'Eksisterende opgave' }, TODAY)
  const items = buildReview(valid, s, TODAY)
  s = reduce(s, { type: 'import', ...toImport(items, TODAY) }, TODAY)

  assert.deepEqual(queue(s, TODAY).map((t) => t.title), ['Eksisterende opgave', 'Ring til tandlægen', 'Køb mælk'])
  const dentist = s.tasks.find((t) => t.title === 'Ring til tandlægen')!
  assert.equal(dentist.priority, 'high')
  assert.equal(dentist.deadline, '2026-11-06')
  assert.equal(dentist.notes, 'Nummer på køleskabet')
  assert.deepEqual(queue(s, '2026-11-01').map((t) => t.title), ['Forny pas'])
  assert.deepEqual(s.thoughts.map((t) => t.text), ['Rydde op i garagen', 'Lære at spille guitar'])
  assert.ok(s.categories.includes('Papirer'))

  const mem = new Map<string, string>()
  const store: KeyValueStore = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v) }
  save(store, s)
  assert.deepEqual(load(store), s)
})

test('older saved data without priority/deadline still loads; invalid values are dropped', () => {
  const mem = new Map<string, string>()
  mem.set('next.v1', JSON.stringify({ tasks: [
    { id: 'a', title: 'Gammel', day: TODAY, order: 1 },
    { id: 'b', title: 'Forkert', day: TODAY, order: 2, priority: 'urgent', deadline: 'fredag' },
  ] }))
  const s = load({ getItem: (k) => mem.get(k) ?? null, setItem: () => {} })
  assert.equal(s.tasks.length, 2)
  assert.equal('priority' in s.tasks[1], false)
  assert.equal('deadline' in s.tasks[1], false)
})
