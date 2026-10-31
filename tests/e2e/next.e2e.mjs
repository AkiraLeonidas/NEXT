// Browser checks for NEXT V2, against the production build (`npm run build` first).
// Uses the locally installed Google Chrome via playwright-core, at iPhone 11 size.
//   npm run test:e2e            (set SHOTS=/some/dir to save screenshots)
// Chrome is not iOS Safari: this verifies logic, layout, IndexedDB and offline behaviour,
// not Safari-specific quirks. Check those on the phone itself.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'

const PORT = 4173
const BASE = `http://localhost:${PORT}/`
const SHOTS = process.env.SHOTS
const IPHONE_11 = { viewport: { width: 414, height: 896 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }

const day = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
const D = day(2026, 11, 2)

/** An existing V1 user's saved data (no V2 fields). */
const seed = {
  rev: 7, seq: 5, applied: [], categories: ['Work', 'Home'], thoughts: [{ id: 'th1', text: 'Learn guitar', createdAt: 1 }],
  tasks: [
    { id: 't1', title: 'Pay electricity bill', notes: 'Amount on the photo', category: 'Home', priority: 'high', deadline: day(2026, 11, 3), day: day(2026, 11, 1), order: 1, done: false, createdAt: 1, key: 'betal-el' },
    { id: 't2', title: 'Call mum', notes: '', category: '', day: D, order: 1, done: false, createdAt: 2 },
    { id: 't3', title: 'Buy bulbs', notes: '', category: '', day: day(2026, 11, 4), order: 1, done: false, createdAt: 3 },
    { id: 't4', title: 'Finished earlier', notes: '', category: '', day: day(2026, 11, 1), order: 2, done: true, doneAt: new Date(2026, 10, 1, 10).getTime(), createdAt: 4 },
    { id: 't5', title: 'Deleted task', notes: '', category: '', day: day(2026, 11, 1), order: 3, done: false, cancelled: true, createdAt: 5 },
  ],
}

let failures = 0
const results = []
async function check(name, fn) {
  try {
    await fn()
    results.push(`✔ ${name}`)
  } catch (e) {
    failures++
    results.push(`✖ ${name}\n    ${String(e.message).split('\n').slice(0, 6).join('\n    ')}`)
  }
}

const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' })
await new Promise((resolve, reject) => {
  preview.stdout.on('data', (d) => String(d).includes(String(PORT)) && resolve())
  preview.on('exit', () => reject(new Error('vite preview exited')))
  setTimeout(() => reject(new Error('vite preview did not start')), 15000)
})

const browser = await chromium.launch({ channel: 'chrome', headless: true })

async function newPage({ time = new Date(2026, 10, 2, 9, 0), init, permissions = [] } = {}) {
  const context = await browser.newContext({ ...IPHONE_11, permissions })
  const page = await context.newPage()
  if (init) await page.addInitScript(init)
  if (time) await page.clock.install({ time })
  const requests = []
  page.on('request', (r) => requests.push(r.url()))
  page.on('dialog', (d) => d.accept())
  page.on('pageerror', (e) => { throw e })
  await page.goto(BASE)
  await page.evaluate((s) => localStorage.setItem('next.v1', JSON.stringify(s)), seed)
  await page.reload()
  return { context, page, requests }
}

const shot = (page, name) => SHOTS && page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true })
const noHorizontalScroll = async (page) => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll')
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('next.v1')))
const photosInDb = (page) => page.evaluate(() => new Promise((resolve, reject) => {
  const req = indexedDB.open('next-photos')
  req.onsuccess = () => {
    const db = req.result
    if (!db.objectStoreNames.contains('photos')) return resolve([])
    const all = db.transaction('photos').objectStore('photos').getAll()
    all.onsuccess = () => resolve(all.result.map((p) => ({ keys: Object.keys(p).sort(), taskId: p.taskId, width: p.width, height: p.height, type: p.blob.type, size: p.blob.size })))
    all.onerror = () => reject(all.error)
  }
  req.onerror = () => reject(req.error)
}))

/** A large JPEG made in the page (4032×3024 like an iPhone photo). */
async function bigPhoto(page) {
  const b64 = await page.evaluate(() => {
    const c = document.createElement('canvas')
    c.width = 4032; c.height = 3024
    const g = c.getContext('2d')
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height)
    g.fillStyle = '#000'; g.font = '300px sans-serif'; g.fillText('DKK 1.234,50  REF 8821', 200, 1500)
    return c.toDataURL('image/jpeg', 0.95).split(',')[1]
  })
  return { name: 'IMG_4411-faktura.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(b64, 'base64') }
}

// ---------------------------------------------------------------- existing data + rollover

