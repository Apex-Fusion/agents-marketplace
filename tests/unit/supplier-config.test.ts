/**
 * supplier-config.test.ts — tests for supplier/src/config.ts
 *
 * Tests loadConfig(env) and parseAdvertRef(ref):
 *   - NETWORK_ID selects the chain
 *   - Errors: a missing required var and a malformed value throw an error
 *     that names the setting
 *   - Strict opt-ins: only the literal "1" sets LIVE_CHAIN and
 *     OPENAI_SESSION_PASSTHROUGH
 *   - Rules across settings: upstream protocol, chat-session slots and
 *     settle mode, reseller mode
 *   - parseAdvertRef: the "<txHash>#<index>" format
 *
 * The tests do not repeat default values or read back a value that they put in.
 */

import { describe, it, expect } from "vitest";
import { loadConfig, parseAdvertRef } from "../../supplier/src/config.js";
import { buildSampleEnv } from "../fixtures/supplier-side/sample-config.js";

// ─── loadConfig — NETWORK_ID ─────────────────────────────────────────────────

describe("loadConfig() — NETWORK_ID", () => {
  it.each([
    ["0", 0, "testnet"],
    ["1", 1, "mainnet"],
  ])("NETWORK_ID %s → networkId %i (%s)", (value, networkId) => {
    const cfg = loadConfig({ ...buildSampleEnv(), NETWORK_ID: value });
    expect(cfg.networkId).toBe(networkId);
  });
});

// ─── loadConfig — missing required vars ─────────────────────────────────────

describe("loadConfig() — missing required vars", () => {
  it.each([
    "SUPPLIER_PRIV_KEY_HEX",
    "OGMIOS_URL",
    "OLLAMA_URL",
    "ADVERT_REF",
    "NETWORK_ID",
  ])("throws an error that names %s when it is missing", (name) => {
    const env: Record<string, string | undefined> = { ...buildSampleEnv() };
    delete env[name];
    expect(() => loadConfig(env)).toThrow(new RegExp(name));
  });
});

// ─── loadConfig — malformed values ──────────────────────────────────────────

describe("loadConfig() — malformed values", () => {
  // Each row breaks one setting of a valid env. The error must name that setting.
  it.each([
    ["SUPPLIER_PRIV_KEY_HEX is 63 chars (odd length)", "SUPPLIER_PRIV_KEY_HEX", "a".repeat(63)],
    ["SUPPLIER_PRIV_KEY_HEX is 64 chars but contains non-hex", "SUPPLIER_PRIV_KEY_HEX", "z".repeat(64)],
    ["NETWORK_ID is not '0' or '1'", "NETWORK_ID", "2"],
    ["PORT is not a positive integer string", "PORT", "not-a-port"],
    ["OLLAMA_TIMEOUT_MS is not a positive integer string", "OLLAMA_TIMEOUT_MS", "0"],
  ])("throws when %s", (_row, name, value) => {
    expect(() => loadConfig({ ...buildSampleEnv(), [name]: value })).toThrow(new RegExp(name));
  });

  it("binds only an IP literal from SUPPLIER_BIND_HOST, so a proxied child stays on loopback", () => {
    expect(loadConfig({ ...buildSampleEnv(), SUPPLIER_BIND_HOST: "127.0.0.1" }).bindHost).toBe("127.0.0.1");
    expect(loadConfig(buildSampleEnv()).bindHost).toBeUndefined();
    expect(() => loadConfig({ ...buildSampleEnv(), SUPPLIER_BIND_HOST: "localhost" })).toThrow(/SUPPLIER_BIND_HOST/);
  });
});

// ─── loadConfig — LIVE_CHAIN (M1-F-2) ───────────────────────────────────────
// SPEC FIX 2026-04-27: M1-F-2 LIVE_CHAIN env support

describe("loadConfig() — LIVE_CHAIN parsing", () => {
  it("LIVE_CHAIN='1' sets liveChain: true", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "1" });
    expect(cfg.liveChain).toBe(true);
  });

  it("LIVE_CHAIN omitted defaults to liveChain: false", () => {
    const env = { ...buildSampleEnv() };
    delete (env as Record<string, string | undefined>).LIVE_CHAIN;
    const cfg = loadConfig(env);
    expect(cfg.liveChain).toBe(false);
  });

  it("LIVE_CHAIN='true' does NOT set liveChain (only literal '1' opts in)", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), LIVE_CHAIN: "true" });
    expect(cfg.liveChain).toBe(false);
  });
});

