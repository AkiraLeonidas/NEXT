# NEXT

A calm, minimal daily task app: one task at a time.

- **Now** shows only the current task, with large **Done** and **Later** buttons.
- **Today** is the day's agenda; **Inbox** holds parked thoughts.
- **ChatGPT**: copy your plan into a ChatGPT chat, talk to it, then paste its JSON update back. Updates target stable task IDs, are validated before anything changes, and never overwrite your own edits without asking.
- **Daily rollover**: unfinished tasks from earlier days stay in today's queue, marked overdue, with their original date kept. Completed, cancelled and future tasks never move.
- **Priority engine**: a fixed, offline points system (hard deadlines, priority, ChatGPT's urgency/importance, days overdue). "Do this now" pins, "Later" defers for today, ↑/↓ moves stick. Tap **Why is it here?** on a task to see the points. Rules: [docs/FULL_PLAN.md](docs/FULL_PLAN.md#priority-rules).
- **7-day strip** on Today: today plus six days with open counts; tap a day to see its tasks.
- **Copy complete ChatGPT handover** (ChatGPT tab): one message that sets up a new ChatGPT chat with the workflow, plan format, rules and current tasks. You see a preview and a privacy warning first; it only goes to the clipboard.
- **Photos on tasks** (📎 in the task sheet): stored only in this browser's IndexedDB, resized and re-encoded on the device (drops location metadata), never uploaded and never part of any ChatGPT text. Not encrypted, and iOS can clear website storage, so don't keep the only copy here.
- Works offline as an installable PWA. Task data stays on your device (localStorage `next.v1`), photos in IndexedDB `next-photos`. No accounts, no backend, no API keys, no analytics.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # logic, sync, priority, rollover, handover and persistence tests
npm run build      # production build in dist/
npm run test:e2e   # browser checks at iPhone 11 size against dist/ (uses installed Google Chrome)
```
