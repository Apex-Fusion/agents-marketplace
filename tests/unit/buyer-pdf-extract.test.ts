/**
 * buyer-pdf-extract.test.ts — extraction error handling. A non-PDF buffer must
 * surface as a structured PdfExtractionError (not an unhandled throw), so the
 * upload route can map it to a clean 4xx.
 */

import { describe, it, expect } from "vitest";
import { extractPdfText } from "../../buyer/src/pdf/extract.js";
import { PdfExtractionError } from "../../buyer/src/pdf/types.js";

describe("extractPdfText", () => {
  it("throws a structured PdfExtractionError on a non-PDF buffer", async () => {
    await expect(extractPdfText(Buffer.from("definitely not a pdf"))).rejects.toBeInstanceOf(
      PdfExtractionError,
    );
  });

  it("error carries a machine-readable reason", async () => {
    try {
      await extractPdfText(Buffer.from("nope"));
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PdfExtractionError);
      expect((e as PdfExtractionError).reason).toBeTruthy();
    }
  });
});
