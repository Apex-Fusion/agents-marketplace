import { describe, expect, it } from "vitest";
import { randomUUID } from "crypto";
import { join } from "path";
import { tmpdir } from "os";
import { GatewayStore } from "../src/db/store.js";

function addResponse(store: GatewayStore, args: {
  id: string;
  keyId: string;
  parent?: string;
  sessionId?: string;
  expiresAt?: number;
}): void {
  store.insertResponse({
    id: args.id,
    key_id: args.keyId,
    model: "m",
    previous_response_id: args.parent ?? null,
    session_id: null,
    status: "in_progress",
    stored: 1,
    created_at: Date.now(),
    expires_at: args.expiresAt ?? Date.now() + 60_000,
    input_nonce: "n",
    input_ct: "c",
    input_tag: "t",
  });
  store.completeResponse(args.id, args.keyId, {
    status: "completed",
    session_id: args.sessionId ?? null,
    completed_at: Date.now(),
    response_nonce: "rn",
    response_ct: "rc",
    response_tag: "rt",
  }, args.sessionId ? args.id : undefined);
}

describe("Responses continuation state", () => {
  it("scopes response lookup by owner and recursively deletes forks", () => {
    const store = new GatewayStore(join(tmpdir(), `gateway-response-${randomUUID()}`));
    addResponse(store, { id: "resp_parent", keyId: "key-a" });
    addResponse(store, { id: "resp_child_a", keyId: "key-a", parent: "resp_parent" });
    addResponse(store, { id: "resp_child_b", keyId: "key-a", parent: "resp_parent" });

    expect(store.getOwnedResponse("resp_parent", "key-b")).toBeUndefined();
    expect(store.getOwnedResponse("resp_parent", "key-a")?.status).toBe("completed");
    expect(store.deleteResponseTree("resp_parent", "key-b")).toBe(false);
    expect(store.deleteResponseTree("resp_parent", "key-a")).toBe(true);
    expect(store.getResponse("resp_child_a")).toBeUndefined();
    expect(store.getResponse("resp_child_b")).toBeUndefined();
  });

  it("tracks an exact session head so a stale parent is a fork", () => {
    const store = new GatewayStore(join(tmpdir(), `gateway-head-${randomUUID()}`));
    store.insertSession({
      id: "session-1", key_id: "key-a", escrow_ref: "e#0", session_nonce: "nonce",
      supplier_base_url: "http://supplier", supplier_pkh: "p", model: "m",
      price_lovelace: "1", state: "open", opened_at: Date.now(), managed_demo: 1,
      max_output_tokens: 100,
    });
    addResponse(store, { id: "resp_child_a", keyId: "key-a", sessionId: "session-1" });
    expect(store.getSession("session-1")?.head_response_id).toBe("resp_child_a");
    expect(store.getSession("session-1")?.head_response_id).not.toBe("resp_parent");
    expect(store.deleteResponseTree("resp_child_a", "key-a")).toBe(true);
    expect(store.getSession("session-1")?.head_response_id).toBeNull();
  });

  it("keeps terminal states final and invalidates a deleted pending branch", () => {
    const store = new GatewayStore(join(tmpdir(), `gateway-race-${randomUUID()}`));
    store.insertSession({
      id: "session-race", key_id: "key-a", escrow_ref: "e#0", session_nonce: "nonce",
      supplier_base_url: "http://supplier", supplier_pkh: "p", model: "m",
      price_lovelace: "1", state: "open", opened_at: Date.now(), managed_demo: 1,
      max_output_tokens: 100, max_processing_ms: 300_000,
    });
    addResponse(store, { id: "resp_parent", keyId: "key-a", sessionId: "session-race" });
    store.insertResponse({
      id: "resp_child", key_id: "key-a", model: "m",
      previous_response_id: "resp_parent", session_id: null, status: "in_progress",
      stored: 1, created_at: Date.now(), expires_at: Date.now() + 60_000,
      input_nonce: "n", input_ct: "c", input_tag: "t",
    });
    expect(store.deleteResponseTree("resp_child", "key-a")).toBe(true);
    expect(store.completeResponse("resp_child", "key-a", {
      status: "completed", session_id: "session-race", completed_at: Date.now(),
      response_nonce: "rn", response_ct: "rc", response_tag: "rt",
    }, "resp_child")).toBe(false);
    expect(store.getSession("session-race")?.head_response_id).toBeNull();

    store.insertResponse({
      id: "resp_final", key_id: "key-a", model: "m",
      previous_response_id: null, session_id: null, status: "in_progress",
      stored: 1, created_at: Date.now(), expires_at: Date.now() + 60_000,
      input_nonce: "n", input_ct: "c", input_tag: "t",
    });
    expect(store.completeResponse("resp_final", "key-a", {
      status: "failed", session_id: null, completed_at: Date.now(),
      response_nonce: "rn", response_ct: "failed", response_tag: "rt",
    })).toBe(true);
    expect(store.completeResponse("resp_final", "key-a", {
      status: "completed", session_id: null, completed_at: Date.now(),
      response_nonce: "rn", response_ct: "late", response_tag: "rt",
    })).toBe(false);
    expect(store.getResponse("resp_final")?.status).toBe("failed");
    expect(store.getResponse("resp_final")?.response_ct).toBe("failed");
  });

  it("extends ancestor retention and clears expired session heads", () => {
    const store = new GatewayStore(join(tmpdir(), `gateway-expiry-${randomUUID()}`));
    const now = Date.now();
    addResponse(store, {
      id: "resp_parent",
      keyId: "key-a",
      expiresAt: now + 10,
    });
    addResponse(store, {
      id: "resp_child",
      keyId: "key-a",
      parent: "resp_parent",
      expiresAt: now + 20_000,
    });
    expect(store.getResponse("resp_parent")?.expires_at).toBe(now + 20_000);

    store.insertSession({
      id: "session-expired", key_id: "key-a", escrow_ref: "e#1", session_nonce: "nonce",
      supplier_base_url: "http://supplier", supplier_pkh: "p", model: "m",
      price_lovelace: "1", state: "open", opened_at: now, managed_demo: 1,
      max_output_tokens: 100,
    });
    addResponse(store, {
      id: "resp_expired",
      keyId: "key-a",
      sessionId: "session-expired",
      expiresAt: now - 1,
    });
    expect(store.getSession("session-expired")?.head_response_id).toBe("resp_expired");
    expect(store.deleteExpiredResponses(now)).toBeGreaterThan(0);
    expect(store.getSession("session-expired")?.head_response_id).toBeNull();
    expect(store.getResponse("resp_expired")).toBeUndefined();
  });
});
