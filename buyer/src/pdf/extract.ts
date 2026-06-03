/**
 * buyer/src/pdf/extract.ts — text extraction from an uploaded PDF buffer.
 *
 * Text-based PDFs only (v1 has no OCR). Scanned/image-only PDFs extract
 * almost no text; we detect that via a chars-per-page floor and reject with
 * a clear `scanned_or_image_pdf` reason so the UI can tell the operator why.
 *
 * We require `pdf-parse/lib/pdf-parse.js` directly (not the package index)
 * because pdf-parse's index.js runs a debug block that reads a bundled test
 * PDF when `module.parent` is falsy — which is exactly the case under ESM/tsx
 * and would crash on import. The lib entry is the pure function.
 */

import { createRequire } from "module";
import { PdfExtractionError } from "./types.js";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
  data: Buffer,
  opts?: Record<string, unknown>,
) => Promise<{ text: string; numpages: number }>;

/** Below this many extracted chars per page we treat the PDF as scanned. */
const MIN_CHARS_PER_PAGE = 50;

export interface ExtractResult {
  text: string;
  pageCount: number;
}

export async function extractPdfText(buf: Buffer): Promise<ExtractResult> {
  let parsed: { text: string; numpages: number };
  try {
    parsed = await pdfParse(buf);
  } catch (err) {
    throw new PdfExtractionError(
      "pdf_parse_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  const text = (parsed.text ?? "").trim();
  const pageCount = parsed.numpages ?? 0;

  if (
    text.length === 0 ||
    (pageCount > 0 && text.length / pageCount < MIN_CHARS_PER_PAGE)
  ) {
    throw new PdfExtractionError(
      "scanned_or_image_pdf",
      `extracted only ${text.length} chars across ${pageCount} page(s) — ` +
        `looks scanned/image-only, which v1 can't summarize (no OCR)`,
    );
  }

  return { text, pageCount };
}
