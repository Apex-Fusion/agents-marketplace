import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FatalFinishError, repairableFinishCheck, runCodingAgent, type AgentSessionOptions, type AgentTool, type FundsShortfall } from "../src/agent.js";

interface Reply { status: number; body: unknown }

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.close();
    server.closeAllConnections();
    await once(server, "close");
  }
});

/** A model endpoint that answers each request with the next scripted reply and records the bodies and their sizes. */
async function modelEndpoint(replies: Reply[]): Promise<{ baseUrl: string; requests: unknown[]; bodyBytes: number[] }> {
  const requests: unknown[] = [];
  const bodyBytes: number[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    bodyBytes.push(body.byteLength);
    requests.push(JSON.parse(body.toString("utf8")));
    const reply = replies.length > 1 ? replies.shift()! : replies[0];
    res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body));
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, bodyBytes };
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

interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

function chatMessages(request: unknown): ChatMessage[] {
  if (!request || typeof request !== "object" || !("messages" in request) || !Array.isArray(request.messages)) throw new Error("Expected a chat request");
  return request.messages as ChatMessage[];
}

function lastMessage(request: unknown): unknown {
  return chatMessages(request).at(-1);
}

/** A model reply that calls the given tools, as `[id, name, arguments]`. */
function toolCalls(...calls: Array<readonly [string, string, string]>): Reply {
  return { status: 200, body: { choices: [{ message: { content: null,
    tool_calls: calls.map(([id, name, arguments_]) => ({ id, type: "function", function: { name, arguments: arguments_ } })) } }] } };
}

/** Writes nothing; answers with about 15 KB of output, close to the 16,000-character result cap. */
const WRITE_FILE: AgentTool = {
  name: "write_file",
  description: "Write a file.",
  parameters: { type: "object" },
  execute: async (arguments_) => ({ path: arguments_.path, log: `${String(arguments_.path)}: ${"x".repeat(15_000)}` }),
};