await check('existing V1 data survives: overdue task actionable, dates unchanged, no duplicates', async () => {
  const { page, context } = await newPage()
  await page.getByText('Pay electricity bill').first().waitFor()
  const card = page.locator('.card')
  assert.match(await card.innerText(), /Pay electricity bill/)
  assert.match(await card.innerText(), /Overdue · planned Sun 1 Nov/)
  assert.match(await card.innerText(), /Deadline Tue 3 Nov/)
  const s = await stored(page)
  assert.equal(s.tasks.length, 5)
  assert.equal(s.tasks.find((t) => t.id === 't1').day, day(2026, 11, 1), 'original date kept')
  await noHorizontalScroll(page)
  await shot(page, '1-now')
  await context.close()
})

await check('7-day strip: dates, weekdays, counts; selecting a day shows its tasks; overdue/completed marked', async () => {
  const { page, context } = await newPage()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  const days = page.locator('.daystrip .day')
  assert.equal(await days.count(), 7)
  assert.match(await days.nth(0).getAttribute('aria-label'), /^Today, Monday 2 November: 2 open, 1 overdue$/)
  assert.match(await days.nth(2).getAttribute('aria-label'), /Wednesday 4 November: 1 open/)
  assert.match(await page.locator('.row.overdue').innerText(), /Overdue · planned Sun 1 Nov/)
  await noHorizontalScroll(page)
  await shot(page, '2-today')
  await days.nth(2).click()
  assert.equal(await page.locator('.page-title').innerText(), 'Wed 4 Nov')
  assert.match(await page.locator('.list').first().innerText(), /Buy bulbs/)
  await days.nth(1).click()
  assert.match(await page.locator('.hint').first().innerText(), /Nothing planned/)
  await days.nth(0).click()
  await page.locator('.check').first().click()
  assert.match(await page.locator('.row.done').first().innerText(), /Completed/)
  await shot(page, '3-today-done')
  await context.close()
})

await check('midnight while open: queue moves to the new day, nothing duplicated', async () => {
  const { page, context } = await newPage({ time: new Date(2026, 10, 2, 23, 59, 20) })
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  assert.match(await page.locator('.daystrip .day').nth(0).getAttribute('aria-label'), /Monday 2 November/)
  await page.clock.fastForward('01:30')
  await page.waitForFunction(() => document.querySelector('.daystrip .day')?.getAttribute('aria-label')?.includes('Tuesday 3 November'))
  assert.match(await page.locator('.daystrip .day').nth(0).getAttribute('aria-label'), /2 open, 2 overdue/)
  const s = await stored(page)
  assert.equal(s.tasks.find((t) => t.id === 't2').day, D, 'yesterday’s task kept its date')
  assert.equal(s.tasks.length, 5)
  await context.close()
})

await check('return after 5 inactive days (foreground event) recalculates', async () => {
  const { page, context } = await newPage()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  await page.clock.setSystemTime(new Date(2026, 10, 7, 8, 0))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForFunction(() => document.querySelector('.daystrip .day')?.getAttribute('aria-label')?.includes('Saturday 7 November'))
  assert.match(await page.locator('.daystrip .day').nth(0).getAttribute('aria-label'), /3 open, 3 overdue/)
  await context.close()
})

// ---------------------------------------------------------------- priority + manual order

await check('manual move and "Do this now" are respected and survive reload', async () => {
  const { page, context } = await newPage()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  const order = () => page.locator('.list').first().locator('.row-title').allInnerTexts()
  assert.deepEqual((await order()).map((t) => t.trim()), ['Pay electricity bill', 'Call mum'])
  await page.getByRole('button', { name: 'Move Call mum up' }).click()
  assert.deepEqual((await order()).map((t) => t.trim()), ['Call mum', 'Pay electricity bill'])
  await page.reload()
  await page.getByRole('button', { name: 'Today', exact: true }).click()
  assert.deepEqual((await order()).map((t) => t.trim()), ['Call mum', 'Pay electricity bill'])
  await page.getByText('Pay electricity bill').click()
  await page.getByRole('button', { name: /Why is it here/ }).click()
  assert.match(await page.locator('.why').innerText(), /Deadline tomorrow\s*\+35/)
  await shot(page, '4-detail')
  await page.getByRole('button', { name: 'Do this now' }).click()
  assert.deepEqual((await order()).map((t) => t.trim()), ['Pay electricity bill', 'Call mum'])
  await context.close()
})

// ---------------------------------------------------------------- handover

