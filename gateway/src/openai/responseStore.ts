import type { GatewayDeps } from "../deps.js";
import type { StoredResponseRow } from "../db/store.js";
import { open, seal } from "../crypto/seal.js";
import {
  validateResponseToolOutputs,
  type ResponseItem,
  type ResponseObject,
  type ResponseRequest,
} from "@marketplace/shared/responses";
import { badRequest, notFound } from "./errors.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function decodeJson<T>(deps: GatewayDeps, sealed: { nonce: string; ct: string; tag: string }): T {
  return JSON.parse(open(sealed, deps.config.masterKeyHex)) as T;
}

export interface ResponseChain {
  parent: StoredResponseRow;
  history: ResponseItem[];
}

export function loadResponseChain(deps: GatewayDeps, keyId: string, responseId: string): ResponseChain {
  deps.store.deleteExpiredResponses();
  const parent = deps.store.getOwnedResponse(responseId, keyId);
  if (!parent || parent.stored !== 1 ||
      (parent.status !== "completed" && parent.status !== "incomplete") ||
      !parent.response_nonce || !parent.response_ct || !parent.response_tag) {
    throw notFound("response_not_found", "response not found");
  }

  const rows: StoredResponseRow[] = [];
  const seen = new Set<string>();
  let cursor: StoredResponseRow | undefined = parent;
  while (cursor) {
    if (seen.has(cursor.id) || cursor.key_id !== keyId || cursor.stored !== 1 ||
        (cursor.status !== "completed" && cursor.status !== "incomplete")) {
      throw badRequest("invalid_response_chain", "stored response chain is incomplete");
    }
    seen.add(cursor.id);
    rows.push(cursor);
    if (cursor.previous_response_id) {
      const ancestor = deps.store.getOwnedResponse(cursor.previous_response_id, keyId);
      if (!ancestor) throw badRequest("invalid_response_chain", "stored response chain is incomplete");
      cursor = ancestor;
    } else {
      cursor = undefined;
    }
    if (rows.length > 10_000) throw badRequest("invalid_response_chain", "stored response chain is too deep");
  }

  const history: ResponseItem[] = [];
  for (const row of rows.reverse()) {
    const input = decodeJson<ResponseItem[]>(deps, { nonce: row.input_nonce, ct: row.input_ct, tag: row.input_tag });
    if (!row.response_nonce || !row.response_ct || !row.response_tag) {
      throw badRequest("invalid_response_chain", "stored response chain has no terminal result");
    }
    const response = decodeJson<ResponseObject>(deps, {
      nonce: row.response_nonce,
      ct: row.response_ct,
      tag: row.response_tag,
    });
    history.push(...input, ...response.output);
  }
  try {
    validateResponseToolOutputs(history);
  } catch (error) {
    throw badRequest("invalid_response_chain", error instanceof Error ? error.message : String(error));
  }
  return { parent, history };
}

export function insertPendingResponse(deps: GatewayDeps, args: {
  id: string;
  keyId: string;
  model: string;
  previousResponseId?: string;
  request: ResponseRequest;
}): void {
  const encryptedInput = seal(JSON.stringify(args.request.input), deps.config.masterKeyHex);
  const now = Date.now();
  deps.store.insertResponse({
    id: args.id,
    key_id: args.keyId,
    model: args.model,
    previous_response_id: args.previousResponseId ?? null,
    session_id: null,
    status: "in_progress",
    stored: 1,
    created_at: now,
    expires_at: now + RETENTION_MS,
    input_nonce: encryptedInput.nonce,
    input_ct: encryptedInput.ct,
    input_tag: encryptedInput.tag,
  });
}

export function completeStoredResponse(deps: GatewayDeps, args: {
  id: string;
  keyId: string;
  sessionId?: string;
  response: ResponseObject;
}): boolean {
  const encrypted = seal(JSON.stringify(args.response), deps.config.masterKeyHex);
  return deps.store.completeResponse(args.id, args.keyId, {
    status: args.response.status,
    session_id: args.sessionId ?? null,
    completed_at: Date.now(),
    response_nonce: encrypted.nonce,
    response_ct: encrypted.ct,
    response_tag: encrypted.tag,
  }, args.sessionId === undefined
    ? undefined
    : args.response.status === "completed" || args.response.status === "incomplete"
      ? args.id
      : null);
}

export function readStoredResponse(deps: GatewayDeps, keyId: string, responseId: string): ResponseObject {
  deps.store.deleteExpiredResponses();
  const row = deps.store.getOwnedResponse(responseId, keyId);
  if (!row || row.stored !== 1 || row.status === "in_progress" ||
      !row.response_nonce || !row.response_ct || !row.response_tag) {
    throw notFound("response_not_found", "response not found");
  }
  return decodeJson<ResponseObject>(deps, { nonce: row.response_nonce, ct: row.response_ct, tag: row.response_tag });
}
