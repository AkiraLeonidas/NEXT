// "Copy complete ChatGPT handover": a self-contained, versioned text that lets a brand-new
// ChatGPT conversation continue with NEXT immediately.
//
// Built only from `State` (tasks, ideas, categories). Photo attachments live in IndexedDB
// and are never part of `State`, so no image data, filenames or URLs can end up here.

import type { Priority, State, Task } from '../store.ts'
import { addDays, doneDay, timeZone } from '../store.ts'
import { WEIGHTS, rankTasks } from '../priority.ts'
import { FULL_PLAN_SCHEMA, FULL_PLAN_VERSION, LIMITS, weekdayDa } from './fullplan.ts'

export const HANDOVER_VERSION = 1
export const APP_VERSION = '2.0.0'
const RECENT_DAYS = 30 // completed/deleted tasks newer than this are listed, so they aren't re-created
const MAX_TOMBSTONES = 150

export type HandoverTask = {
  key: string
  title: string
  status: 'open' | 'done' | 'cancelled'
  scheduled: string
  overdue: boolean
  deadline: string | null
  priority: Priority
  urgency: Priority | null
  importance: Priority | null
  category: string | null
  notes: string | null
  pinned?: true
  later_today?: true
  completed_on?: string
}

/** Key ChatGPT must use for this task: its ChatGPT key, or else NEXT's permanent ID. */
export const keyOf = (t: Task) => t.key ?? t.id

function toHandoverTask(t: Task, today: string): HandoverTask {
  const h: HandoverTask = {
    key: keyOf(t),
    title: t.title,
    status: t.cancelled ? 'cancelled' : t.done ? 'done' : 'open',
    scheduled: t.day,
    overdue: !t.done && !t.cancelled && t.day < today,
    deadline: t.deadline ?? null,
    priority: t.priority ?? 'medium',
    urgency: t.urgency ?? null,
    importance: t.importance ?? null,
    category: t.category || null,
    notes: t.notes ? (t.notes.length > LIMITS.notes ? `${t.notes.slice(0, LIMITS.notes - 1)}…` : t.notes) : null,
  }
  if (!t.done && !t.cancelled && t.pinnedAt) h.pinned = true
  if (!t.done && !t.cancelled && t.laterOn === today) h.later_today = true
  if (t.done) h.completed_on = doneDay(t)
  return h
}

/** Tasks included in the snapshot: all open; completed/deleted from the last 30 days (bounded). */
export function snapshotTasks(state: State, today: string): HandoverTask[] {
  const since = addDays(today, -RECENT_DAYS)
  const open = state.tasks.filter((t) => !t.done && !t.cancelled)
  const now = rankTasks(open.filter((t) => t.day <= today), today)
  const future = open.filter((t) => t.day > today).sort((a, b) => a.day.localeCompare(b.day) || a.order - b.order)
  const recent = (t: Task) => (t.done ? doneDay(t) : t.day) >= since || t.day >= since
  const closed = state.tasks
    .filter((t) => (t.done || t.cancelled) && recent(t))
    .sort((a, b) => (b.doneAt ?? b.createdAt) - (a.doneAt ?? a.createdAt))
    .slice(0, MAX_TOMBSTONES)
  return [...now, ...future, ...closed].map((t) => toHandoverTask(t, today))
}

