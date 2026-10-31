// Pure photo helpers (no browser APIs), shared by attachments.ts and tests.

export type PhotoErrorKind = 'unavailable' | 'quota' | 'unsupported' | 'failed'
export class PhotoError extends Error {
  kind: PhotoErrorKind
  constructor(kind: PhotoErrorKind, message: string) {
    super(message)
    this.kind = kind
  }
}

export const MAX_SIDE = 1600

/** Size that fits within `max` on its longest side, keeping the aspect ratio (never upscales). */
export function fitWithin(width: number, height: number, max = MAX_SIDE): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height, 1))
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) }
}

/** Maps browser errors to something the UI can explain. */
export function toPhotoError(e: unknown): PhotoError {
  if (e instanceof PhotoError) return e
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
    return new PhotoError('quota', 'Not enough storage space on this device. Delete some photos and try again.')
  }
  if (name === 'InvalidStateError' || name === 'SecurityError') {
    return new PhotoError('unavailable', 'Photos can’t be stored here (private browsing or storage turned off).')
  }
  return new PhotoError('failed', 'Couldn’t save the photo. Your task is unchanged.')
}