describe("loadConfig() — upstream Responses protocol", () => {
  const openAiEnv = (over: Record<string, string> = {}) => ({
    ...buildSampleEnv(),
    LLM_BACKEND: "openai",
    OPENAI_BASE_URL: "https://router.huggingface.co",
    ...over,
  });

  it("accepts an explicit full Responses endpoint", () => {
    const cfg = loadConfig(openAiEnv({
      OPENAI_UPSTREAM_API: "responses",
      OPENAI_RESPONSES_URL: "https://api.deepseek.com/responses",
    }));
    expect(cfg.openaiUpstreamApi).toBe("responses");
    expect(cfg.openaiResponsesUrl).toBe("https://api.deepseek.com/responses");
  });

  it("allows streaming-only native Responses and rejects a mixed protocol setting", () => {
    expect(loadConfig(openAiEnv({
      OPENAI_RESPONSES_STREAM_ONLY: "1",
    })).openaiResponsesStreamOnly).toBe(true);
    expect(() => loadConfig(openAiEnv({
      OPENAI_UPSTREAM_API: "chat-completions",
      OPENAI_RESPONSES_STREAM_ONLY: "1",
    }))).toThrow(/requires OPENAI_UPSTREAM_API=responses/);
  });

  it("allows Chat Completions stream-only collection and rejects it for the native protocol", () => {
    expect(loadConfig(openAiEnv({
      OPENAI_UPSTREAM_API: "chat-completions",
      OPENAI_CHAT_STREAM_ONLY: "1",
    })).openaiChatStreamOnly).toBe(true);
    expect(loadConfig(openAiEnv({ OPENAI_UPSTREAM_API: "chat-completions" })).openaiChatStreamOnly).toBe(false);
    expect(loadConfig(openAiEnv({
      OPENAI_UPSTREAM_API: "chat-completions",
      OPENAI_CHAT_STREAM_ONLY: "true",
    })).openaiChatStreamOnly).toBe(false);
    expect(() => loadConfig(openAiEnv({ OPENAI_CHAT_STREAM_ONLY: "1" })))
      .toThrow(/OPENAI_CHAT_STREAM_ONLY requires OPENAI_UPSTREAM_API=chat-completions/);
  });

  it("reads the context window of the upstream model", () => {
    expect(loadConfig(openAiEnv()).openaiContextTokens).toBe(0);
    expect(loadConfig(openAiEnv({ OPENAI_CONTEXT_TOKENS: "262144" })).openaiContextTokens).toBe(262144);
    expect(() => loadConfig(openAiEnv({ OPENAI_CONTEXT_TOKENS: "0" }))).toThrow(/OPENAI_CONTEXT_TOKENS/);
    expect(() => loadConfig(openAiEnv({ OPENAI_CONTEXT_TOKENS: "262k" }))).toThrow(/OPENAI_CONTEXT_TOKENS/);
  });

  it("rejects unknown protocol values", () => {
    expect(() => loadConfig(openAiEnv({ OPENAI_UPSTREAM_API: "auto" }))).toThrow(
      /OPENAI_UPSTREAM_API/,
    );
  });

  it("uses standard effort control for native Hugging Face Responses calls", () => {
    expect(loadConfig(openAiEnv({ OPENAI_REASONING: "off" })).openaiReasoningDisabled).toBe(true);
  });

  it("rejects the OpenRouter reasoning extension for explicit Hugging Face Chat mode", () => {
    expect(() => loadConfig(openAiEnv({
      OPENAI_UPSTREAM_API: "chat-completions",
      OPENAI_REASONING: "off",
    }))).toThrow(/HuggingFace.*Chat Completions/i);
  });
});

// ─── parseAdvertRef ──────────────────────────────────────────────────────────

describe("parseAdvertRef()", () => {
  it("parses a well-formed ref into { txHash, index }", () => {
    const ref = parseAdvertRef(`${"b".repeat(64)}#0`);
    expect(ref.txHash).toBe("b".repeat(64));
    expect(ref.index).toBe(0);
  });

  it("parses index > 0", () => {
    const ref = parseAdvertRef(`${"a".repeat(64)}#7`);
    expect(ref.index).toBe(7);
  });

  it("throws on empty string", () => {
    expect(() => parseAdvertRef("")).toThrow();
  });

  it("throws when # separator is missing", () => {
    expect(() => parseAdvertRef("a".repeat(64))).toThrow();
  });

  it("throws when txHash part is shorter than 64 chars", () => {
    expect(() => parseAdvertRef("abc#0")).toThrow();
  });

  it("throws when index part is not a number", () => {
    expect(() => parseAdvertRef(`${"a".repeat(64)}#notanumber`)).toThrow();
  });

  it("throws when index part is negative", () => {
    expect(() => parseAdvertRef(`${"a".repeat(64)}#-1`)).toThrow();
  });
});

// ─── loadConfig — chat-session concurrency + settle mode ─────────────────────

