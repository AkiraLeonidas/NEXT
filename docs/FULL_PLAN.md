# NEXT full plan (v2)

The default ChatGPT workflow: **Talk in ChatGPT → Copy plan → Paste here → Start day.**
No export from NEXT is needed. Machine-readable schema: [`next-full-plan.schema.json`](next-full-plan.schema.json).

```json
{
  "next_full_plan": 2,
  "date": "2026-11-02",
  "tasks": [
    { "key": "ring-banken", "title": "Ring til banken", "notes": null, "priority": "high",
      "urgency": "high", "importance": "medium",
      "deadline": "2026-11-06", "category": "Økonomi", "when": "today", "day": null, "status": "open" }
  ],
  "ideas": [{ "text": "Lære guitar" }]
}
```

| Field | Rule |
|---|---|
| `next_full_plan` | `2` (current). `1` is still accepted: same fields without `urgency`/`importance`. |
| `date` | Day the plan is for (`YYYY-MM-DD`). Past dates are rejected. |
| `tasks[]` | Suggested order (NEXT ranks locally; plan order breaks ties). Max 100. Keys and titles unique. Every field required; `null` means "none". |
| `key` | Stable ID chosen by ChatGPT (`a-z`, `0-9`, `-`, max 40). Same task → same key in every plan. |
| `when` / `day` | Flexible scheduled day: `today`, `tomorrow`, or `later` + `day` (date, not before `date`). `day` is `null` otherwise. |
| `deadline` | **Hard** deadline only (a real consequence if missed), else `null`. |
| `urgency` / `importance` | v2: `high`, `medium`, `low`. ChatGPT's judgement; NEXT turns it into points. |
| `status` | `open`, `done` (completes it), or `cancelled` (removes it, unless you edited it in NEXT). |
| `ideas[]` | Go to the Inbox. Max 50. |

## How a pasted plan is merged

1. **Validation is all-or-nothing.** Any error: nothing changes.
2. **Matching:** same `key` → same title → similar title (you confirm "Same task / New task").
3. **Never lost:** tasks missing from the plan are kept. Completed or deleted tasks in NEXT stay that way.
4. **Your edits win by default:** a field you changed in NEXT since the last import becomes a conflict
   ("Keep mine" / "Use ChatGPT's"). "Keep mine" is remembered for that value, so you're not asked again.
5. **Order:** the priority engine ranks tasks; plan order is the tie-breaker.
6. **Overdue tasks:** if the plan keeps an overdue task `today`, its original date is kept.
7. **Same plan twice:** recognised and ignored. **Undo** reverts the whole import.

The older incremental format (`next_update`, by task ID) is still accepted under **Advanced**.

## Daily rollover

Derived on the fly, never written: today's queue is every open task with a scheduled day of today or
earlier. Overdue tasks keep their date and are labelled "Overdue". Completed, cancelled and deleted tasks
never roll over; future tasks wait for their day. The local date is re-checked at local midnight, when the
app is reopened or returns to the foreground, and every minute (covers sleep and timezone changes).

## Priority rules

Implemented in `src/priority.ts` (`WEIGHTS`). The ChatGPT handover quotes the same numbers.

1. **Pinned** ("Do this now"): above everything, newest pin first.
2. **Normal**, by points, highest first:

   | Signal | Points |
   |---|---|
   | Hard deadline passed / today / tomorrow / in 2–3 days / in 4–7 days | 60 / 50 / 35 / 25 / 10 |
   | `priority` high / medium / low (missing = medium) | 30 / 15 / 0 |
   | `urgency` high / medium / low (missing = medium) | 20 / 10 / 0 |
   | `importance` high / medium / low (missing = medium) | 15 / 8 / 0 |
   | Scheduled day passed (flexible) | +2 per day, max 10 |
   | Manual ↑/↓ move | stored as a points delta, so deadlines still count |

3. **Later today**: tasks you tapped "Later" on go last, in that order, until tomorrow.

Ties: manual order (plan order for imports) → scheduled day → creation time → ID. Never random.
"Use automatic order" in the task sheet clears a pin, "Later" and manual moves.

## ChatGPT handover

ChatGPT tab → **Copy complete ChatGPT handover**. A versioned text (`NEXT-HANDOVER v1`) with the
workflow, rules, this schema, the local date/timezone and a snapshot: all open tasks (by key, or NEXT ID
if ChatGPT never gave one), plus completed and deleted tasks from the last 30 days so they aren't
re-created. Built only from task data: photos, photo names and photo URLs are never included.
