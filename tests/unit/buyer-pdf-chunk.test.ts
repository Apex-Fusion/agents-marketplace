/**
 * buyer-pdf-chunk.test.ts — the paragraph/sentence-aligned chunker must never
 * cut a sentence in half, must respect the target size, and must be
 * deterministic.
 */

import { describe, it, expect } from "vitest";
import { chunkText } from "../../buyer/src/pdf/chunk.js";

describe("chunkText", () => {
  const sentences = Array.from(
    { length: 50 },
    (_, i) => `This is sentence number ${i + 1} with some filler words added to bump the token count up.`,
  );
  const prose = sentences.join(" ");

  it("never splits mid-sentence — every chunk ends on sentence punctuation", () => {
    const chunks = chunkText(prose, { targetTokens: 60, maxTokens: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(/[.!?]$/.test(c.text.trim())).toBe(true);
    }
  });

  it("preserves every sentence verbatim (no loss, no breakage)", () => {
    const chunks = chunkText(prose, { targetTokens: 60, maxTokens: 200 });
    for (const s of sentences) {
      expect(chunks.some((c) => c.text.includes(s))).toBe(true);
    }
  });

  it("assigns sequential 0-based indices", () => {
    const chunks = chunkText(prose, { targetTokens: 60, maxTokens: 200 });
    chunks.forEach((c, i) => expect(c.index).toBe(i));
  });

  it("is deterministic", () => {
    const a = chunkText(prose, { targetTokens: 60, maxTokens: 200 });
    const b = chunkText(prose, { targetTokens: 60, maxTokens: 200 });
    expect(b.map((c) => c.text)).toEqual(a.map((c) => c.text));
  });

  it("keeps each chunk within a bounded size of the target", () => {
    const chunks = chunkText(prose, { targetTokens: 60, maxTokens: 200 });
    for (const c of chunks) {
      // packing flushes before exceeding target, so a chunk is at most
      // target + one unit (a single sentence here, ~20 tokens) ≤ maxTokens.
      expect(c.tokenEstimate).toBeLessThanOrEqual(200);
    }
  });

  it("hard-splits a single oversize sentence (no punctuation) without losing words", () => {
    const giant = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkText(giant, { targetTokens: 50, maxTokens: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    const reassembled = chunks.map((c) => c.text).join(" ").split(/\s+/).sort();
    expect(reassembled).toEqual(giant.split(/\s+/).sort());
  });

  it("returns no chunks for empty/whitespace input", () => {
    expect(chunkText("", { targetTokens: 60, maxTokens: 200 })).toEqual([]);
    expect(chunkText("   \n\n  ", { targetTokens: 60, maxTokens: 200 })).toEqual([]);
  });
});
