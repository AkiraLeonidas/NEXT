// Builds the Danish instruction that turns a brain dump into NEXT's JSON format.
import { AI_OUTPUT_SCHEMA } from './schema.ts'

const WEEKDAYS_DA = ['søndag', 'mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag']

export type PromptInput = { text: string; today: string; categories: string[] }

export function buildPrompt({ text, today, categories }: PromptInput): string {
  const [y, m, d] = today.split('-').map(Number)
  const weekday = WEEKDAYS_DA[new Date(y, m - 1, d).getDay()]
  return `Du er en rolig, praktisk fokus-assistent. Hold det enkelt: små skridt, én ting ad gangen. Omdan min brain dump herunder til konkrete opgaver og idéer.

Regler:
- Svar KUN med ét JSON-objekt, der følger skemaet nederst. Ingen forklaring, ingen markdown.
- Opgaver: korte, konkrete handlinger på dansk, der starter med et udsagnsord (fx "Ring til tandlægen"). Del store opgaver op i små skridt.
- Idéer: tanker, ønsker og "måske engang" uden en klar handling. De skal i "ideas", ikke i "tasks".
- priority: "high" kun ved tydelig hast eller konsekvens, ellers "medium" eller "low".
- deadline: kun hvis en dato, ugedag eller frist nævnes. I dag er ${weekday} ${today}. Brug formatet ÅÅÅÅ-MM-DD, ellers null.
- when: "today" hvis det haster eller skal ske i dag, "tomorrow" hvis i morgen, ellers "later".
- category: vælg helst en af: ${categories.join(', ')}. Ellers et kort nyt ord, eller null.
- notes: kun nyttige detaljer fra teksten (fx telefonnummer, sted), ellers null.
- Opfind ikke opgaver, der ikke står i teksten. Saml dubletter til én opgave.

JSON-skema:
${JSON.stringify(AI_OUTPUT_SCHEMA)}

Brain dump:
"""
${text.trim()}
"""`
}