await check('handover: preview + privacy warning, clipboard copy, faithful and attachment-free', async () => {
  const { page, context } = await newPage({ permissions: ['clipboard-read', 'clipboard-write'] })
  // Add a photo first, so we can prove it is excluded.
  await page.locator('.card').click()
  await page.locator('input[type=file]').setInputFiles(await bigPhoto(page))
  await page.locator('.photo-thumb').waitFor()
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'ChatGPT' }).click()
  await page.getByRole('button', { name: 'Copy complete ChatGPT handover' }).click()
  assert.match(await page.locator('.warning').innerText(), /copies your task list into ChatGPT/)
  assert.match(await page.locator('.warning').innerText(), /Photos, photo names and photo links are never included/)
  await shot(page, '5-handover')
  await page.getByRole('button', { name: 'Copy handover' }).click()
  await page.getByText('Handover copied').waitFor()
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  for (const s of ['NEXT-HANDOVER v1', '"key": "betal-el"', '"key": "t2"', '"status": "cancelled"', '"status": "done"', '"overdue": true', 'next_full_plan 2', '2026-11-02']) assert.ok(clip.includes(s), s)
  for (const bad of ['IMG_4411', 'faktura.jpg', 'blob:', 'data:image', 'next-photos']) assert.ok(!clip.includes(bad), `leaked ${bad}`)
  await noHorizontalScroll(page)
  await context.close()
})

await check('handover: manual-copy fallback when the clipboard is blocked', async () => {
  const { page, context } = await newPage({ init: () => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')), readText: () => Promise.reject(new Error('denied')) } }) } })
  await page.getByRole('button', { name: 'ChatGPT' }).click()
  await page.getByRole('button', { name: 'Copy complete ChatGPT handover' }).click()
  await page.getByRole('button', { name: 'Copy handover' }).click()
  await page.getByText(/Couldn’t copy automatically/).waitFor()
  assert.ok((await page.locator('textarea[aria-label="Handover preview"]').inputValue()).startsWith('NEXT-HANDOVER'))
  await context.close()
})

await check('sensitive task text triggers an extra warning', async () => {
  const { page, context } = await newPage()
  await page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('next.v1'))
    s.tasks[1].notes = 'CPR 010190-1234'
    localStorage.setItem('next.v1', JSON.stringify(s))
  })
  await page.reload()
  await page.getByRole('button', { name: 'ChatGPT' }).click()
  await page.getByRole('button', { name: 'Copy complete ChatGPT handover' }).click()
  assert.match(await page.locator('.warning-strong').innerText(), /ID\/CPR-like numbers/)
  await context.close()
})

// ---------------------------------------------------------------- photos

let photoContext
let photoPage
await check('photo: add (resized, re-encoded, no filename), shown on the task, stored only in IndexedDB', async () => {
  const { page, context } = await newPage({})
  photoContext = context
  photoPage = page
  await page.locator('.card').click()
  assert.match(await page.locator('.photo-note').innerText(), /not encrypted/)
  assert.match(await page.locator('.photo-note').innerText(), /iOS can clear website storage/)
  await page.locator('input[type=file]').setInputFiles(await bigPhoto(page))
  await page.locator('.photo-thumb').waitFor()
  const [p] = await photosInDb(page)
  assert.equal(p.taskId, 't1')
  assert.deepEqual([p.width, p.height], [1600, 1200], 'resized to 1600px')
  assert.equal(p.type, 'image/jpeg')
  assert.deepEqual(p.keys, ['blob', 'createdAt', 'height', 'id', 'taskId', 'width'], 'no filename stored')
  const ls = await page.evaluate(() => JSON.stringify({ ...localStorage }))
  assert.ok(!ls.includes('IMG_4411') && !ls.includes('base64') && !ls.includes('blob:'), 'nothing in localStorage')
  await shot(page, '6-photo')
  await page.getByRole('button', { name: 'Close' }).click()
  assert.match(await page.locator('.card').innerText(), /📎 1/)
})

await check('photo: survives reload, and opens offline via the service worker', async () => {
  const page = photoPage
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.reload() // now controlled by the service worker
  await page.evaluate(() => navigator.serviceWorker.controller !== null || new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r)))
  await photoContext.setOffline(true)
  await page.reload()
  await page.locator('.card').click()
  await page.locator('.photo-thumb').click()
  await page.locator('.viewer img').waitFor()
  assert.ok(await page.locator('.viewer img').evaluate((img) => img.complete && img.naturalWidth === 1600))
  await shot(page, '7-viewer')
  await photoContext.setOffline(false)
})

