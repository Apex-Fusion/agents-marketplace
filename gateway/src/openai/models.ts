/**
 * gateway/src/openai/models.ts — GET /openai/v1/models.
 *
 * Distinct Active models reachable by this key, in the OpenAI list shape.
 */

import type { Request, Response } from "express";
import type { GatewayDeps } from "../deps.js";
import { asyncHandler } from "../middleware/http.js";
import { requireKey } from "../middleware/apiKeyAuth.js";
import { listModels } from "../routing/selectSupplier.js";
import { buildModelsList } from "./shapes.js";
import { CAPABILITY as CHAT_CAPABILITY } from "./sessions.js";

export function makeModelsHandler(deps: GatewayDeps) {
  return asyncHandler(async (req: Request, res: Response) => {
    const keyRow = requireKey(req);
    // Both inference APIs use one-shot suppliers for normal keys and managed
    // chat suppliers for demo keys. Do not list models this key cannot route.
    const models = await listModels({
      indexerUrl: deps.config.indexerUrl,
      capabilityId: keyRow.demo ? CHAT_CAPABILITY : "llm.text.generate.v1",
      fetchFn: deps.fetchFn,
    });
    res.status(200).json(buildModelsList(models));
  });
}
