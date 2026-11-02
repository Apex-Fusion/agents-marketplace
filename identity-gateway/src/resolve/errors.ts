// Error model of the resolver: the DID Resolution v1.0 error types this resolver returns, each with
// the HTTP status of the HTTPS binding (Part 1 Section 7.4).

export type ResolutionErrorType =
  | "INVALID_DID"
  | "INVALID_OPTIONS"
  | "NOT_FOUND"
  | "METHOD_NOT_SUPPORTED"
  | "FEATURE_NOT_SUPPORTED"
  | "REPRESENTATION_NOT_SUPPORTED"
  | "INTERNAL_ERROR";

export const ERROR_HTTP_STATUS: Record<ResolutionErrorType, number> = {
  INVALID_DID: 400,
  INVALID_OPTIONS: 400,
  NOT_FOUND: 404,
  REPRESENTATION_NOT_SUPPORTED: 406,
  METHOD_NOT_SUPPORTED: 501,
  FEATURE_NOT_SUPPORTED: 501,
  INTERNAL_ERROR: 500,
};

export const errorTypeUri = (type: ResolutionErrorType): string => `https://www.w3.org/ns/did#${type}`;

/**
 * An expected resolution outcome that is not a DID document: bad input, unknown DID, unsupported
 * request. The title is free text (Part 1 Section 8.2 lets it differ between resolvers).
 */
export class ResolutionError extends Error {
  constructor(
    readonly type: ResolutionErrorType,
    readonly title: string,
  ) {
    super(title);
    this.name = "ResolutionError";
  }
}
