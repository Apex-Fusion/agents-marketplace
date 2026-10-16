import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FatalFinishError, repairableFinishCheck, runCodingAgent, type AgentSessionOptions, type FundsShortfall } from "../src/agent.js";

interface Reply { status: number; body: unknown }

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});

/** A model endpoint that answers each request with the next scripted reply and records the bodies. */
async function modelEndpoint(replies: Reply[]): Promise<{ baseUrl: string; requests: unknown[] }> {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests };
}

const FINISH: Reply = {
  status: 200,
  body: {
    choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "finish", arguments: "{\"done\":true}" } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  },
};
const ADDRESS = `addr1${"q".repeat(53)}`;

function session(baseUrl: string, signal: AbortSignal, retryMs: number) {
  const shortfalls: FundsShortfall[] = [];
  const logs: string[] = [];
  let restored = 0;
  const options: AgentSessionOptions = {
    model: { baseUrl, model: "gpt-test" },
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
    signal,
    system: "Build the tool.",
    task: "Paper text.",
    tools: [],
    finishSchema: { type: "object" },
    validateFinish: () => undefined,
    log: (message) => logs.push(message),
    fundsRetryMs: retryMs,
    failureRetryMs: retryMs,
    onFundsShortfall: (shortfall) => shortfalls.push(shortfall),
    onFundsRestored: () => { restored += 1; },
  };
  return { options, shortfalls, logs, restored: () => restored };
}

function lastMessage(request: unknown): unknown {
  if (!request || typeof request !== "object" || !("messages" in request) || !Array.isArray(request.messages)) throw new Error("Expected a chat request");
  return request.messages.at(-1);
}

