import { useEffect, useRef, useState } from 'react'
import type { Photo } from './attachments.ts'
import { addPhoto, deletePhoto, listPhotos, toPhotoError } from './attachments.ts'

export const PHOTO_PRIVACY =
  'Photos stay only on this device, inside NEXT. They are not encrypted: anyone who can use your unlocked phone can see them. ' +
  'iOS can clear website storage, so don’t keep the only copy here. Photograph just what you need, e.g. the amount and payment reference.'

type Shown = Photo & { url: string }

/** Photos for one task: add (camera or library via the standard iOS picker), view, delete. */
export default function TaskPhotos({ taskId, onChange }: { taskId: string; onChange: () => void }) {
  const [photos, setPhotos] = useState<Shown[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [viewing, setViewing] = useState<Shown | null>(null)
  const [version, setVersion] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let alive = true
    let shown: Shown[] = []
    listPhotos(taskId)
      .then((list) => {
        if (!alive) return
        shown = list.map((p) => ({ ...p, url: URL.createObjectURL(p.blob) }))
        setPhotos(shown)
      })
      .catch((e) => alive && setError(toPhotoError(e).message))
    return () => {
      alive = false
      shown.forEach((p) => URL.revokeObjectURL(p.url))
    }
  }, [taskId, version])

  const pick = async (file: File | undefined) => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      await addPhoto(taskId, file)
      setVersion((v) => v + 1)
      onChange()
    } catch (e) {
      setError(toPhotoError(e).message)
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const remove = async (p: Shown) => {
    if (!confirm('Delete this photo from this device? This can’t be undone.')) return
    try {
      await deletePhoto(p.id)
      setViewing(null)
      setVersion((v) => v + 1)
      onChange()
    } catch (e) {
      setError(toPhotoError(e).message)
    }
  }

  return (
    <div className="field">
      <span className="label">Photos</span>
      {photos.length > 0 && (
        <div className="photos">
          {photos.map((p, i) => (
            <button key={p.id} className="photo-thumb" onClick={() => setViewing(p)} aria-label={`Open photo ${i + 1} of ${photos.length}`}>
              <img src={p.url} alt="" />
            </button>
          ))}
        </div>
      )}
      {/* No `capture` attribute: iOS offers Take Photo, Photo Library and Files, without broad library access. */}
      <input ref={input} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files?.[0])} aria-hidden="true" tabIndex={-1} />
      <button className="btn small secondary photo-add" onClick={() => input.current?.click()} disabled={busy}>
        <span aria-hidden="true">📎</span> {busy ? 'Saving…' : 'Add photo'}
      </button>
      {error && <p className="photo-error" role="alert">{error}</p>}
      <p className="photo-note">{PHOTO_PRIVACY}</p>

      {viewing && (
        <div className="viewer" role="dialog" aria-modal="true" aria-label="Photo" onClick={() => setViewing(null)}>
          <img src={viewing.url} alt="Task photo" onClick={(e) => e.stopPropagation()} />
          <div className="viewer-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn danger-solid" onClick={() => remove(viewing)}>Delete photo</button>
            <button className="btn secondary" onClick={() => setViewing(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}
