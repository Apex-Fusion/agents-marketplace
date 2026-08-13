/**
 * supplier-config.test.ts — RED phase tests for supplier/src/config.ts
 *
 * Tests loadConfig(env) and parseAdvertRef(ref):
 *   - Happy paths: all required vars present
 *   - Defaults: PORT and OLLAMA_TIMEOUT_MS
 *   - Errors: missing required vars, malformed values
 */

import { describe, it, expect } from "vitest";
import { loadConfig, parseAdvertRef } from "../../supplier/src/config.js";
import { buildSampleEnv } from "../fixtures/supplier-side/sample-config.js";
import { SAMPLE_ADVERT_TX_HASH, SAMPLE_ADVERT_INDEX } from "../fixtures/supplier-side/sample-config.js";
import { SUPPLIER_PRIVATE_KEY_HEX } from "../fixtures/supplier-side/wallet-keys.js";

// ─── loadConfig — happy paths ────────────────────────────────────────────────

describe("loadConfig() — happy path", () => {
  it("returns a valid SupplierConfig for a complete env map", () => {
    const cfg = loadConfig(buildSampleEnv());
    expect(cfg.supplierPrivKeyHex).toBe(SUPPLIER_PRIVATE_KEY_HEX);
    expect(cfg.ogmiosUrl).toBe("ws://localhost:1337");
    expect(cfg.ollamaUrl).toBe("http://localhost:11434");
    expect(cfg.advertRef.txHash).toBe(SAMPLE_ADVERT_TX_HASH);
    expect(cfg.advertRef.index).toBe(SAMPLE_ADVERT_INDEX);
    expect(cfg.networkId).toBe(0);
    expect(cfg.port).toBe(8080);
    expect(cfg.ollamaTimeoutMs).toBe(120_000);
  });

  it("parses NETWORK_ID 1 as mainnet", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), NETWORK_ID: "1" });
    expect(cfg.networkId).toBe(1);
  });

  it("defaults PORT to 8080 when omitted", () => {
    const env = { ...buildSampleEnv() };
    delete env.PORT;
    const cfg = loadConfig(env);
    expect(cfg.port).toBe(8080);
  });

  it("defaults OLLAMA_TIMEOUT_MS to 120_000 when omitted", () => {
    const env = { ...buildSampleEnv() };
    delete env.OLLAMA_TIMEOUT_MS;
    const cfg = loadConfig(env);
    expect(cfg.ollamaTimeoutMs).toBe(120_000);
  });

  it("accepts custom PORT", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), PORT: "9000" });
    expect(cfg.port).toBe(9000);
  });

  it("accepts custom OLLAMA_TIMEOUT_MS", () => {
    const cfg = loadConfig({ ...buildSampleEnv(), OLLAMA_TIMEOUT_MS: "30000" });
    expect(cfg.ollamaTimeoutMs).toBe(30_000);
  });
});

// ─── loadConfig — missing required vars ─────────────────────────────────────

describe("loadConfig() — missing required vars", () => {
  it("throws when SUPPLIER_PRIV_KEY_HEX is missing", () => {
    const env = { ...buildSampleEnv() };
    delete env.SUPPLIER_PRIV_KEY_HEX;
    expect(() => loadConfig(env)).toThrow();
  });

  it("throws when OGMIOS_URL is missing", () => {
    const env = { ...buildSampleEnv() };
    delete env.OGMIOS_URL;
    expect(() => loadConfig(env)).toThrow();
  });

  it("throws when OLLAMA_URL is missing", () => {
    const env = { ...buildSampleEnv() };
    delete env.OLLAMA_URL;
    expect(() => loadConfig(env)).toThrow();
  });

  it("throws when ADVERT_REF is missing", () => {
    const env = { ...buildSampleEnv() };
    delete env.ADVERT_REF;
    expect(() => loadConfig(env)).toThrow();
  });

  it("throws when NETWORK_ID is missing", () => {
    const env = { ...buildSampleEnv() };
    delete env.NETWORK_ID;
    expect(() => loadConfig(env)).toThrow();
  });
});

// ─── loadConfig — malformed values ──────────────────────────────────────────

