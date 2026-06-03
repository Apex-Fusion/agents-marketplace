/**
 * buyer/src/pdf/chunk.ts — paragraph-aligned chunker.
 *
 * Splits extracted book text into ~targetTokens chunks WITHOUT ever cutting a
 * sentence in half (the unit of summarization should be coherent). Strategy:
 *
 *   1. Decompose text into "units" each ≤ maxTokens:
 *        paragraph  → if too big → sentences → if a sentence is still too big
 *        (rare) → hard word-split as a last resort.
 *   2. Greedily pack units into chunks, flushing before a unit would push the
 *      running chunk past targetTokens.
 *
 * Each chunk therefore contains whole sentences; the only place a sentence is
 * ever broken is a single sentence longer than maxTokens, which essentially
 * never happens in real prose.
 */

import { countTokens } from "./tokens.js";
import type { Chunk } from "./types.js";

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
}

/** Blank-line separated paragraphs, internal whitespace collapsed. */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 0);
}

/** Sentence-ish split: keep terminal punctuation attached to its sentence. */
function splitSentences(paragraph: string): string[] {
  const matches = paragraph.match(/[^.!?]+[.!?]+(?:\s|$)|[^.!?]+$/g);
  if (!matches) return [paragraph];
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Last-resort split of a single oversize sentence by word count. */
function hardSplitByTokens(s: string, maxTokens: number): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const total = countTokens(s) || 1;
  const wordsPerChunk = Math.max(1, Math.floor((words.length * maxTokens) / total));
  const out: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    out.push(words.slice(i, i + wordsPerChunk).join(" "));
  }
  return out.length > 0 ? out : [s];
}

/** Decompose text into coherent units each ≤ maxTokens. */
function toUnits(text: string, maxTokens: number): string[] {
  const units: string[] = [];
  for (const para of splitParagraphs(text)) {
    if (countTokens(para) <= maxTokens) {
      units.push(para);
      continue;
    }
    for (const sent of splitSentences(para)) {
      if (countTokens(sent) <= maxTokens) {
        units.push(sent);
      } else {
        units.push(...hardSplitByTokens(sent, maxTokens));
      }
    }
  }
  return units;
}

export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const { targetTokens, maxTokens } = opts;
  const units = toUnits(text, maxTokens);

  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let bufTokens = 0;

  const flush = (): void => {
    if (buf.length === 0) return;
    chunks.push({
      index: chunks.length,
      text: buf.join("\n\n"),
      tokenEstimate: bufTokens,
    });
    buf = [];
    bufTokens = 0;
  };

  for (const unit of units) {
    const ut = countTokens(unit);
    if (bufTokens > 0 && bufTokens + ut > targetTokens) flush();
    buf.push(unit);
    bufTokens += ut;
  }
  flush();

  return chunks;
}
