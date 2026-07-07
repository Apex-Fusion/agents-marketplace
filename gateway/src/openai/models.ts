/**
 * gateway/src/openai/models.ts — GET /openai/v1/models.
 *
 * Distinct models advertised by Active suppliers, in the OpenAI list shape.
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
    // Demo keys only reach chat-capable suppliers (session-backed executor).
    const models = await listModels({
      indexerUrl: deps.config.indexerUrl,
      capabilityId: keyRow.demo ? CHAT_CAPABILITY : undefined,
      fetchFn: deps.fetchFn,
    });
    res.status(200).json(buildModelsList(models));
  });
}