describe("Paper2Agent coding agent", () => {
  it("resends a call the wallet cannot pay for and continues once it is paid", async () => {
    const endpoint = await modelEndpoint([
      { status: 402, body: {
        error: { message: "insufficient balance for this request", type: "invalid_request_error", code: "insufficient_funds", param: null },
        x_vector: { required_lovelace: "9200000", available_lovelace: "1000000", collateral_ok: true, deposit_address: ADDRESS },
      } },
      { status: 402, body: { error: "insufficient_funds", message: "The buyer wallet cannot pay.", available_lovelace: "4000000" } },
      FINISH,
    ]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    await expect(runCodingAgent(run.options)).resolves.toMatchObject({ result: { done: true } });
    expect(run.shortfalls).toEqual([
      { message: "insufficient balance for this request", requiredLovelace: "9200000", availableLovelace: "1000000", depositAddress: ADDRESS },
      { message: "The buyer wallet cannot pay.", requiredLovelace: null, availableLovelace: "4000000", depositAddress: null },
    ]);
    expect(run.restored()).toBe(1);
    expect(run.options.usage).toEqual({ calls: 1, inputTokens: 10, outputTokens: 2 });
    expect(run.logs).toHaveLength(1);
    // The refused call is sent again unchanged, without a per-call output token cap.
    expect(endpoint.requests).toHaveLength(3);
    expect(endpoint.requests[1]).toEqual(endpoint.requests[0]);
    expect(endpoint.requests[2]).toEqual(endpoint.requests[0]);
    expect(endpoint.requests[0]).not.toHaveProperty("max_completion_tokens");
  });

  it.each([
    ["another 402 error code", { status: 402, body: { error: { code: "billing_hard_limit_reached", message: "Limit." } } }, /HTTP 402 \(billing_hard_limit_reached\)/],
    ["an unparsable 402 body", { status: 402, body: "Payment Required" }, /HTTP 402$/],
    ["a supplier failure", { status: 503, body: { error: { code: "model_unavailable", message: "No supplier." } } }, /HTTP 503 \(model_unavailable\)/],
    ["a reply without a tool call", { status: 200, body: { choices: [{ message: { content: "Done." } }] } }, /without completed package evidence: Done\./],
  ] as const)("fails the build after three in a row of %s instead of pausing", async (_label, reply, error) => {
    const endpoint = await modelEndpoint([reply]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    await expect(runCodingAgent(run.options)).rejects.toThrow(error);
    expect(run.shortfalls).toEqual([]);
    expect(endpoint.requests).toHaveLength(3);
  });

  it("resends the same conversation after a failed call or a reply without a tool call", async () => {
    const endpoint = await modelEndpoint([
      { status: 502, body: { error: { code: "supplier_failed", message: "Upstream error." } } },
      { status: 200, body: { choices: [{ message: { content: "Let me think." } }] } },
      FINISH,
    ]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    await expect(runCodingAgent(run.options)).resolves.toMatchObject({ result: { done: true } });
    expect(endpoint.requests).toHaveLength(3);
    expect(endpoint.requests[1]).toEqual(endpoint.requests[0]);
    expect(endpoint.requests[2]).toEqual(endpoint.requests[0]);
  });

  it("stops waiting for funds as soon as the build is cancelled", async () => {
    const endpoint = await modelEndpoint([{ status: 402, body: { error: "insufficient_funds", message: "No funds." } }]);
    const controller = new AbortController();
    const run = session(endpoint.baseUrl, controller.signal, 60_000);
    run.options.onFundsShortfall = () => controller.abort(new Error("Build cancelled"));
    const started = Date.now();
    await expect(runCodingAgent(run.options)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(endpoint.requests).toHaveLength(1);
  });

  it("returns a finish error to the model and ends the run on a fatal finish error", async () => {
    const endpoint = await modelEndpoint([FINISH]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    let finishes = 0;
    run.options.validateFinish = async () => {
      finishes += 1;
      if (finishes === 1) throw new Error("cases.json is missing");
      throw new FatalFinishError("Verification cannot continue");
    };
    await expect(runCodingAgent(run.options)).rejects.toThrow(new FatalFinishError("Verification cannot continue"));
    expect(endpoint.requests).toHaveLength(2);
    expect(lastMessage(endpoint.requests[1])).toEqual({
      role: "tool", tool_call_id: "call-1", content: JSON.stringify({ error: "cases.json is missing" }),
    });
  });

  it("repairs a failed final check on the next finish", async () => {
    const endpoint = await modelEndpoint([FINISH]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    let checks = 0;
    run.options.validateFinish = repairableFinishCheck(2, run.options.signal, run.options.log, async () => {
      checks += 1;
      if (checks === 1) throw new Error("Paper2Agent: input does not match its JSON schema");
    });
    await expect(runCodingAgent(run.options)).resolves.toMatchObject({ result: { done: true } });
    expect(endpoint.requests).toHaveLength(2);
    const failure = "Final check failed (repair 1 of 2): Paper2Agent: input does not match its JSON schema";
    expect(lastMessage(endpoint.requests[1])).toMatchObject({ role: "tool", content: JSON.stringify({ error: failure }) });
    expect(run.logs).toContain(failure);
  });

  it("ends the attempt with the check error on the third failed final check", async () => {
    const endpoint = await modelEndpoint([FINISH]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    run.options.validateFinish = repairableFinishCheck(2, run.options.signal, run.options.log, async () => {
      throw new Error("Independent verification failed: AssertionError");
    });
    const failed = runCodingAgent(run.options);
    await expect(failed).rejects.toBeInstanceOf(FatalFinishError);
    await expect(failed).rejects.toThrow(/^Independent verification failed: AssertionError$/);
    expect(endpoint.requests).toHaveLength(3);
    expect(run.logs.filter((message) => message.startsWith("Final check failed"))).toEqual([
      "Final check failed (repair 1 of 2): Independent verification failed: AssertionError",
      "Final check failed (repair 2 of 2): Independent verification failed: AssertionError",
      "Final check failed (no repairs left): Independent verification failed: AssertionError",
    ]);
  });
});
