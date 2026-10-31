// The contract between NEXT and any AI provider: the JSON a model must return.
// AI_OUTPUT_SCHEMA follows the rules of OpenAI "structured outputs" strict mode
// (every field required, nulls instead of optional, no extra keys), so it can be
// passed to an API unchanged later. parseAiOutput enforces the same rules locally,
// because a model can still return anything when used through copy/paste.

import type { Priority } from '../store.ts'
import { PRIORITIES } from '../store.ts'

export const SCHEMA_VERSION = 1

export type When = 'today' | 'tomorrow' | 'later'
export const WHEN_VALUES: When[] = ['today', 'tomorrow', 'later']

export type AiTask = {
  title: string
  notes: string | null
  priority: Priority
  deadline: string | null // YYYY-MM-DD
  category: string | null
  when: When
}
export type AiIdea = { text: string }
export type AiOutput = { version: typeof SCHEMA_VERSION; tasks: AiTask[]; ideas: AiIdea[] }

export const LIMITS = { title: 120, notes: 500, category: 30, idea: 500, items: 50 }

const nullable = (schema: object) => ({ anyOf: [schema, { type: 'null' }] })

export const AI_OUTPUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'NEXT brain dump v1',
  type: 'object',
  additionalProperties: false,
  required: ['version', 'tasks', 'ideas'],
  properties: {
    version: { type: 'integer', enum: [SCHEMA_VERSION] },
    tasks: {
      type: 'array',
      maxItems: LIMITS.items,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'notes', 'priority', 'deadline', 'category', 'when'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: LIMITS.title, description: 'Short, concrete action in Danish, starting with a verb' },
          notes: nullable({ type: 'string', maxLength: LIMITS.notes }),
          priority: { type: 'string', enum: PRIORITIES },
          deadline: nullable({ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'Only if a date or weekday is mentioned' }),
          category: nullable({ type: 'string', maxLength: LIMITS.category }),
          when: { type: 'string', enum: WHEN_VALUES },
        },
      },
    },
    ideas: {
      type: 'array',
      maxItems: LIMITS.items,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1, maxLength: LIMITS.idea } },
      },
    },
  },
} as const

export type ParseResult = { ok: true; data: AiOutput } | { ok: false; errors: string[] }

/** Pulls the JSON object out of a chat reply that may include ```json fences or extra prose. */
export function extractJson(raw: string): string | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  return start >= 0 && end > start ? body.slice(start, end + 1) : null
}

const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, errors: string[]) {
  for (const k of allowed) if (!(k in obj)) errors.push(`${path}: missing "${k}"`)
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) errors.push(`${path}: unknown field "${k}"`)
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function checkString(v: unknown, path: string, max: number, errors: string[], nullableField = false) {
  if (v === null && nullableField) return
  if (typeof v !== 'string') return void errors.push(`${path}: must be ${nullableField ? 'text or null' : 'text'}`)
  if (!nullableField && !v.trim()) errors.push(`${path}: must not be empty`)
  if (v.length > max) errors.push(`${path}: longer than ${max} characters`)
}

/** Strictly validates AI output against the v1 schema. Returns readable errors instead of throwing. */
export function parseAiOutput(raw: string): ParseResult {
  const json = extractJson(raw)
  if (!json) return { ok: false, errors: ['No JSON object found. Paste the whole answer from the AI.'] }
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch (e) {
    return { ok: false, errors: [`Not valid JSON (${(e as Error).message}).`] }
  }
  const errors: string[] = []
  if (!isObj(data)) return { ok: false, errors: ['Top level must be a JSON object.'] }
  checkKeys(data, ['version', 'tasks', 'ideas'], 'root', errors)
  if ('version' in data && data.version !== SCHEMA_VERSION) errors.push(`root: version must be ${SCHEMA_VERSION}`)

  const tasks = Array.isArray(data.tasks) ? data.tasks : (errors.push('tasks: must be a list'), [])
  const ideas = Array.isArray(data.ideas) ? data.ideas : (errors.push('ideas: must be a list'), [])
  if (tasks.length > LIMITS.items) errors.push(`tasks: more than ${LIMITS.items} items`)
  if (ideas.length > LIMITS.items) errors.push(`ideas: more than ${LIMITS.items} items`)

  tasks.forEach((t: unknown, i: number) => {
    const p = `task ${i + 1}`
    if (!isObj(t)) return void errors.push(`${p}: must be an object`)
    checkKeys(t, ['title', 'notes', 'priority', 'deadline', 'category', 'when'], p, errors)
    checkString(t.title, `${p} title`, LIMITS.title, errors)
    checkString(t.notes, `${p} notes`, LIMITS.notes, errors, true)
    checkString(t.category, `${p} category`, LIMITS.category, errors, true)
    if (!PRIORITIES.includes(t.priority as Priority)) errors.push(`${p} priority: must be one of ${PRIORITIES.join(', ')}`)
    if (!WHEN_VALUES.includes(t.when as When)) errors.push(`${p} when: must be one of ${WHEN_VALUES.join(', ')}`)
    if (t.deadline !== null && !(typeof t.deadline === 'string' && isRealDate(t.deadline))) errors.push(`${p} deadline: must be a real date YYYY-MM-DD or null`)
  })
  ideas.forEach((idea: unknown, i: number) => {
    const p = `idea ${i + 1}`
    if (!isObj(idea)) return void errors.push(`${p}: must be an object`)
    checkKeys(idea, ['text'], p, errors)
    checkString(idea.text, `${p} text`, LIMITS.idea, errors)
  })

  if (errors.length) return { ok: false, errors }
  const clean = (s: string | null) => (s === null ? null : s.trim() || null)
  return {
    ok: true,
    data: {
      version: SCHEMA_VERSION,
      tasks: (tasks as AiTask[]).map((t) => ({ ...t, title: t.title.trim(), notes: clean(t.notes), category: clean(t.category) })),
      ideas: (ideas as AiIdea[]).map((i) => ({ text: i.text.trim() })),
    },
  }
}
