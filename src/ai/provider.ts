// Provider-independent AI interface.
//
// Every provider turns a brain dump into raw model text. The rest of the app only
// ever sees the result of parseAiOutput(), so providers can be swapped freely.
//
// Two kinds:
//  - "handoff": the user carries the prompt to a chat app they already use
//    (ChatGPT, Claude, Gemini…) via copy or the share sheet, then pastes the reply back.
//    Free, official, no keys, no cookies, no scraping.
//  - "direct": a provider that calls a model itself (e.g. an official API or an
//    on-device model later). Not included: it would need keys or paid access.

import { buildPrompt } from './prompt.ts'
import type { PromptInput } from './prompt.ts'
import { parseAiOutput } from './schema.ts'
import type { ParseResult } from './schema.ts'

export type ExtractRequest = PromptInput

export type HandoffProvider = {
  kind: 'handoff'
  id: string
  name: string
  /** Where the user takes the prompt; opened in a new tab or the native app if installed. */
  url?: string
  buildPrompt(req: ExtractRequest): string
}

export type DirectProvider = {
  kind: 'direct'
  id: string
  name: string
  /** Returns the model's raw text reply for the prompt. */
  complete(prompt: string, signal?: AbortSignal): Promise<string>
}

export type AiProvider = HandoffProvider | DirectProvider

export const chatHandoff: HandoffProvider = {
  kind: 'handoff',
  id: 'chat-handoff',
  name: 'ChatGPT (copy & paste)',
  url: 'https://chatgpt.com/',
  buildPrompt,
}

/** Runs a direct provider end to end. Handoff providers finish via parseAiOutput on the pasted reply. */
export async function extractWith(provider: DirectProvider, req: ExtractRequest, signal?: AbortSignal): Promise<ParseResult> {
  try {
    return parseAiOutput(await provider.complete(buildPrompt(req), signal))
  } catch (e) {
    return { ok: false, errors: [`${provider.name} failed: ${(e as Error).message}`] }
  }
}
