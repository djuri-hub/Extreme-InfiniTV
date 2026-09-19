import { describe, it, expect } from "vitest"
import { normalize, parseSearchQuery, scoreNormMatch, matchesNormQuery } from "@/scripts/lib/text.ts"

describe("parseSearchQuery", () => {
  it("marks a trailing-delimiter word as whole-word", () => {
    expect(parseSearchQuery("AT|")).toEqual([{ text: "at", wholeWord: true }])
  })

  it("marks a leading-delimiter word as whole-word", () => {
    expect(parseSearchQuery("|AT")).toEqual([{ text: "at", wholeWord: true }])
  })

  it("leaves a plain word as a substring token", () => {
    expect(parseSearchQuery("at")).toEqual([{ text: "at", wholeWord: false }])
  })

  it("marks a parenthesized word as whole-word", () => {
    expect(parseSearchQuery("(AT)")).toEqual([{ text: "at", wholeWord: true }])
  })

  it("splits a mid-word delimiter into two substring tokens", () => {
    expect(parseSearchQuery("AT|ARCADIA")).toEqual([
      { text: "at", wholeWord: false },
      { text: "arcadia", wholeWord: false },
    ])
  })

  it("splits a hyphenated prefix into substring tokens for live typing", () => {
    expect(parseSearchQuery("sky-spo")).toEqual([
      { text: "sky", wholeWord: false },
      { text: "spo", wholeWord: false },
    ])
  })

  it("turns a quoted phrase into one whole-word token with internal spaces", () => {
    expect(parseSearchQuery('"AT| ARCADIA"')).toEqual([{ text: "at arcadia", wholeWord: true }])
  })

  it("drops a lone unmatched quote without crashing", () => {
    expect(parseSearchQuery('AT|"')).toEqual([{ text: "at", wholeWord: true }])
  })

  it("returns an empty list for an empty query", () => {
    expect(parseSearchQuery("")).toEqual([])
  })

  it("combines a quoted phrase with trailing unquoted words", () => {
    expect(parseSearchQuery('"AT| ARCADIA" HD')).toEqual([
      { text: "at arcadia", wholeWord: true },
      { text: "hd", wholeWord: false },
    ])
  })
})

describe("scoreNormMatch", () => {
  it("substring-matches a plain string token as before", () => {
    expect(scoreNormMatch("national geographic", ["at"])).toBeGreaterThan(0)
  })

  it("substring-matches a plain non-whole-word SearchToken", () => {
    expect(scoreNormMatch("national geographic", [{ text: "at", wholeWord: false }])).toBeGreaterThan(0)
  })

  it("does not match a whole-word token against a mid-word substring", () => {
    expect(scoreNormMatch("national geographic", [{ text: "at", wholeWord: true }])).toBe(0)
  })

  it("matches a whole-word token against a real word in the string", () => {
    expect(scoreNormMatch("at arcadia world hd", [{ text: "at", wholeWord: true }])).toBeGreaterThan(0)
  })

  it("matches a whole-word phrase token against the same word order", () => {
    expect(
      scoreNormMatch("at arcadia world hd", [{ text: "at arcadia", wholeWord: true }])
    ).toBeGreaterThan(0)
  })

  it("does not match a whole-word phrase token against reversed word order", () => {
    expect(scoreNormMatch("arcadia at", [{ text: "at arcadia", wholeWord: true }])).toBe(0)
  })

  it("returns 0 when any token misses", () => {
    expect(scoreNormMatch("arcadia world hd", [{ text: "at", wholeWord: true }, "nope"])).toBe(0)
  })

  it("rejects the AT| channel bug case against unrelated channel names", () => {
    const tokens = parseSearchQuery("AT|")
    expect(scoreNormMatch(normalize("national geographic"), tokens)).toBe(0)
    expect(scoreNormMatch(normalize("arcadia"), tokens)).toBe(0)
    expect(scoreNormMatch(normalize("AT| ARCADIA WORLD HD"), tokens)).toBeGreaterThan(0)
  })

  it("keeps live prefix typing working for a hyphenated query", () => {
    const tokens = parseSearchQuery("sky-spo")
    expect(scoreNormMatch("sky sports", tokens)).toBeGreaterThan(0)
  })

  it("keeps a full hyphenated word matching by substring", () => {
    const tokens = parseSearchQuery("sky-sport")
    expect(scoreNormMatch("sky sports", tokens)).toBeGreaterThan(0)
  })
})

describe("matchesNormQuery", () => {
  it("returns true for an empty token list", () => {
    expect(matchesNormQuery("anything", [])).toBe(true)
  })

  it("returns true when scoreNormMatch is positive", () => {
    expect(matchesNormQuery("arcadia world hd", ["arcadia"])).toBe(true)
  })

  it("returns false when scoreNormMatch is zero", () => {
    expect(matchesNormQuery("national geographic", [{ text: "at", wholeWord: true }])).toBe(false)
  })
})
