// Local photo attachments. Stored only in this browser's IndexedDB, keyed by the task's
// permanent ID. Never uploaded, never put in localStorage, never part of task JSON,
// ChatGPT exports or handovers (those are built from `State`, which holds no photo data).
//
// Photos are re-encoded on the device: resized to at most 1600 px and saved as JPEG.
// Re-encoding also drops EXIF metadata such as GPS location. No filenames are stored.

export type Photo = { id: string; taskId: string; blob: Blob; width: number; height: number; createdAt: number }

import { PhotoError, fitWithin, toPhotoError } from './photoErrors.ts'

export { PhotoError, toPhotoError }
export type { PhotoErrorKind } from './photoErrors.ts'

const DB_NAME = 'next-photos'
const STORE = 'photos'
const JPEG_QUALITY = 0.82
const MAX_INPUT_BYTES = 40 * 1024 * 1024

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new PhotoError('unavailable', 'Photos aren’t supported in this browser.'))
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, 1)
    } catch (e) {
      return reject(toPhotoError(e))
    }
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' })
      store.createIndex('taskId', 'taskId')
    }
    req.onsuccess = () => {
      const db = req.result
      db.onversionchange = () => { db.close(); dbPromise = null }
      resolve(db)
    }
    req.onerror = () => reject(toPhotoError(req.error))
    req.onblocked = () => reject(new PhotoError('unavailable', 'Photo storage is busy. Close other NEXT tabs and try again.'))
  })
  dbPromise.catch(() => { dbPromise = null }) // allow a retry later
  return dbPromise
}

/** Runs one transaction; resolves when it has committed (so a quota error is never missed). */
async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  const db = await openDb()
  return new Promise<T>((resolve, reject) => {
    let t: IDBTransaction
    try {
      t = db.transaction(STORE, mode)
    } catch (e) {
      return reject(toPhotoError(e))
    }
    const req = run(t.objectStore(STORE))
    t.oncomplete = () => resolve(req ? req.result : (undefined as T))
    t.onerror = () => reject(toPhotoError(t.error ?? req?.error))
    t.onabort = () => reject(toPhotoError(t.error ?? req?.error))
  })
}

const newId = () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

function decode(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new PhotoError('unsupported', 'This image format isn’t supported. Try taking the photo again.')) }
    img.src = url
  })
}

/** Resizes and re-encodes an image on the device. */
export async function compress(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  if (!file.type.startsWith('image/')) throw new PhotoError('unsupported', 'Only images can be attached.')
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('unsupported', 'This image is too large.')
  const img = await decode(file)
  const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new PhotoError('failed', 'Couldn’t process the photo.')
  ctx.drawImage(img, 0, 0, width, height)
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', JPEG_QUALITY))
  canvas.width = canvas.height = 0 // free memory early on iOS
  if (!blob) throw new PhotoError('failed', 'Couldn’t process the photo.')
  return { blob, width, height }
}

export async function addPhoto(taskId: string, file: Blob): Promise<Photo> {
  const { blob, width, height } = await compress(file)
  const photo: Photo = { id: newId(), taskId, blob, width, height, createdAt: Date.now() }
  await tx('readwrite', (s) => s.add(photo))
  // Ask the browser not to evict NEXT's storage under pressure. Best effort, no prompt on iOS.
  navigator.storage?.persist?.().catch(() => {})
  return photo
}

export async function listPhotos(taskId: string): Promise<Photo[]> {
  const all = await tx<Photo[]>('readonly', (s) => s.index('taskId').getAll(taskId))
  return all.sort((a, b) => a.createdAt - b.createdAt)
}

export const deletePhoto = (id: string) => tx('readwrite', (s) => s.delete(id))

/** Number of photos per task ID. */
export async function photoCounts(): Promise<Map<string, number>> {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const counts = new Map<string, number>()
    const t = db.transaction(STORE, 'readonly')
    const req = t.objectStore(STORE).index('taskId').openKeyCursor()
    req.onsuccess = () => {
      const c = req.result
      if (!c) return
      const id = String(c.key)
      counts.set(id, (counts.get(id) ?? 0) + 1)
      c.continue()
    }
    t.oncomplete = () => resolve(counts)
    t.onerror = () => reject(toPhotoError(t.error))
  })
}

/** Deletes all photos of the given tasks (e.g. tasks the user deleted). */
export async function deletePhotosFor(taskIds: string[]): Promise<number> {
  if (!taskIds.length) return 0
  const wanted = new Set(taskIds)
  const db = await openDb()
  return new Promise((resolve, reject) => {
    let n = 0
    const t = db.transaction(STORE, 'readwrite')
    const req = t.objectStore(STORE).index('taskId').openCursor()
    req.onsuccess = () => {
      const c = req.result
      if (!c) return
      if (wanted.has(String(c.key))) { c.delete(); n++ }
      c.continue()
    }
    t.oncomplete = () => resolve(n)
    t.onerror = () => reject(toPhotoError(t.error))
  })
}
