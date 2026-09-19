// Text-normalization helpers shared by per-page search, category filters, and
// the cross-kind /search view.

const DIACRITICS = /[\u0300-\u036F]/g

export const normalize = (s: unknown): string =>
  (s || "")
    .toString()
    .normalize("NFKD")
    .replace(DIACRITICS, "")
    .toLowerCase()
    .replace(/[|_\-()[\].,:/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

export type SearchToken = { text: string; wholeWord: boolean }

const DELIMITER_CHARS = new Set(["|", "_", "-", "(", ")", "[", "]", ".", ",", ":", "/", "\\"])

/** Raw query -> tokens; quoted phrases and delimiter-edged words match whole words only. */
export function parseSearchQuery(raw: unknown): SearchToken[] {
  const text = (raw || "").toString()
  const tokens: SearchToken[] = []
  let rest = ""
  let lastIndex = 0
  const quoteRe = /"([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = quoteRe.exec(text))) {
    rest += text.slice(lastIndex, match.index) + " "
    lastIndex = quoteRe.lastIndex
    const phrase = normalize(match[1])
    if (phrase) tokens.push({ text: phrase, wholeWord: true })
  }
  rest += text.slice(lastIndex)
  rest = rest.replace(/"/g, " ")

  for (const word of rest.split(/\s+/)) {
    if (!word) continue
    const wholeWord = DELIMITER_CHARS.has(word[0]) || DELIMITER_CHARS.has(word[word.length - 1])
    const normalized = normalize(word)
    if (!normalized) continue
    for (const part of normalized.split(" ")) {
      if (part) tokens.push({ text: part, wholeWord })
    }
  }
  return tokens
}

/**
 * Score a normalized string against query tokens. Returns 0 when any token
 * fails to match. Higher score = better match. Per token:
 * `100 - matchPosition` (capped) + `25` if `norm` starts with the token.
 * Summed across tokens.
 */
export function scoreNormMatch(norm: string, tokens: Array<string | SearchToken>): number {
  if (!norm || !tokens || !tokens.length) return 0
  let score = 0
  for (const token of tokens) {
    const wholeWord = typeof token === "string" ? false : token.wholeWord
    const text = typeof token === "string" ? token : token.text
    let idx: number
    if (wholeWord) {
      const padded = " " + norm + " "
      idx = padded.indexOf(" " + text + " ")
    } else {
      idx = norm.indexOf(text)
    }
    if (idx === -1) return 0
    score += 100 - (idx > 99 ? 99 : idx) + (norm.startsWith(text) ? 25 : 0)
  }
  return score
}

/** True when `norm` matches every token; an empty token list always matches. */
export function matchesNormQuery(norm: string, tokens: Array<string | SearchToken>): boolean {
  if (!tokens || !tokens.length) return true
  return scoreNormMatch(norm, tokens) > 0
}