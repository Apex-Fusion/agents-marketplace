import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export interface BuildModelConfig { baseUrl: string; model: string; apiKey?: string }
export interface ModelUsage { calls: number; inputTokens: number | null; outputTokens: number | null }
/** Why the wallet cannot pay for the next model call. */
export interface FundsShortfall {
  message: string;
  requiredLovelace: string | null;
  availableLovelace: string | null;
  depositAddress: string | null;
}
/** The wallet cannot pay for the next model call. The refused request spent nothing. */
export class InsufficientFundsError extends Error {
  constructor(readonly shortfall: FundsShortfall) {
    super(shortfall.message);
  }
}
/** A finish validation error that ends the run instead of returning to the model. */
export class FatalFinishError extends Error {}
export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (arguments_: Record<string, unknown>) => Promise<unknown>;
}
interface ToolCall { id: string; type: "function"; function: { name: string; arguments: string } }
interface AgentMessage { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string }
interface ToolSpec { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
interface ModelResponse {
  choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: ToolCall[] } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
export interface AgentRunResult { runId: string; result: Record<string, unknown> }
export interface AgentSessionOptions {
  model: BuildModelConfig;
  usage: ModelUsage;
  signal: AbortSignal;
  system: string;
  task: string;
  tools: AgentTool[];
  finishSchema: Record<string, unknown>;
  /** Each error returns to the model as the finish result; a FatalFinishError ends the run. */
  validateFinish: (value: Record<string, unknown>) => void | Promise<void>;
  log: (message: string) => void;
  /** Wait before resending a model call that the wallet cannot pay for. */
  fundsRetryMs: number;
  /** Wait before resending a failed model call, times the number of failures in a row. */
  failureRetryMs: number;
  /** Every refusal of the waiting model call, before the next wait. */
  onFundsShortfall: (shortfall: FundsShortfall) => void;
  /** The refused model call succeeded; called once per pause. */
  onFundsRestored: () => void;
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BYTES = 64 * 1024;
const LOVELACE = /^(?:0|[1-9][0-9]{0,19})$/;
/** Calls may land on different marketplace models; this many failed or tool-less replies in a row end the run. */
const MAX_MODEL_MISSES = 3;
const ADDRESS = /^addr(?:_test)?1[02-9ac-hj-np-z]{20,200}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

async function boundedBody(response: Response, maximum: number): Promise<string> {
  if (!response.body) throw new Error("Coding model returned an empty response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error("Coding model response exceeds limit"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * HTTP 402 insufficient_funds in the gateway shape `{error:{code,message},x_vector:{amounts}}`
 * or the buyer shape `{error:"insufficient_funds",message,...amounts}`.
 */
function fundsShortfall(text: string): FundsShortfall | null {
  let body: Record<string, unknown> | null;
  try { body = record(JSON.parse(text)); } catch { return null; }
  if (!body) return null;
  const nested = record(body.error);
  if ((nested ? nested.code : body.error) !== "insufficient_funds") return null;
  const message = nested ? nested.message : body.message;
  const details = record(body.x_vector) ?? body;
  const matching = (value: unknown, pattern: RegExp): string | null => typeof value === "string" && pattern.test(value) ? value : null;
  return {
    message: typeof message === "string" && message.trim() !== ""
      ? message.slice(0, 500) : "The wallet cannot pay for the next model call",
    requiredLovelace: matching(details.required_lovelace, LOVELACE),
    availableLovelace: matching(details.available_lovelace, LOVELACE),
    depositAddress: matching(details.deposit_address, ADDRESS),
  };
}

/** One paid model request. Throws InsufficientFundsError when the wallet cannot pay for it. */
async function requestModel(model: BuildModelConfig, messages: AgentMessage[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelResponse> {
  const response = await fetch(`${model.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(model.apiKey ? { Authorization: `Bearer ${model.apiKey}` } : {}) },
    body: JSON.stringify({ model: model.model, messages, tools, tool_choice: "auto", parallel_tool_calls: false, stream: false }),
    signal,
    redirect: "error",
  });
  if (!response.ok) {
    const text = await boundedBody(response, MAX_ERROR_BYTES).catch(() => "");
    const shortfall = response.status === 402 ? fundsShortfall(text) : null;
    if (shortfall) throw new InsufficientFundsError(shortfall);
    let code: unknown;
    try {
      const body = record(JSON.parse(text));
      const nested = record(body?.error);
      code = nested ? nested.code : body?.error;
    } catch { /* non-JSON error body */ }
    throw new Error(`Coding model returned HTTP ${response.status}${typeof code === "string" ? ` (${code.slice(0, 100)})` : ""}`);
  }
  return JSON.parse(await boundedBody(response, MAX_RESPONSE_BYTES)) as ModelResponse;
}

/**
 * A finish check whose failures return to the model, so it can repair its work and finish again.
 * The failure after `maxRepairs` repairs ends the run with that failure's message.
 */
export function repairableFinishCheck(maxRepairs: number, signal: AbortSignal, log: (message: string) => void,
  check: (value: Record<string, unknown>) => Promise<void>): (value: Record<string, unknown>) => Promise<void> {
  let failures = 0;
  return async (value) => {
    try {
      await check(value);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof FatalFinishError) throw error;
      failures += 1;
      const reason = error instanceof Error ? error.message : String(error);
      if (failures > maxRepairs) {
        log(`Final check failed (no repairs left): ${reason.slice(0, 500)}`);
        throw new FatalFinishError(reason, { cause: error });
      }
      const failure = `Final check failed (repair ${failures} of ${maxRepairs}): ${reason}`;
      log(failure.slice(0, 600));
      throw new Error(failure, { cause: error });
    }
  };
}

/**
 * Each invocation has a new conversation and run identity; verifier context is never reused.
 * There is no call, token, or time limit. A call the wallet cannot pay for is sent again
 * after `fundsRetryMs` until it succeeds or the build is stopped. A failed call is retried
 * after `failureRetryMs` times the misses in a row, and a reply without a tool call at once;
 * MAX_MODEL_MISSES in a row end the run.
 */
export async function runCodingAgent(options: AgentSessionOptions): Promise<AgentRunResult> {
  const runId = randomUUID();
  const messages: AgentMessage[] = [{ role: "system", content: options.system }, { role: "user", content: options.task }];
  const tools: ToolSpec[] = options.tools.map((tool) => ({ type: "function", function: {
    name: tool.name, description: tool.description, parameters: tool.parameters,
  } }));
  tools.push({ type: "function", function: { name: "finish", description: "Finish only after the requested files and execution evidence exist.", parameters: options.finishSchema } });
  let paused = false;
  let misses = 0;
  while (true) {
    options.signal.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(messages)) > 220_000) throw new Error("Coding-agent context exceeds limit");
    const callNumber = options.usage.calls + 1;
    if (!paused) options.log(`Model call ${callNumber} (${runId})`);
    let body: ModelResponse;
    try {
      body = await requestModel(options.model, messages, tools, options.signal);
    } catch (error) {
      options.signal.throwIfAborted();
      if (!(error instanceof InsufficientFundsError)) {
        if (++misses >= MAX_MODEL_MISSES) throw error;
        options.log(`Model call ${callNumber} failed: ${error instanceof Error ? error.message.slice(0, 300) : "unknown error"}; retrying`);
        await sleep(options.failureRetryMs * misses, undefined, { signal: options.signal });
        continue;
      }
      options.onFundsShortfall(error.shortfall);
      paused = true;
      await sleep(options.fundsRetryMs, undefined, { signal: options.signal });
      continue;
    }
    options.usage.calls = callNumber;
    if (paused) {
      paused = false;
      options.onFundsRestored();
    }
    const usage = body.usage;
    options.usage.inputTokens = options.usage.inputTokens !== null && Number.isSafeInteger(usage?.prompt_tokens) && usage!.prompt_tokens! >= 0
      ? options.usage.inputTokens + usage!.prompt_tokens! : null;
    options.usage.outputTokens = options.usage.outputTokens !== null && Number.isSafeInteger(usage?.completion_tokens) && usage!.completion_tokens! >= 0
      ? options.usage.outputTokens + usage!.completion_tokens! : null;
    const message = body.choices?.[0]?.message;
    if (!message || (message.content !== undefined && message.content !== null && typeof message.content !== "string")) throw new Error("Coding model returned an invalid message");
    const calls = message.tool_calls ?? [];
    if (!Array.isArray(calls) || calls.length > 8) throw new Error("Coding model tool-call limit exceeded");
    if (calls.length === 0) {
      const reason = typeof message.content === "string" ? message.content.slice(0, 2000) : "";
      if (++misses >= MAX_MODEL_MISSES) throw new Error(`Coding agent stopped without completed package evidence${reason ? `: ${reason}` : ""}`);
      options.log(`Model call ${callNumber} answered without a tool call; asking again`);
      continue;
    }
    misses = 0;
    messages.push({ role: "assistant", content: message.content ?? null, tool_calls: calls });
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
          await options.validateFinish(arguments_ as Record<string, unknown>);
          return { runId, result: arguments_ as Record<string, unknown> };
        }
        const tool = options.tools.find((item) => item.name === call.function.name);
        if (!tool) throw new Error("Unknown build tool");
        options.log(`Tool: ${tool.name}`);
        result = await tool.execute(arguments_ as Record<string, unknown>);
      } catch (error) {
        options.signal.throwIfAborted();
        if (error instanceof FatalFinishError) throw error;
        result = { error: error instanceof Error ? error.message.slice(0, 4000) : "Build tool failed" };
      }
      let content = JSON.stringify(result);
      if (content.length > 16_000) content = JSON.stringify({ truncated: true, text: content.slice(0, 15_000) });
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
}
