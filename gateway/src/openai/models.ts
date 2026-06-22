/**
 * gateway/src/openai/models.ts — GET /openai/v1/models.
 *
 * Distinct models advertised by Active suppliers, in the OpenAI list shape.
 */

import type { Request, Response } from "express";
import type { GatewayDeps } from "../deps.js";
import { asyncHandler } from "../middleware/http.js";
import { listModels } from "../routing/selectSupplier.js";
import { buildModelsList } from "./shapes.js";

export function makeModelsHandler(deps: GatewayDeps) {
  return asyncHandler(async (_req: Request, res: Response) => {
    const models = await listModels({ indexerUrl: deps.config.indexerUrl, fetchFn: deps.fetchFn });
    res.status(200).json(buildModelsList(models));
  });
}
