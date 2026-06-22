/**
 * gateway/src/openai/errors.ts — OpenAI-shaped error taxonomy.
 *
 * OpenAI SDKs parse error.type to drive retry/severity, so every gateway error
 * is mapped to a concrete {message, type, code} triple and the documented HTTP
 * status. Marketplace SDK errors (SupplierError/IndexerError/ReceiptVerification
 * Error) and TxConstructionError are translated here.
 */

import { ReceiptVerificationError, IndexerError, SupplierError } from "@marketplace/buyer/sdk";
import { TxConstructionError } from "@marketplace/shared/tx";

export type OpenAiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "rate_limit_error"
  | "server_error";

export class GatewayError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly type: OpenAiErrorType,
    public readonly code: string,
    message: string,
    /** Optional vendor extension fields merged alongside `error` in the body. */
    public readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

export const badRequest = (code: string, message: string): GatewayError =>
  new GatewayError(400, "invalid_request_error", code, message);
export const unauthorized = (message = "invalid API key"): GatewayError =>
  new GatewayError(401, "authentication_error", "invalid_api_key", message);
export const paymentRequired = (message: string, extra?: Record<string, unknown>): GatewayError =>
  new GatewayError(402, "invalid_request_error", "insufficient_funds", message, extra);
export const notFound = (code: string, message: string): GatewayError =>
  new GatewayError(404, "invalid_request_error", code, message);
export const rateLimited = (message: string): GatewayError =>
  new GatewayError(429, "rate_limit_error", "rate_limit_exceeded", message);

/** Render the body OpenAI clients expect: {error:{message,type,code,param}}. */
export function toErrorBody(err: GatewayError): Record<string, unknown> {
  return {
    error: { message: err.message, type: err.type, code: err.code, param: null },
    ...(err.extra ?? {}),
  };
}

/** Map any thrown value to a GatewayError. */
export function toGatewayError(err: unknown): GatewayError {
  if (err instanceof GatewayError) return err;

  if (err instanceof SupplierError) {
    if (err.reason === "timeout") {
      return new GatewayError(504, "server_error", "supplier_timeout", "supplier timed out");
    }
    if (err.reason === "supplier_busy") {
      return new GatewayError(503, "server_error", "overloaded", "all matching suppliers are busy");
    }
    return new GatewayError(502, "server_error", "upstream_error", `supplier error: ${err.reason}`);
  }
  if (err instanceof ReceiptVerificationError) {
    return new GatewayError(502, "server_error", "receipt_verification_failed", `receipt invalid: ${err.reason}`);
  }
  if (err instanceof IndexerError) {
    return new GatewayError(502, "server_error", "indexer_error", `indexer error: ${err.reason}`);
  }
  if (err instanceof TxConstructionError) {
    return new GatewayError(502, "server_error", "escrow_failed", `escrow build failed: ${err.reason}`);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new GatewayError(500, "server_error", "internal_error", message);
}
