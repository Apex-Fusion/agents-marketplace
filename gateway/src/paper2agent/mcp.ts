import { createMcpHandler, Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { Paper2AgentClient } from "@marketplace/buyer/sdk/paper2agent";
import {
  paper2AgentToolName,
  validatePaper2AgentInput,
  validatePaper2AgentOutput,
  type JsonObject,
} from "@marketplace/shared/paper2agent";
import type { NextFunction, Request, Response } from "express";
import type { GatewayDeps } from "../deps.js";
import { requireKey } from "../middleware/apiKeyAuth.js";
import { asyncHandler, requestAbortSignal, sendError } from "../middleware/http.js";
import { badRequest, forbidden, GatewayError, notFound } from "../openai/errors.js";
import { executePaper2AgentCall, getPaper2AgentCall, isPaper2AgentOnlyKey, listPaper2AgentCalls } from "./service.js";

// Shared manifests require object roots and use draft-07. MCP defaults to a
// newer dialect when $schema is absent. Annotate copies, not signed manifests.
function mcpSchema(schema: JsonObject): Tool["inputSchema"] {
  return { $schema: "http://json-schema.org/draft-07/schema#", ...schema, type: "object" };
}

/** A dedicated approval key cannot bypass its limits through a different API. */
export function denyOtherPaper2AgentSpending(deps: GatewayDeps) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (isPaper2AgentOnlyKey(deps.store, requireKey(req).id)) {
      sendError(res, forbidden("paper2agent_key_restricted", "this key only permits approved Paper2Agent calls"));
      return;
    }
    next();
  };
}

export function makePaper2AgentJobHandler(deps: GatewayDeps) {
  return asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const job = await getPaper2AgentCall(deps, requireKey(req).id, String(req.params.id));
    if (job === undefined) throw notFound("paper2agent_job_not_found", "job not found");
    res.json(job);
  });
}

export function makePaper2AgentJobsHandler(deps: GatewayDeps) {
  return asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const cursor = req.query.cursor;
    if (cursor !== undefined && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 128)) {
      throw badRequest("paper2agent_invalid_cursor", "invalid job cursor");
    }
    res.json(await listPaper2AgentCalls(deps, requireKey(req).id, cursor));
  });
}

/**
 * Official per-request Streamable HTTP serving, including the SDK's stateless
 * 2025 transport. No session or authenticated principal survives a request.
 * The low-level Server preserves the supplier's validated JSON Schemas rather
 * than translating them into a different schema language.
 */
export function makePaper2AgentMcpHandler(deps: GatewayDeps) {
  return asyncHandler(async (req, res) => {
    const key = requireKey(req);
    res.setHeader("Cache-Control", "no-store");
    const origin = req.header("origin");
    if (origin !== undefined && !deps.config.corsOrigins.includes(origin)) {
      throw forbidden("mcp_origin_denied", "MCP origin is not allowed");
    }
    const disconnected = requestAbortSignal(res);
    const handler = createMcpHandler(() => {
      const server = new Server({ name: "vector-paper2agent", version: "1.0.0" }, {
        capabilities: { tools: {} },
      });
      const discover = async (filters?: Parameters<Paper2AgentClient["discover"]>[0]) => {
        const ctx = deps.registry.getContext(key);
        const client = new Paper2AgentClient({
          chain: ctx.chain, walletKey: ctx.walletKey,
          indexerUrl: deps.config.indexerUrl, fetchFn: deps.fetchFn,
        });
        const offers = await client.discover(filters);
        const tools = new Map<string, (typeof offers)[number]>();
        const collisions = new Set<string>();
        for (const offer of offers) {
          const name = paper2AgentToolName(offer.manifest);
          if (collisions.has(name)) continue;
          const previous = tools.get(name);
          if (previous && previous.manifestHash !== offer.manifestHash) {
            tools.delete(name);
            collisions.add(name);
            continue;
          }
          tools.set(name, offer);
        }
        return tools;
      };
      server.setRequestHandler("tools/list", async () => ({
        tools: [...(await discover()).entries()].map(([name, offer]): Tool => ({
          name,
          description: offer.manifest.description,
          inputSchema: mcpSchema(offer.manifest.input_schema),
          outputSchema: mcpSchema(offer.manifest.output_schema),
          annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        })),
      }));
      server.setRequestHandler("tools/call", async (request, ctx): Promise<CallToolResult> => {
        try {
          if (key.demo) throw forbidden("demo_key_restricted", "Paper2Agent spending is disabled for demo keys");
          const approval = deps.store.paper2agent.approval(key.id);
          if (!approval || approval.revoked) throw forbidden("paper2agent_not_approved", "this key has no active tool approval");
          const offer = (await discover({ manifestHash: approval.manifest_hash, supplierPkh: approval.supplier_pkh })).get(request.params.name);
          if (!offer) throw notFound("paper2agent_tool_not_found", "tool is not currently available");
          let input;
          try {
            input = validatePaper2AgentInput(offer.manifest, request.params.arguments ?? {});
          } catch {
            throw badRequest("paper2agent_invalid_input", "tool arguments do not match the approved input schema");
          }
          // Exactly one admission. Disconnects cancel only unfunded admission;
          // the money service retains funded jobs for settlement and recovery.
          const call = await executePaper2AgentCall(deps, key, {
            manifestHash: offer.manifestHash, input,
          }, AbortSignal.any([disconnected, ctx.mcpReq.signal]));
          const result = validatePaper2AgentOutput(offer.manifest, call.result);
          return server.projectCallToolResult({
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            _meta: {
              vector: {
                job_id: call.job_id,
                receipt: call.receipt,
                receipt_signature: call.receipt_signature,
                pub_key_hex: call.pub_key_hex,
                escrow_ref: call.escrow_ref,
                submitted_ref: call.submitted_ref,
                financial: call.financial,
              },
            },
          }, mcpSchema(offer.manifest.output_schema));
        } catch (error) {
          const known = error instanceof GatewayError;
          return {
            isError: true,
            content: [{ type: "text", text: known ? error.message : "Paper2Agent call failed. Check job status before another call." }],
            _meta: { vector: {
              ...(known ? error.extra : undefined),
              code: known ? error.code : "paper2agent_call_failed",
              http_status: known ? error.httpStatus : 500,
            } },
          };
        }
      });
      return server;
    }, { legacy: "stateless", responseMode: "json", maxRequestBodySize: 1024 * 1024 });
    try {
      await toNodeHandler(handler)(req, res, req.body);
    } finally {
      await handler.close();
    }
  });
}