function offset(now: Date): string {
  const m = -now.getTimezoneOffset()
  const sign = m >= 0 ? '+' : '-'
  const a = Math.abs(m)
  return `UTC${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

const rulesText = () => {
  const w = WEIGHTS
  return `Prioritet (NEXT beregner selv rækkefølgen lokalt og deterministisk):
1. Fastgjorte opgaver ("Gør det nu" i NEXT) står øverst, senest fastgjort først.
2. Derefter sorteres efter point (højest først):
   - Hård frist (deadline): overskredet +${w.deadlineOverdue}, i dag +${w.deadlineToday}, i morgen +${w.deadlineTomorrow}, om 2–3 dage +${w.deadlineIn3Days}, om 4–7 dage +${w.deadlineIn7Days}.
   - priority: high +${w.priority.high}, medium +${w.priority.medium}, low +${w.priority.low} (mangler = medium).
   - urgency: high +${w.urgency.high}, medium +${w.urgency.medium}, low +${w.urgency.low} (mangler = medium).
   - importance: high +${w.importance.high}, medium +${w.importance.medium}, low +${w.importance.low} (mangler = medium).
   - Planlagt dag overskredet (fleksibel dato): +${w.overduePerDay} pr. dag, højst +${w.overdueMax}.
   - Brugerens manuelle flytning (↑/↓) gemmes som en pointjustering og respekteres.
3. Opgaver, brugeren har trykket "Senere" på i dag, kommer sidst i dag. Det nulstilles i morgen.
Ved lighed: din rækkefølge i planen, derefter planlagt dag, oprettelsestid og ID. Aldrig tilfældigt.
Din opgave er at sætte priority, urgency og importance ærligt – ikke at regne point ud.`
}

const rolloverText = () => `Dagsskifte (automatisk i NEXT, også offline):
- Ufærdige opgaver fra tidligere dage bliver stående i dagens kø og vises som "overdue". Deres oprindelige planlagte dato ændres IKKE.
- Færdige, aflyste og slettede opgaver flyttes aldrig.
- Opgaver med en fremtidig dato venter til deres dag.
- I en plan: giv en forsinket opgave "when": "today" for at beholde den – NEXT bevarer så den oprindelige dato.`

const importText = () => `Import i NEXT (sådan bliver din JSON flettet ind):
- Valideringen er alt-eller-intet: én fejl, og intet ændres. Samme plan to gange gør ingenting.
- Match: samme "key" → samme titel → lignende titel (brugeren bekræfter).
- Opgaver, du udelader, slettes ALDRIG. Færdige opgaver forbliver færdige. Slettede/aflyste forbliver slettede.
- Felter, brugeren selv har ændret i NEXT, bliver ikke overskrevet uden at brugeren bliver spurgt.
- Brugeren kan fortryde hele importen.`

/** The complete handover text. `now` is injectable for tests. */
export function buildHandover(state: State, now: Date = new Date(), today?: string): string {
  const day = today ?? `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  const tasks = snapshotTasks(state, day)
  const snapshot = {
    next_handover: HANDOVER_VERSION,
    app_version: APP_VERSION,
    plan_format: `next_full_plan ${FULL_PLAN_VERSION}`,
    date: day,
    weekday: weekdayDa(day),
    timezone: timeZone() || null,
    utc_offset: offset(now),
    counts: {
      open: tasks.filter((t) => t.status === 'open').length,
      overdue: tasks.filter((t) => t.overdue).length,
      done_listed: tasks.filter((t) => t.status === 'done').length,
      cancelled_listed: tasks.filter((t) => t.status === 'cancelled').length,
    },
    categories: state.categories,
    tasks,
    ideas: state.thoughts.slice(0, LIMITS.ideas).map((t) => t.text),
  }
  const example = {
    next_full_plan: FULL_PLAN_VERSION,
    date: day,
    tasks: [{ key: 'betal-elregning', title: 'Betal elregningen', notes: null, priority: 'high', urgency: 'high', importance: 'high', deadline: addDays(day, 2), category: null, when: 'today', day: null, status: 'open' }],
    ideas: [],
  }

  return `NEXT-HANDOVER v${HANDOVER_VERSION} (NEXT ${APP_VERSION}) – genereret ${day} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} ${offset(now)}

Du overtager rollen som min rolige, praktiske fokus-assistent for appen NEXT. Denne besked er komplet: den beskriver arbejdsgangen, JSON-formatet, NEXTs regler og et øjebliksbillede af mine opgaver. Øjebliksbilledet nederst er sandheden lige nu.

ARBEJDSGANG
- NEXT er en offline iPhone-app, der viser én opgave ad gangen. Data ligger kun på min telefon.
- Vi taler frit. Når jeg skriver "NEXT-plan" (eller beder om planen), svarer du med præcis én \`\`\`json-kodeblok med hele planen i formatet nedenfor og intet andet. Ellers svarer du uden JSON.
- Jeg kopierer kodeblokken og indsætter den i NEXT. Du kan ikke selv ændre noget i NEXT.

STRENGE REGLER
- Opfind aldrig opgaver, datoer, frister, eller at noget er gjort/aflyst. Brug kun det, der står her, eller det, jeg fortæller dig.
- Opfind aldrig funktioner. NEXT har IKKE påmindelser, alarmer, notifikationer, kalender-sync, konti, deling eller cloud. Du kan ikke se billeder eller vedhæftninger i NEXT.
- Brug altid den eksisterende "key" for en opgave fra øjebliksbilledet – også når titlen ændres. Nye opgaver får en ny, unik key med små bogstaver, tal og bindestreger, som ikke ligner "t" + tal og ikke allerede findes nedenfor.
- Opgaver med status "done" eller "cancelled" må ikke oprettes igen. Tag dem kun med, hvis det er nyttigt, med samme key og samme status.
- "deadline" er KUN en hård frist med en reel konsekvens. En fleksibel plan-dag hører til "when"/"day".
- Er du i tvivl om dato, ugedag eller hvilken opgave jeg mener, så spørg kort i stedet for at gætte.
- Ingen dubletter. Højst ${LIMITS.tasks} opgaver og ${LIMITS.ideas} idéer pr. plan.

PLANFORMAT (next_full_plan ${FULL_PLAN_VERSION}) – alle felter er påkrævede, brug null for "ingen":
- "date": den dag, planen gælder (normalt ${day}). Datoer før i dag afvises.
- "when": "today", "tomorrow" eller "later". Ved "later" skal "day" være en dato (ÅÅÅÅ-MM-DD), ikke før "date"; ellers er "day" null.
- "status": "open", "done" (kun når jeg har sagt, det er gjort) eller "cancelled" (kun når jeg tydeligt siger, det ikke skal gøres).
- "priority", "urgency", "importance": "high", "medium" eller "low". "high" kun ved tydelig hast/konsekvens.
- Vage ønsker og "måske engang" kommer i "ideas" som {"text": "..."}.
Eksempel:
${JSON.stringify(example, null, 2)}

JSON-skema:
${JSON.stringify(FULL_PLAN_SCHEMA)}

${importText()}

${rolloverText()}

${rulesText()}

ØJEBLIKSBILLEDE (fra NEXT, ${day}, tidszone ${snapshot.timezone ?? 'ukendt'} ${snapshot.utc_offset})
"tasks": åbne opgaver i NEXTs aktuelle rækkefølge (dagens kø først, så fremtidige), derefter færdige/aflyste fra de sidste ${RECENT_DAYS} dage. "scheduled" er den planlagte dag; "overdue": true betyder, at den stadig skal gøres.
${JSON.stringify(snapshot, null, 2)}

Svar nu kun: "Klar. Jeg har ${snapshot.counts.open} åbne opgaver fra NEXT (${snapshot.counts.overdue} forsinkede). Skriv 'NEXT-plan', når du vil have planen."`
}

/** Patterns that suggest sensitive content (account numbers, CPR/ID numbers, emails, card numbers). */
const SENSITIVE: [RegExp, string][] = [
  [/\b\d{6}-?\d{4}\b/, 'ID/CPR-like numbers'],
  [/\b[A-Z]{2}\d{2}[A-Z0-9 ]{11,30}\b/, 'IBAN-like account numbers'],
  [/\b(?:\d[ -]?){13,19}\b/, 'card or account numbers'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/, 'email addresses'],
  [/\b(password|adgangskode|kodeord|pin|nemid|mitid)\b/i, 'passwords or login words'],
]

/** Readable warnings when task text looks sensitive. Heuristic only. */
export function sensitiveHints(text: string): string[] {
  return SENSITIVE.filter(([re]) => re.test(text)).map(([, label]) => label)
}
