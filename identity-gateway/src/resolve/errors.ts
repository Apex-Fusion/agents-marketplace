// Error model of the resolver: the DID Resolution v1.0 error types this resolver can return
// (https://www.w3.org/TR/did-resolution/ Section 10), each with the HTTP status the HTTPS binding
// maps it to (Section 11).

export type ResolutionErrorType =
  | "INVALID_DID"
  | "NOT_FOUND"
  | "METHOD_NOT_SUPPORTED"
  | "FEATURE_NOT_SUPPORTED"
  | "REPRESENTATION_NOT_SUPPORTED"
  | "INTERNAL_ERROR";

export const ERROR_HTTP_STATUS: Record<ResolutionErrorType, number> = {
  INVALID_DID: 400,
  NOT_FOUND: 404,
  REPRESENTATION_NOT_SUPPORTED: 406,
  METHOD_NOT_SUPPORTED: 501,
  FEATURE_NOT_SUPPORTED: 501,
  INTERNAL_ERROR: 500,
};

export const errorTypeUri = (type: ResolutionErrorType): string => `https://www.w3.org/ns/did#${type}`;

/** An expected resolution outcome that is not a DID document: bad input, unknown DID, unsupported request. */
export class ResolutionError extends Error {
  constructor(
    readonly type: ResolutionErrorType,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ? `${title}: ${detail}` : title);
    this.name = "ResolutionError";
  }
}
