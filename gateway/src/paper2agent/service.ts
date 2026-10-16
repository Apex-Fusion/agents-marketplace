import { Paper2AgentClient, type Paper2AgentCallResult, type Paper2AgentOffer } from "@marketplace/buyer/sdk/paper2agent";
import { SupplierError } from "@marketplace/buyer/sdk";
import type { JsonObject } from "@marketplace/shared/paper2agent";
import type { GatewayDeps } from "../deps.js";
import { createLimiter, type Limiter } from "../middleware/rateLimit.js";

/** Bounds queue memory; the queue wait time is `mcpCallQueueTimeoutMs`. */
const MAX_QUEUED_CALLS = 64;

/** A failed tools/call. MCP returns `code` and the message as a tool error result. */
export class ToolCallError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ToolCallError";
  }
}

/** Supplier route reasons and SDK transport reasons to MCP tool errors. */
function mapCallFailure(error: unknown): ToolCallError {
  const reason = error instanceof SupplierError ? error.reason : undefined;
  switch (reason) {
    case "invalid_tool_request":
      return new ToolCallError("paper2agent_invalid_input", "The tool supplier rejected the tool arguments.");
    case "request_too_large":
      return new ToolCallError("paper2agent_input_too_large", "The tool arguments are too large.");
    case "unauthorized":
      return new ToolCallError("paper2agent_calls_unavailable", "The tool supplier refused the gateway. Free tool calls are not configured correctly.");
    case "not_found":
      return new ToolCallError("paper2agent_tool_unavailable", "The tool does not accept free calls now.");
    case "supplier_busy":
      return new ToolCallError("paper2agent_tool_busy", "The tool is busy with another call. Try again in a few minutes.");
    case "tool_execution_failed":
      return new ToolCallError("paper2agent_tool_failed", "The tool failed while it ran.");
    case "supplier_draining":
    case "supplier_unavailable":
      return new ToolCallError("paper2agent_tool_unavailable", "The tool is temporarily unavailable. Try again later.");
    case "invalid_tool_output":
      return new ToolCallError("paper2agent_invalid_output", "The tool returned output that does not match its output schema.");
    case "timeout":
      return new ToolCallError("paper2agent_timeout", "The tool did not finish in time.");
    case "unreachable":
      return new ToolCallError("paper2agent_supplier_unavailable", "The tool supplier did not respond. Try again later.");
    default:
      return new ToolCallError("paper2agent_supplier_error", "The tool supplier sent an invalid response.");
  }
}

interface Waiter {
  endpoint: string;
  grant: () => void;
}

/**
 * At most one call per supplier endpoint and `limit` calls in total. Other calls
 * wait in FIFO order. A waiter whose endpoint is free can pass a blocked waiter.
 */
export class ToolCallGate {
  private readonly busy = new Set<string>();
  private readonly waiters: Waiter[] = [];

  constructor(private readonly limit: number, private readonly maxWaiters = MAX_QUEUED_CALLS) {}

  /** Returns a release function, or undefined after a timeout, an abort, or a full queue. */
  acquire(endpoint: string, timeoutMs: number, signal?: AbortSignal): Promise<(() => void) | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    if (this.fits(endpoint)) return Promise.resolve(this.take(endpoint));
    if (this.waiters.length >= this.maxWaiters) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", leave);
      };
      const leave = () => {
        cleanup();
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      };
      const waiter: Waiter = {
        endpoint,
        grant: () => {
          cleanup();
          resolve(this.take(endpoint));
        },
      };
      const timer = setTimeout(leave, timeoutMs);
      signal?.addEventListener("abort", leave, { once: true });
      this.waiters.push(waiter);
    });
  }

  private fits(endpoint: string): boolean {
    return this.busy.size < this.limit && !this.busy.has(endpoint);
  }

  private take(endpoint: string): () => void {
    this.busy.add(endpoint);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(endpoint);
      for (let index = 0; index < this.waiters.length && this.busy.size < this.limit;) {
        const waiter = this.waiters[index]!;
        if (this.busy.has(waiter.endpoint)) {
          index++;
          continue;
        }
        this.waiters.splice(index, 1);
        waiter.grant();
      }
    };
  }
}

/**
 * Free Paper2Agent calls through the publisher's token-gated route. No API key,
 * wallet, escrow, receipt or database row. Limits are per client IP and per gateway.
 */
export class FreeToolCalls {
  private readonly gate: ToolCallGate;
  private readonly callRate: Limiter;
  private readonly inFlight = new Map<string, number>();
  private client?: Paper2AgentClient;

  constructor(private readonly deps: GatewayDeps) {
    this.gate = new ToolCallGate(deps.config.mcpCallConcurrency);
    this.callRate = createLimiter(deps.config.mcpCallIpRate);
  }

  /** Runs before the tool lookup, so unknown names also count. Returns the route token. */
  admit(ip: string): string {
    const token = this.deps.config.paper2agentToolCallToken;
    if (!token) throw new ToolCallError("paper2agent_calls_unavailable", "Free tool calls are not configured on this gateway.");
    const decision = this.callRate.attempt(ip);
    if (!decision.allowed) {
      const seconds = Math.ceil(decision.retryAfterMs / 1000);
      throw new ToolCallError("rate_limit_exceeded", `Too many tool calls from this address. Retry in ${seconds}s.`);
    }
    return token;
  }

  /** `signal` cancels only the queue wait. A started call runs to its end, so the slot stays accurate. */
  async call(ip: string, token: string, offer: Paper2AgentOffer, input: JsonObject, signal: AbortSignal): Promise<Paper2AgentCallResult> {
    const active = this.inFlight.get(ip) ?? 0;
    if (active >= this.deps.config.mcpCallIpConcurrency) {
      throw new ToolCallError("paper2agent_client_busy", "Another tool call from this address is still running. Wait for it to finish.");
    }
    this.inFlight.set(ip, active + 1);
    try {
      const release = await this.gate.acquire(offer.endpointUrl, this.deps.config.mcpCallQueueTimeoutMs, signal);
      if (!release) {
        if (signal.aborted) throw new ToolCallError("paper2agent_call_cancelled", "The client cancelled the call.");
        throw new ToolCallError("paper2agent_tool_busy", "The tool is busy with other calls. Try again in a few minutes.");
      }
      try {
        this.client ??= new Paper2AgentClient({ chain: this.deps.chain, indexerUrl: this.deps.config.indexerUrl, fetchFn: this.deps.fetchFn });
        return await this.client.call(offer, input, { token });
      } catch (error) {
        throw mapCallFailure(error);
      } finally {
        release();
      }
    } finally {
      const remaining = (this.inFlight.get(ip) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(ip, remaining);
      else this.inFlight.delete(ip);
    }
  }
}
