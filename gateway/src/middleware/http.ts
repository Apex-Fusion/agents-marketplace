/**
 * gateway/src/middleware/http.ts — Express response/error helpers.
 */

import type { Request, Response } from "express";
import { GatewayError, toGatewayError, toErrorBody } from "../openai/errors.js";

/** Send a GatewayError (or any error) as an OpenAI-shaped JSON error response. */
export function sendError(res: Response, err: unknown): void {
  const ge = err instanceof GatewayError ? err : toGatewayError(err);
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(ge.httpStatus).json(toErrorBody(ge));
}

/** Wrap an async handler so rejections are mapped to error responses. */
export function asyncHandler(
  fn: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response) => void {
  return (req, res) => {
    fn(req, res).catch((err) => sendError(res, err));
  };
}
