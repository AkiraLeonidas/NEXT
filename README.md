# NEXT

A calm, minimal daily task app: one task at a time.

- **Now** shows only the current task, with large **Done** and **Later** buttons.
- **Today** is the day's agenda; **Inbox** holds parked thoughts.
- **ChatGPT**: copy your plan into a ChatGPT chat, talk to it, then paste its JSON update back. Updates target stable task IDs, are validated before anything changes, and never overwrite your own edits without asking.
- Works offline as an installable PWA. All data stays on your device (localStorage). No accounts, no backend, no API keys.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # logic, sync and persistence tests
npm run build      # production build in dist/
```