describe("loadConfig() — MAX_CHAT_SESSIONS / CHAT_SETTLE_MODE", () => {
  const chatSessionEnv = () => ({
    ...buildSampleEnv(),
    CAPABILITY_KIND: "chat-session",
    LLM_BACKEND: "openai",
    OPENAI_BASE_URL: "http://up",
  });

  it("parses MAX_CHAT_SESSIONS and CHAT_SETTLE_MODE for chat-session kind", () => {
    const cfg = loadConfig({ ...chatSessionEnv(), MAX_CHAT_SESSIONS: "8", CHAT_SETTLE_MODE: "ticket" });
    expect(cfg.maxChatSessions).toBe(8);
    expect(cfg.chatSettleMode).toBe("ticket");
  });

  it("rejects MAX_CHAT_SESSIONS > 1 for non-chat-session kinds", () => {
    expect(() => loadConfig({ ...buildSampleEnv(), MAX_CHAT_SESSIONS: "4" })).toThrow(/MAX_CHAT_SESSIONS/);
  });

  it("rejects CHAT_SETTLE_MODE=ticket for non-chat-session kinds", () => {
    expect(() => loadConfig({ ...buildSampleEnv(), CHAT_SETTLE_MODE: "ticket" })).toThrow(/CHAT_SETTLE_MODE/);
  });

  it("rejects invalid values", () => {
    expect(() => loadConfig({ ...chatSessionEnv(), MAX_CHAT_SESSIONS: "0" })).toThrow(/MAX_CHAT_SESSIONS/);
    expect(() => loadConfig({ ...chatSessionEnv(), CHAT_SETTLE_MODE: "nope" })).toThrow(/CHAT_SETTLE_MODE/);
  });
});

// ─── loadConfig — OPENAI_SESSION_PASSTHROUGH ─────────────────────────────────

describe("loadConfig() — OPENAI_SESSION_PASSTHROUGH", () => {
  const chatSessionEnv = () => ({
    ...buildSampleEnv(),
    CAPABILITY_KIND: "chat-session",
    LLM_BACKEND: "openai",
    OPENAI_BASE_URL: "http://up",
  });

  it("defaults off", () => {
    expect(loadConfig(chatSessionEnv()).openaiSessionPassthrough).toBe(false);
  });

  it('parses "1" for chat-session kind', () => {
    const cfg = loadConfig({ ...chatSessionEnv(), OPENAI_SESSION_PASSTHROUGH: "1" });
    expect(cfg.openaiSessionPassthrough).toBe(true);
  });

  it('treats values other than "1" as off (mirrors LIVE_CHAIN strictness)', () => {
    const cfg = loadConfig({ ...chatSessionEnv(), OPENAI_SESSION_PASSTHROUGH: "true" });
    expect(cfg.openaiSessionPassthrough).toBe(false);
  });

  it("rejects it for non-chat-session kinds", () => {
    expect(() => loadConfig({ ...buildSampleEnv(), OPENAI_SESSION_PASSTHROUGH: "1" })).toThrow(
      /chat-session/,
    );
  });
});

describe("loadConfig() — OpenRouter reseller", () => {
  const resellerEnv = () => ({
    ...buildSampleEnv(),
    CAPABILITY_KIND: "chat",
    LLM_BACKEND: "openai",
    OPENAI_BASE_URL: "https://openrouter.ai/api",
    OPENAI_API_KEY: "seller-only-key",
    OPENAI_MAX_TOKENS: "256",
    RESELLER_PROVIDER: "openrouter",
    RESELLER_DATABASE_URL: "postgresql://reseller:secret@postgres:5432/reseller",
    RESELLER_RESERVE_USD: "1.25",
    RESELLER_MAX_INPUT_TOKENS: "4096",
  });

  it("stays disabled for every legacy config", () => {
    expect(loadConfig(buildSampleEnv()).reseller).toBeNull();
  });

  it("parses a complete balance-aware config", () => {
    const cfg = loadConfig(resellerEnv());
    expect(cfg.reseller).toMatchObject({
      provider: "openrouter",
      reserveUsd: "1.25",
      maxInputTokens: 4096,
      pollIntervalMs: 30_000,
      providerTimeoutMs: 10_000,
    });
  });

  it("rejects partial and unsafe configurations", () => {
    expect(() => loadConfig({
      ...buildSampleEnv(),
      RESELLER_RESERVE_USD: "1",
    })).toThrow(/RESELLER_PROVIDER/);
    expect(() => loadConfig({
      ...resellerEnv(),
      OPENAI_BASE_URL: "https://example.com",
    })).toThrow(/OPENAI_BASE_URL/);
    for (const OPENAI_BASE_URL of [
      "http://openrouter.ai/api",
      "https://openrouter.ai/v1",
      "https://user:secret@openrouter.ai/api",
    ]) {
      expect(() => loadConfig({
        ...resellerEnv(),
        OPENAI_BASE_URL,
      })).toThrow(/OPENAI_BASE_URL/);
    }
    expect(() => loadConfig({
      ...resellerEnv(),
      OPENAI_MAX_TOKENS: "",
    })).toThrow(/OPENAI_MAX_TOKENS/);
    expect(() => loadConfig({
      ...resellerEnv(),
      RESELLER_RESERVE_USD: "-1",
    })).toThrow(/RESELLER_RESERVE_USD/);
  });
});
