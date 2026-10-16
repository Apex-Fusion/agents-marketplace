import { createMcpHandler, Server, type CallToolResult, type Tool } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { validatePaper2AgentInput, type JsonObject } from "@marketplace/shared/paper2agent";
import type { GatewayDeps } from "../deps.js";
import { asyncHandler, requestAbortSignal } from "../middleware/http.js";
import { forbidden } from "../openai/errors.js";
import { createToolCatalog } from "./catalog.js";
import { FreeToolCalls, ToolCallError } from "./service.js";

// Make the MCP dialect explicit on copies, without changing signed manifests.
function mcpSchema(schema: JsonObject): Tool["inputSchema"] {
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...schema, type: "object" };
}

/**
 * Public, free Paper2Agent MCP. Official per-request Streamable HTTP serving,
 * including the SDK's stateless 2025 transport; no session survives a request.
 * No API key: limits are per client IP (`req.ip`) and per gateway. The low-level
 * Server keeps the supplier's validated JSON Schemas unchanged.
 */
export function makePaper2AgentMcpHandler(deps: GatewayDeps) {
  const catalog = createToolCatalog(deps);
  const calls = new FreeToolCalls(deps);
  return asyncHandler(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const origin = req.header("origin");
    if (origin !== undefined && !deps.config.corsOrigins.includes(origin)) {
      throw forbidden("mcp_origin_denied", "MCP origin is not allowed");
    }
    const ip = req.ip ?? "unknown";
    const disconnected = requestAbortSignal(res);
    const handler = createMcpHandler(() => {
      const server = new Server({ name: "vector-paper2agent", version: "1.0.0" }, {
        capabilities: { tools: {} },
      });
      server.setRequestHandler("tools/list", async () => ({
        tools: [...(await catalog()).entries()].map(([name, offer]): Tool => ({
          name,
          description: offer.manifest.description,
          inputSchema: mcpSchema(offer.manifest.input_schema),
          outputSchema: mcpSchema(offer.manifest.output_schema),
          // Free calls run in an offline, read-only container and spend nothing.
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        })),
      }));
      server.setRequestHandler("tools/call", async (request, ctx): Promise<CallToolResult> => {
        const started = Date.now();
        const tool = request.params.name.slice(0, 128);
        let status = "ok";
        try {
          const token = calls.admit(ip);
          const offer = (await catalog()).get(request.params.name);
          if (!offer) throw new ToolCallError("paper2agent_tool_not_found", "The tool is not currently available.");
          let input;
          try {
            input = validatePaper2AgentInput(offer.manifest, request.params.arguments ?? {});
          } catch {
            throw new ToolCallError("paper2agent_invalid_input", "The tool arguments do not match the tool's input schema.");
          }
          const call = await calls.call(ip, token, offer, input, AbortSignal.any([disconnected, ctx.mcpReq.signal]));
          return server.projectCallToolResult({
            content: [{ type: "text", text: JSON.stringify(call.result) }],
            structuredContent: call.result,
            _meta: {
              vector: {
                manifest_hash: call.manifest_hash,
                supplier_pkh: offer.advert.supplier_pkh,
                wallclock_ms: call.wallclock_ms,
              },
            },
          }, mcpSchema(offer.manifest.output_schema));
        } catch (error) {
          const known = error instanceof ToolCallError;
          status = known ? error.code : "paper2agent_call_failed";
          return {
            isError: true,
            content: [{ type: "text", text: known ? error.message : "The tool call failed. Try again later." }],
            _meta: { vector: { code: status } },
          };
        } finally {
          // One line per call; never the input or the result.
          console.log(JSON.stringify({ evt: "paper2agent_call", tool, status, duration_ms: Date.now() - started }));
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