await check('photo: delete asks for confirmation and removes it', async () => {
  const page = photoPage
  let asked = ''
  page.removeAllListeners('dialog')
  page.on('dialog', (d) => { asked = d.message(); d.accept() })
  await page.getByRole('button', { name: 'Delete photo' }).click()
  await page.locator('.photo-thumb').waitFor({ state: 'detached' })
  assert.match(asked, /Delete this photo from this device/)
  assert.equal((await photosInDb(page)).length, 0)
  await photoContext.close()
})

await check('photo association survives a ChatGPT import that renames the task; deleting the task removes its photos', async () => {
  const { page, context } = await newPage({ permissions: ['clipboard-read', 'clipboard-write'] })
  await page.locator('.card').click()
  await page.locator('input[type=file]').setInputFiles(await bigPhoto(page))
  await page.locator('.photo-thumb').waitFor()
  await page.getByRole('button', { name: 'Close' }).click()
  const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })
  const plan = { next_full_plan: 2, date: today, ideas: [], tasks: [{ key: 'betal-el', title: 'Pay the electricity bill', notes: 'Amount on the photo', priority: 'high', urgency: 'high', importance: 'high', deadline: null, category: 'Home', when: 'today', day: null, status: 'open' }] }
  await page.evaluate((t) => navigator.clipboard.writeText('```json\n' + t + '\n```'), JSON.stringify(plan))
  await page.getByRole('button', { name: 'ChatGPT' }).click()
  await page.getByRole('button', { name: 'Paste plan from ChatGPT' }).click()
  await page.locator('.card', { hasText: 'Pay the electricity bill' }).waitFor()
  assert.match(await page.locator('.card').innerText(), /📎 1/)
  const s = await stored(page)
  assert.equal(s.tasks.filter((t) => t.key === 'betal-el').length, 1)
  assert.equal(s.tasks.find((t) => t.key === 'betal-el').id, 't1', 'same internal ID')
  await page.locator('.card').click()
  let asked = ''
  page.removeAllListeners('dialog')
  page.on('dialog', (d) => { asked = d.message(); d.accept() })
  await page.getByRole('button', { name: 'Delete task' }).click()
  assert.match(asked, /Its 1 photo will be deleted/)
  await page.waitForFunction(async () => (await new Promise((r) => { const q = indexedDB.open('next-photos'); q.onsuccess = () => { const g = q.result.transaction('photos').objectStore('photos').count(); g.onsuccess = () => r(g.result) } })) === 0)
  await context.close()
})

await check('photo: storage quota error is explained and leaves tasks untouched', async () => {
  const { page, context } = await newPage({
    init: () => { IDBObjectStore.prototype.add = function () { throw new DOMException('full', 'QuotaExceededError') } },
  })
  const before = await stored(page)
  await page.locator('.card').click()
  await page.locator('input[type=file]').setInputFiles(await bigPhoto(page))
  assert.match(await page.locator('.photo-error').innerText(), /Not enough storage space/)
  await page.getByRole('button', { name: 'Close' }).click()
  const after = await stored(page)
  assert.deepEqual(after.tasks.map((t) => [t.id, t.title, t.day, t.done]), before.tasks.map((t) => [t.id, t.title, t.day, t.done]))
  await context.close()
})

await check('photo: IndexedDB unavailable → clear message, app keeps working', async () => {
  const { page, context } = await newPage({ init: () => { Object.defineProperty(window, 'indexedDB', { value: undefined }) } })
  await page.locator('.card').click()
  await page.locator('input[type=file]').setInputFiles({ name: 'x.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('/9j/4AAQ', 'base64') })
  await page.locator('.photo-error').waitFor()
  assert.match(await page.locator('.photo-error').innerText(), /aren’t supported|can’t be stored|Couldn’t|format/)
  await page.getByRole('button', { name: 'Close' }).click()
  await page.getByRole('button', { name: 'Done', exact: true }).click()
  assert.match(await page.locator('.card').innerText(), /Call mum/)
  await context.close()
})

// ---------------------------------------------------------------- privacy: network

await check('no external network requests anywhere in the app', async () => {
  const { page, context, requests } = await newPage({})
  for (const tab of ['Today', 'Inbox', 'ChatGPT', 'Now']) await page.getByRole('button', { name: new RegExp(`^${tab}`) }).first().click()
  await page.locator('.card').click()
  await page.locator('input[type=file]').setInputFiles(await bigPhoto(page))
  await page.locator('.photo-thumb').waitFor()
  const external = requests.filter((u) => !u.startsWith(BASE) && !u.startsWith('blob:') && !u.startsWith('data:'))
  assert.deepEqual(external, [])
  await context.close()
})

await browser.close()
preview.kill()
console.log(results.join('\n'))
console.log(`\n${results.length - failures} passed, ${failures} failed`)
process.exit(failures ? 1 : 0)