describe("loadConfig() — malformed values", () => {
  it("throws when SUPPLIER_PRIV_KEY_HEX is not 64-char hex", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), SUPPLIER_PRIV_KEY_HEX: "short" })
    ).toThrow();
  });

  it("throws when SUPPLIER_PRIV_KEY_HEX is 63 chars (odd length)", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), SUPPLIER_PRIV_KEY_HEX: "a".repeat(63) })
    ).toThrow();
  });

  it("throws when SUPPLIER_PRIV_KEY_HEX is 64 chars but contains non-hex", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), SUPPLIER_PRIV_KEY_HEX: "z".repeat(64) })
    ).toThrow();
  });

  it("throws when NETWORK_ID is not '0' or '1'", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), NETWORK_ID: "2" })
    ).toThrow();
  });

  it("throws when ADVERT_REF is malformed (no # separator)", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), ADVERT_REF: "nohashsep" })
    ).toThrow();
  });

  it("throws when ADVERT_REF txHash is not 64 hex chars", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), ADVERT_REF: "abc#0" })
    ).toThrow();
  });

  it("throws when ADVERT_REF index is not a non-negative integer", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), ADVERT_REF: `${"a".repeat(64)}#-1` })
    ).toThrow();
  });

  it("throws when PORT is not a positive integer string", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), PORT: "not-a-port" })
    ).toThrow();
  });

  it("throws when OLLAMA_TIMEOUT_MS is not a positive integer string", () => {
    expect(() =>
      loadConfig({ ...buildSampleEnv(), OLLAMA_TIMEOUT_MS: "0" })
    ).toThrow();
  });

  it("error message mentions the missing/malformed field name", () => {
    const env = { ...buildSampleEnv() };
    delete env.SUPPLIER_PRIV_KEY_HEX;
    let errorMsg = "";
    try {
      loadConfig(env);
    } catch (e) {
      errorMsg = (e as Error).message;
    }
    expect(errorMsg.toLowerCase()).toMatch(/supplier_priv_key_hex/i);
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

// ─── loadConfig — HuggingFace router preset (W1) ────────────────────────────
// The HF Inference Providers router (router.huggingface.co) is OpenAI-compatible
// and reuses LLM_BACKEND=openai, but rejects the OpenRouter-specific
// reasoning:{enabled:false} param with HTTP 400 — so OPENAI_REASONING must stay
// unset for it. loadConfig fails fast at boot to catch the copy-from-OpenRouter
// footgun. See docs/HUGGINGFACE_ROUTER_SETUP.md.

describe("loadConfig() — HuggingFace router guard", () => {
  const hfEnv = (over: Record<string, string> = {}) => ({
    ...buildSampleEnv(),
    LLM_BACKEND: "openai",
    OPENAI_BASE_URL: "https://router.huggingface.co",
    OPENAI_API_KEY: "hf_sampletoken",
    ...over,
  });

  it("accepts the HF router with OPENAI_REASONING unset", () => {
    const cfg = loadConfig(hfEnv());
    expect(cfg.openaiBaseUrl).toBe("https://router.huggingface.co");
    expect(cfg.llmBackend).toBe("openai");
    expect(cfg.openaiReasoningDisabled).toBe(false);
  });

  it("throws when OPENAI_REASONING=off is set against the HF router", () => {
    expect(() => loadConfig(hfEnv({ OPENAI_REASONING: "off" }))).toThrow(
      /OPENAI_REASONING must be unset for the HuggingFace router/i,
    );
  });

  it("still allows OPENAI_REASONING=off for non-HF openai backends (e.g. OpenRouter)", () => {
    const cfg = loadConfig({
      ...buildSampleEnv(),
      LLM_BACKEND: "openai",
      OPENAI_BASE_URL: "https://openrouter.ai/api",
      OPENAI_REASONING: "off",
    });
    expect(cfg.openaiReasoningDisabled).toBe(true);
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

  it("defaults to 1 slot and full settle mode", () => {
    const cfg = loadConfig(buildSampleEnv());
    expect(cfg.maxChatSessions).toBe(1);
    expect(cfg.chatSettleMode).toBe("full");
  });

  it("parses MAX_CHAT_SESSIONS and CHAT_SETTLE_MODE for chat-session kind", () => {
    const cfg = loadConfig({ ...chatSessionEnv(), MAX_CHAT_SESSIONS: "8", CHAT_SETTLE_MODE: "ticket" });
    expect(cfg.maxChatSessions).toBe(8);
    expect(cfg.chatSettleMode).toBe("ticket");
  });

  it("rejects MAX_CHAT_SESSIONS > 1 for non-chat-session kinds", () => {
    expect(() => loadConfig({ ...buildSampleEnv(), MAX_CHAT_SESSIONS: "4" })).toThrow();
  });

  it("rejects CHAT_SETTLE_MODE=ticket for non-chat-session kinds", () => {
    expect(() => loadConfig({ ...buildSampleEnv(), CHAT_SETTLE_MODE: "ticket" })).toThrow();
  });

  it("rejects invalid values", () => {
    expect(() => loadConfig({ ...chatSessionEnv(), MAX_CHAT_SESSIONS: "0" })).toThrow();
    expect(() => loadConfig({ ...chatSessionEnv(), CHAT_SETTLE_MODE: "nope" })).toThrow();
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

  it("parses OPENAI_MODEL_OVERRIDE (default empty = advert model verbatim)", () => {
    expect(loadConfig(chatSessionEnv()).openaiModelOverride).toBe("");
    const cfg = loadConfig({ ...chatSessionEnv(), OPENAI_MODEL_OVERRIDE: "openclaw" });
    expect(cfg.openaiModelOverride).toBe("openclaw");
  });
});
