# NEXT full plan (v1)

The default ChatGPT workflow: **Talk in ChatGPT → Copy plan → Paste here → Start day.**
No export from NEXT is needed. Machine-readable schema: [`next-full-plan.schema.json`](next-full-plan.schema.json).

```json
{
  "next_full_plan": 1,
  "date": "2026-11-02",
  "tasks": [
    { "key": "ring-banken", "title": "Ring til banken", "notes": null, "priority": "high",
      "deadline": "2026-11-06", "category": "Økonomi", "when": "today", "day": null, "status": "open" }
  ],
  "ideas": [{ "text": "Lære guitar" }]
}
```

| Field | Rule |
|---|---|
| `next_full_plan` | Always `1`. |
| `date` | Day the plan is for (`YYYY-MM-DD`). Past dates are rejected. |
| `tasks[]` | In working order. Max 100. Keys and titles unique. Every field required; `null` means "none". |
| `key` | Stable ID chosen by ChatGPT (`a-z`, `0-9`, `-`, max 40). Same task → same key in every plan. |
| `when` / `day` | `today`, `tomorrow`, or `later` + `day` (date, not before `date`). `day` is `null` otherwise. |
| `status` | `open`, `done` (completes it), or `cancelled` (removes it, unless you edited it in NEXT). |
| `ideas[]` | Go to the Inbox. Max 50. |

## How a pasted plan is merged

1. **Validation is all-or-nothing.** Any error: nothing changes.
2. **Matching:** same `key` → same title → similar title (you confirm "Same task / New task").
3. **Never lost:** tasks missing from the plan are kept. Completed or deleted tasks in NEXT stay that way.
4. **Your edits win by default:** a field you changed in NEXT since the last import becomes a conflict
   ("Keep mine" / "Use ChatGPT's"). "Keep mine" is remembered for that value, so you're not asked again.
5. **Order:** today's open tasks follow the plan's order; tasks only in NEXT follow after them.
6. **Same plan twice:** recognised and ignored. **Undo** reverts the whole import.

The older incremental format (`next_update`, by task ID) is still accepted under **Advanced**.