const CHAIN_DOWN: Reply = { status: 503, body: {
  error: { message: "Marketplace chain access is unavailable; no payment was made. Retry the call.", type: "server_error", code: "chain_unavailable", param: null },
} };
const WAITING_FOR_CHAIN = "Model call 1 waiting: marketplace chain access is unavailable; no payment was made; retrying every 0.005 s";
const CHAIN_RESUMED = "Model call 1 resumed: marketplace chain access is available again";

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
    ["a failed paid call", { status: 502, body: { error: { code: "paid_call_failed", message: "Upstream error." } } }, /HTTP 502 \(paid_call_failed\)/],
    ["chain_unavailable with another status", { status: 502, body: { error: { code: "chain_unavailable", message: "No chain." } } }, /HTTP 502 \(chain_unavailable\)/],
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

  it("waits without counting misses while the marketplace cannot reach the chain, then resumes", async () => {
    const failed: Reply = { status: 502, body: { error: { code: "paid_call_failed", message: "Upstream error." } } };
    const endpoint = await modelEndpoint([
      failed, failed,
      CHAIN_DOWN, { status: 503, body: { error: "chain_unavailable", message: "Chain access is unavailable." } }, CHAIN_DOWN, CHAIN_DOWN,
      FINISH,
    ]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    const { runId } = await runCodingAgent(run.options);
    // Two misses came first, so a third counted miss would have ended the run.
    expect(endpoint.requests).toHaveLength(7);
    for (const request of endpoint.requests) expect(request).toEqual(endpoint.requests[0]);
    expect(run.shortfalls).toEqual([]);
    expect(run.restored()).toBe(0);
    expect(run.options.usage).toEqual({ calls: 1, inputTokens: 10, outputTokens: 2 });
    const failure = "Model call 1 failed: Coding model returned HTTP 502 (paid_call_failed); retrying";
    expect(run.logs).toEqual([
      `Model call 1 (${runId})`, failure, `Model call 1 (${runId})`, failure, `Model call 1 (${runId})`, WAITING_FOR_CHAIN, CHAIN_RESUMED,
    ]);
  });

  it("keeps one chain wait and the funds pause when chain and funds refusals alternate", async () => {
    const noFunds: Reply = { status: 402, body: { error: "insufficient_funds", message: "No funds." } };
    const endpoint = await modelEndpoint([CHAIN_DOWN, noFunds, CHAIN_DOWN, noFunds, CHAIN_DOWN, FINISH]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    const { runId } = await runCodingAgent(run.options);
    expect(endpoint.requests).toHaveLength(6);
    expect(run.shortfalls.map((shortfall) => shortfall.message)).toEqual(["No funds.", "No funds."]);
    expect(run.restored()).toBe(1);
    expect(run.logs).toEqual([`Model call 1 (${runId})`, WAITING_FOR_CHAIN, CHAIN_RESUMED]);
  });

  it("stops waiting for chain access as soon as the build is cancelled", async () => {
    const endpoint = await modelEndpoint([CHAIN_DOWN]);
    const controller = new AbortController();
    const run = session(endpoint.baseUrl, controller.signal, 60_000);
    run.options.log = (message) => { if (message.includes("waiting")) controller.abort(new Error("Build cancelled")); };
    const started = Date.now();
    await expect(runCodingAgent(run.options)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(endpoint.requests).toHaveLength(1);
  });

  it("shortens older tool results and arguments so a long run stays below the context limit", async () => {
    const turns = 40;
    const argumentsOf = (turn: number) => JSON.stringify({ path: `src/step${turn}.py`, content: `# step ${turn}\n${"y".repeat(5_000)}` });
    const outputOf = (turn: number) => JSON.stringify({ path: `src/step${turn}.py`, log: `src/step${turn}.py: ${"x".repeat(15_000)}` });
    const endpoint = await modelEndpoint([
      ...Array.from({ length: turns }, (_, index) => toolCalls([`call-${index + 1}`, "write_file", argumentsOf(index + 1)])),
      FINISH,
    ]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    run.options.task = `Paper text. ${"p".repeat(20_000)}`;
    run.options.tools = [WRITE_FILE];
    await expect(runCodingAgent(run.options)).resolves.toMatchObject({ result: { done: true } });

    // Unshortened, the history would pass 800 KB.
    expect(endpoint.requests).toHaveLength(turns + 1);
    expect(Math.max(...endpoint.bodyBytes)).toBeLessThan(220_000);
    const compactions = run.logs.filter((message) => message.startsWith("Context compacted"));
    expect(compactions.length).toBeGreaterThan(0);
    for (const message of compactions) {
      const sizes = /^Context compacted: [1-9]\d* older messages shortened \((\d+) -> (\d+) bytes\)$/.exec(message);
      expect(sizes).not.toBeNull();
      expect(Number(sizes![2])).toBeLessThan(Number(sizes![1]));
    }
    // Every call carries the newest tool result in full.
    endpoint.requests.slice(1).forEach((request, index) => {
      expect(lastMessage(request)).toEqual({ role: "tool", tool_call_id: `call-${index + 1}`, content: outputOf(index + 1) });
    });

    const messages = chatMessages(endpoint.requests.at(-1));
    expect(messages).toHaveLength(2 + 2 * turns);
    expect(messages.slice(0, 2)).toEqual([{ role: "system", content: run.options.system }, { role: "user", content: run.options.task }]);
    expect(messages.slice(-2)).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: `call-${turns}`, type: "function", function: { name: "write_file", arguments: argumentsOf(turns) } }] },
      { role: "tool", tool_call_id: `call-${turns}`, content: outputOf(turns) },
    ]);
    for (let turn = 1; turn <= turns; turn += 1) {
      const [call, result] = [messages[2 * turn], messages[2 * turn + 1]];
      expect(call).toMatchObject({ role: "assistant", tool_calls: [{ id: `call-${turn}`, type: "function", function: { name: "write_file" } }] });
      expect(result).toMatchObject({ role: "tool", tool_call_id: `call-${turn}` });
    }
    // The oldest turn keeps short, valid JSON in place of its long arguments and output.
    expect(JSON.parse(messages[2].tool_calls![0].function.arguments)).toEqual({
      path: "src/step1.py", omitted_chars: argumentsOf(1).length, note: expect.any(String),
    });
    const output = messages[3].content!;
    expect(output.length).toBeLessThan(1_000);
    const shortened = JSON.parse(output) as { truncated: unknown; note: unknown; text: string };
    expect(shortened).toMatchObject({ truncated: true, note: expect.stringContaining("run the tool again") });
    expect(shortened.text.length).toBeGreaterThan(0);
    expect(outputOf(1).startsWith(shortened.text)).toBe(true);
  });

  it("still ends the run when the latest turn alone exceeds the context limit", async () => {
    const large = (id: string) => [id, "write_file", JSON.stringify({ path: `${id}.py`, content: "y".repeat(90_000) })] as const;
    const endpoint = await modelEndpoint([
      toolCalls(["call-1", "write_file", JSON.stringify({ path: "src/step1.py", content: "y".repeat(5_000) })]),
      toolCalls(large("call-2"), large("call-3"), large("call-4")),
      FINISH,
    ]);
    const run = session(endpoint.baseUrl, new AbortController().signal, 5);
    run.options.tools = [WRITE_FILE];
    await expect(runCodingAgent(run.options)).rejects.toThrow(/^Coding-agent context exceeds limit$/);
    expect(endpoint.requests).toHaveLength(2);
    // The older turn is shortened first; the latest turn stays whole, so the limit still applies.
    expect(run.logs.filter((message) => message.startsWith("Context compacted"))).toEqual([
      expect.stringMatching(/^Context compacted: 2 older messages shortened \(\d+ -> \d+ bytes\)$/),
    ]);
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
