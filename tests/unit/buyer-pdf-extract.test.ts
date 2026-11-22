/**
 * buyer-pdf-extract.test.ts — extraction error handling. A non-PDF buffer must
 * surface as a structured PdfExtractionError (not an unhandled throw), so the
 * upload route can map it to a clean 4xx.
 */

import { describe, it, expect } from "vitest";
import { extractPdfText } from "../../buyer/src/pdf/extract.js";
import { PdfExtractionError } from "../../buyer/src/pdf/types.js";

describe("extractPdfText", () => {
  it("throws a PdfExtractionError with the reason pdf_parse_failed on a non-PDF buffer", async () => {
    const error = await extractPdfText(Buffer.from("definitely not a pdf")).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(PdfExtractionError);
    expect((error as PdfExtractionError).reason).toBe("pdf_parse_failed");
  });
});
