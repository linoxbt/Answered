/** Cheap, model-free text rules for the question pipeline (spec: "Backend pipeline"). */

// A question word followed by a space, so "can't wait" is not read as "can ...".
const WH_START =
  /^(what|whats|what's|when|wen|how|why|will|is|are|can|could|does|do|did|who|where|which|should|would|has|have|any)\s/i
// Question shapes anywhere in the message: "seriously when is mainnet", "so what are the unlock dates".
const WH_ANYWHERE = /\b(when|wen|what|how|why|where|which|who)\s+(is|are|was|will|would|do|does|did|can|could|should)\b/i
const ASKING_PHRASES = /\b(anyone know|any update|any news|eta\b|is there|are there)/i

/** Max characters of a cluster title, so that "14 | " plus the title fits a 64-character list item. */
export const TITLE_MAX = 56

/**
 * Prefilter from the spec: drop short messages, commands and bot messages (those never get here),
 * pass anything with a question mark, a leading wh-word, or an asking phrase.
 * Everything that fails is recorded as "not a question" without a model call.
 */
export function mightBeQuestion(text: string): boolean {
  const t = text.trim()
  if (t.length < 6 || t.startsWith('/')) return false
  return t.includes('?') || WH_START.test(t) || WH_ANYWHERE.test(t) || ASKING_PHRASES.test(t)
}

/** Trims a canonical question to TITLE_MAX characters on a word boundary. */
export function clampTitle(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= TITLE_MAX) return t
  const cut = t.slice(0, TITLE_MAX - 3)
  const space = cut.lastIndexOf(' ')
  return `${(space > 20 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, '')}...`
}

/**
 * Cluster title: the earliest canonical with at least 4 words (else the earliest), so the title
 * stays put as people pile on. The spec's "shortest" rule made titles jump to narrow variants
 * such as "Is mainnet Q1 or Q2?" and forced extra list rebuilds on the glasses.
 * `canonicals` must be in asking order.
 */
export function pickTitle(canonicals: string[]): string {
  const clean = canonicals.map((c) => c.trim()).filter(Boolean)
  if (!clean.length) return ''
  return clampTitle(clean.find((c) => c.split(/\s+/).length >= 4) ?? clean[0]!)
}

const STOP = new Set(
  'a an the is are was be to of in on for and or it its this that ser sir pls please guys gm any anyone know there what when how why will can does do which who where'.split(' '),
)

/** Content words, lightly normalised, for the heuristic fallback's similarity measure. */
export function keywords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, ''))
  return new Set(words)
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const w of a) if (b.has(w)) shared += 1
  return shared / (a.size + b.size - shared)
}
