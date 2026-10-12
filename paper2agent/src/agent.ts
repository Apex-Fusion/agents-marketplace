import { randomUUID } from "node:crypto";
import type { PaperBuildBudget } from "@marketplace/shared/paper2agent/workflow";
import { requestDeadline } from "./deadline.js";

export interface BuildModelConfig { baseUrl: string; model: string; apiKey?: string }
export interface ModelUsage { calls: number; inputTokens: number | null; outputTokens: number | null }
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (arguments_: Record<string, unknown>) => Promise<unknown>;
}
interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
interface AgentMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
interface ModelResponse {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
export interface AgentRunResult { runId: string; result: Record<string, unknown> }
export interface AgentSessionOptions {
  model: BuildModelConfig;
  budget: PaperBuildBudget;
  usage: ModelUsage;
  signal: AbortSignal;
  system: string;
  task: string;
  tools: AgentTool[];
  finishSchema: Record<string, unknown>;
  validateFinish: (value: Record<string, unknown>) => void;
  log: (message: string) => void;
}

/** Each invocation has a new conversation and run identity; verifier context is never reused. */
export async function runCodingAgent(options: AgentSessionOptions): Promise<AgentRunResult> {
  const runId = randomUUID();
  const messages: AgentMessage[] = [{ role: "system", content: options.system }, { role: "user", content: options.task }];
  const tools = options.tools.map((tool) => ({ type: "function", function: {
    name: tool.name, description: tool.description, parameters: tool.parameters,
  } }));
  tools.push({ type: "function", function: { name: "finish", description: "Finish only after the requested files and execution evidence exist.", parameters: options.finishSchema } });
  const endpoint = `${options.model.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  while (options.usage.calls < options.budget.max_model_calls) {
    options.signal.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(messages)) > 220_000) throw new Error("Coding-agent context exceeds limit");
    options.usage.calls++;
    options.log(`Model call ${options.usage.calls}/${options.budget.max_model_calls} (${runId})`);
    const deadline = requestDeadline(180_000, options.signal);
    let body: ModelResponse;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(options.model.apiKey ? { Authorization: `Bearer ${options.model.apiKey}` } : {}) },
        body: JSON.stringify({ model: options.model.model, messages, tools, tool_choice: "auto", parallel_tool_calls: false,
          max_completion_tokens: options.budget.max_output_tokens, stream: false }),
        signal: deadline.signal,
        redirect: "error",
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Coding model returned HTTP ${response.status}`); }
      if (!response.body) throw new Error("Coding model returned an empty response");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error("Coding model response exceeds limit"); }
          chunks.push(chunk.value);
        }
      } finally { reader.releaseLock(); }
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ModelResponse;
    } finally { deadline.dispose(); }
    const usage = body.usage;
    options.usage.inputTokens = options.usage.inputTokens !== null && Number.isSafeInteger(usage?.prompt_tokens) && usage!.prompt_tokens! >= 0
      ? options.usage.inputTokens + usage!.prompt_tokens! : null;
    options.usage.outputTokens = options.usage.outputTokens !== null && Number.isSafeInteger(usage?.completion_tokens) && usage!.completion_tokens! >= 0
      ? options.usage.outputTokens + usage!.completion_tokens! : null;
    const message = body.choices?.[0]?.message;
    if (!message || (message.content !== undefined && message.content !== null && typeof message.content !== "string")) throw new Error("Coding model returned an invalid message");
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 8) throw new Error("Coding model tool-call limit exceeded");
    messages.push({ role: "assistant", content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) });
    if (calls.length === 0) {
      const reason = typeof message.content === "string" ? message.content.slice(0, 2000) : "";
      throw new Error(`Coding agent stopped without completed package evidence${reason ? `: ${reason}` : ""}`);
    }
    for (const call of calls) {
      if (typeof call.id !== "string" || call.id.length > 200 || call.type !== "function" ||
          typeof call.function?.name !== "string" || typeof call.function.arguments !== "string" || call.function.arguments.length > 100_000) {
        throw new Error("Coding model returned an invalid tool call");
      }
      let result: unknown;
      try {
        const arguments_: unknown = JSON.parse(call.function.arguments);
        if (!arguments_ || typeof arguments_ !== "object" || Array.isArray(arguments_)) throw new Error("Tool arguments must be an object");
        if (call.function.name === "finish") {
          if (calls.length !== 1) throw new Error("finish must be the only tool call");
          options.validateFinish(arguments_ as Record<string, unknown>);
          return { runId, result: arguments_ as Record<string, unknown> };
        }
        const tool = options.tools.find((item) => item.name === call.function.name);
        if (!tool) throw new Error("Unknown build tool");
        options.log(`Tool: ${tool.name}`);
        result = await tool.execute(arguments_ as Record<string, unknown>);
      } catch (error) {
        options.signal.throwIfAborted();
        result = { error: error instanceof Error ? error.message.slice(0, 4000) : "Build tool failed" };
      }
      let content = JSON.stringify(result);
      if (content.length > 16_000) content = JSON.stringify({ truncated: true, text: content.slice(0, 15_000) });
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
  throw new Error("Coding-agent model-call budget exhausted");
}
