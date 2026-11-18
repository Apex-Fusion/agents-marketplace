/**
 * decoder-stop-limits.test.ts — the time limit of a shutdown that the decoder check starts equals what Docker gives a stop.
 *
 * Docker gives a stop of a service `stop_grace_period` (10 s when the compose file has none). A shutdown that the decoder check
 * starts has no stop of Docker behind it, so each process ends itself after the same time. The value is a constant in the entry of
 * each process, and the compose file of the service holds the other. This test reads both, so that a change of one shows the other.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DECODER_STOP_LIMIT_MS as GATEWAY } from "../../gateway/src/index.js";
import { DECODER_STOP_LIMIT_MS as BUYER } from "../../buyer/src/index.js";
import { DECODER_STOP_LIMIT_MS as SUPPLIER } from "../../supplier/src/index.js";
import { DECODER_STOP_LIMIT_MS as SURPLUS } from "../../supplier/src/cli/surplus-seller.js";
import { DECODER_STOP_LIMIT_MS as PUBLISHER } from "../../paper2agent/src/serve.js";

const ROOT = resolve(__dirname, "../..");
const DOCKER_DEFAULT_MS = 10_000;
const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** The `stop_grace_period` of a compose file in ms (the Docker default when it has none). */
function graceOf(composeFile: string): number {
  const text = readFileSync(resolve(ROOT, "deploy/mainnet", composeFile), "utf8");
  const match = /^\s*stop_grace_period:\s*(\d+)(ms|s|m|h)\s*$/m.exec(text);
  return match === null ? DOCKER_DEFAULT_MS : Number(match[1]) * UNITS[match[2]!]!;
}

describe("the time limit of a shutdown that the decoder check starts", () => {
  it.each([
    ["gateway", "docker-compose.gateway.yml", GATEWAY, 10_000],
    ["buyer", "docker-compose.buyer.yml", BUYER, 330_000],
    ["supplier", "docker-compose.supplier.yml", SUPPLIER, 10_000],
    ["surplus seller", "docker-compose.surplus-seller.yml", SURPLUS, 10_000],
    ["Paper2Agent publisher", "docker-compose.paper2agent-publisher.yml", PUBLISHER, 1_020_000],
  ])("%s: equals the stop_grace_period of %s", (_name, file, limit, expected) => {
    expect(limit).toBe(graceOf(file));
    expect(limit).toBe(expected);
  });
});
