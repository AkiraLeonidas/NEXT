// Turns validated AI output into reviewable items, flags duplicates, and builds the import.
import type { NewTask, State } from '../store.ts'
import { addDays } from '../store.ts'
import type { AiOutput, AiTask } from './schema.ts'

export type Destination = 'today' | 'tomorrow' | 'inbox'

export type ReviewItem = {
  key: string
  kind: 'task' | 'idea'
  title: string
  task?: AiTask
  destination: Destination
  include: boolean
  duplicateOf?: string // title of the existing (or earlier) item it matches
}

/** Lowercase, strip punctuation (keeps æøå and other letters), collapse spaces. */
export function normalize(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
}

const words = (s: string) => new Set(normalize(s).split(' ').filter((w) => w.length > 1))

/** Same after normalizing, one contains the other, or mostly the same words. */
export function isSimilar(a: string, b: string): boolean {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return false
  if (na === nb) return true
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na]
  if (short.length >= 8 && long.includes(short)) return true
  const wa = words(a)
  const wb = words(b)
  const shared = [...wa].filter((w) => wb.has(w)).length
  return wa.size >= 2 && wb.size >= 2 && shared / new Set([...wa, ...wb]).size >= 0.75
}

/** Builds review items; duplicates are flagged and unchecked by default. */
export function buildReview(output: AiOutput, state: State, today: string): ReviewItem[] {
  // Compare against open tasks, tasks finished today, and parked thoughts.
  const existing = [
    ...state.tasks.filter((t) => !t.cancelled && (!t.done || t.day === today)).map((t) => t.title),
    ...state.thoughts.map((t) => t.text),
  ]
  const seen: string[] = []
  const findDup = (title: string) => existing.find((e) => isSimilar(e, title)) ?? seen.find((e) => isSimilar(e, title))

  const items: ReviewItem[] = []
  output.tasks.forEach((task, i) => {
    const duplicateOf = findDup(task.title)
    items.push({
      key: `t${i}`,
      kind: 'task',
      title: task.title,
      task,
      destination: task.when === 'later' ? 'inbox' : task.when,
      include: !duplicateOf,
      duplicateOf,
    })
    seen.push(task.title)
  })
  output.ideas.forEach((idea, i) => {
    const duplicateOf = findDup(idea.text)
    items.push({ key: `i${i}`, kind: 'idea', title: idea.text, destination: 'inbox', include: !duplicateOf, duplicateOf })
    seen.push(idea.text)
  })
  return items
}

/** Converts the user's reviewed choices into a store import. */
export function toImport(items: ReviewItem[], today: string): { tasks: NewTask[]; ideas: string[] } {
  const tasks: NewTask[] = []
  const ideas: string[] = []
  for (const item of items) {
    if (!item.include) continue
    if (item.destination === 'inbox') {
      ideas.push(item.task?.notes ? `${item.title}: ${item.task.notes}` : item.title)
      continue
    }
    const t = item.task
    tasks.push({
      title: item.title,
      notes: t?.notes ?? undefined,
      category: t?.category ?? undefined,
      priority: t?.priority,
      deadline: t?.deadline ?? undefined,
      day: item.destination === 'tomorrow' ? addDays(today, 1) : today,
    })
  }
  return { tasks, ideas }
}
