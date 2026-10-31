// Deterministic, offline priority engine. Pure functions only (tested with `node --test`).
//
// Queue order, in precedence:
//  1. Pinned tasks ("Do this now"), most recently pinned first.
//  2. Normal tasks, by score (highest first). A manual move stores a score *delta*
//     (`adjust`), so the user's choice survives while deadlines keep counting.
//  3. Tasks sent "Later" today, in the order they were sent. Resets the next day.
// Ties: manual order, then scheduled day, then creation time, then ID. Never random.
//
// `day` is a flexible plan ("scheduled"); `deadline` is a hard deadline. They score differently.

import type { Priority, Task } from './store.ts'

/** Points per signal. Exported so the ChatGPT handover can state the rules that are actually in use. */
export const WEIGHTS = {
  deadlineOverdue: 60,
  deadlineToday: 50,
  deadlineTomorrow: 35,
  deadlineIn3Days: 25,
  deadlineIn7Days: 10,
  priority: { high: 30, medium: 15, low: 0 } as Record<Priority, number>,
  urgency: { high: 20, medium: 10, low: 0 } as Record<Priority, number>,
  importance: { high: 15, medium: 8, low: 0 } as Record<Priority, number>,
  overduePerDay: 2,
  overdueMax: 10,
}

/** Whole calendar days from a to b (YYYY-MM-DD). Uses UTC so DST never adds or loses a day. */
export function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split('-').map(Number)
  const [by, bm, bd] = b.split('-').map(Number)
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000)
}

export type Reason = { label: string; points: number }

/** Score parts with readable labels, for "Why here?" in the task sheet. */
export function explain(t: Task, today: string): Reason[] {
  const r: Reason[] = []
  if (t.deadline) {
    const d = daysBetween(today, t.deadline)
    if (d < 0) r.push({ label: 'Deadline passed', points: WEIGHTS.deadlineOverdue })
    else if (d === 0) r.push({ label: 'Deadline today', points: WEIGHTS.deadlineToday })
    else if (d === 1) r.push({ label: 'Deadline tomorrow', points: WEIGHTS.deadlineTomorrow })
    else if (d <= 3) r.push({ label: `Deadline in ${d} days`, points: WEIGHTS.deadlineIn3Days })
    else if (d <= 7) r.push({ label: `Deadline in ${d} days`, points: WEIGHTS.deadlineIn7Days })
  }
  const p = t.priority ?? 'medium'
  r.push({ label: `${cap(p)} priority`, points: WEIGHTS.priority[p] })
  if (t.urgency) r.push({ label: `${cap(t.urgency)} urgency`, points: WEIGHTS.urgency[t.urgency] })
  else r.push({ label: 'Urgency (default)', points: WEIGHTS.urgency.medium })
  if (t.importance) r.push({ label: `${cap(t.importance)} importance`, points: WEIGHTS.importance[t.importance] })
  else r.push({ label: 'Importance (default)', points: WEIGHTS.importance.medium })
  const late = daysBetween(t.day, today)
  if (late > 0) r.push({ label: `Scheduled ${late} day${late === 1 ? '' : 's'} ago`, points: Math.min(late * WEIGHTS.overduePerDay, WEIGHTS.overdueMax) })
  if (t.adjust) r.push({ label: 'Moved by you', points: t.adjust })
  return r
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

export const score = (t: Task, today: string) => explain(t, today).reduce((sum, r) => sum + r.points, 0)

/** 0 pinned, 1 normal, 2 sent "Later" today. */
export const group = (t: Task, today: string) => (t.pinnedAt ? 0 : t.laterOn === today ? 2 : 1)

/** Total, stable comparator for open tasks. */
export function compare(a: Task, b: Task, today: string): number {
  const ga = group(a, today)
  const gb = group(b, today)
  if (ga !== gb) return ga - gb
  if (ga === 0 && a.pinnedAt !== b.pinnedAt) return b.pinnedAt! - a.pinnedAt!
  if (ga === 2 && (a.laterAt ?? 0) !== (b.laterAt ?? 0)) return (a.laterAt ?? 0) - (b.laterAt ?? 0)
  if (ga !== 0) {
    const d = score(b, today) - score(a, today)
    if (d) return d
  }
  return a.order - b.order || a.day.localeCompare(b.day) || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

export const rankTasks = (tasks: Task[], today: string) => [...tasks].sort((a, b) => compare(a, b, today))

/**
 * Patch that moves task `x` to just before (dir -1) or after (dir 1) its neighbour in the
 * ranked list `q`, by joining the neighbour's group and copying its score (as a delta).
 */
export function movePatch(q: Task[], i: number, dir: -1 | 1, today: string): Partial<Task> | null {
  const x = q[i]
  const n = q[i + dir]
  if (!x || !n) return null
  const beyond = q[i + 2 * dir] // the task on the far side of the neighbour
  const g = group(n, today)
  const between = (a: number, b: number | undefined, step: number) => (b === undefined ? a + step : (a + b) / 2)
  const patch: Partial<Task> = { pinnedAt: undefined, laterOn: undefined, laterAt: undefined }

  if (g === 0) {
    const far = beyond && group(beyond, today) === 0 ? beyond.pinnedAt : undefined
    patch.pinnedAt = between(n.pinnedAt!, far, dir === -1 ? 1 : -1)
    return patch
  }
  if (g === 2) {
    const far = beyond && group(beyond, today) === 2 ? beyond.laterAt : undefined
    patch.laterOn = today
    patch.laterAt = between(n.laterAt ?? 0, far, dir)
    return patch
  }
  const base = score({ ...x, adjust: undefined }, today)
  const target = score(n, today)
  patch.adjust = target - base || undefined
  const tied = beyond && group(beyond, today) === 1 && score(beyond, today) === target ? beyond.order : undefined
  patch.order = between(n.order, tied, dir)
  return patch
}
