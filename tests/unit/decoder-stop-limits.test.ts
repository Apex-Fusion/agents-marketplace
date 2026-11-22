/**
 * decoder-stop-limits.test.ts — the time limit of a shutdown that the decoder check starts.
 *
 * The check starts a shutdown only when the library cannot decode a known value. No stop of Docker stands behind that shutdown, so
 * each process ends itself after a limit (a constant in its entry). Docker gives a stop of a service `stop_grace_period`, and 10 s
 * when the compose file of the service has none.
 *
 * - The gateway, the buyer, the supplier and the surplus seller end after 10 s. The work that is still running in them needs the
 *   library to end well, so a long drain only delays the restart. The limit is at or below the grace period of the compose file.
 * - The publisher ends after the full grace period of its compose file (17 min): its paid work runs in supplier children, which
 *   are separate processes with their own copy of the library.
 *
 * This test reads the constants and the compose files, so that a change of one shows the other.
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
    ["gateway", "docker-compose.gateway.yml", GATEWAY, DOCKER_DEFAULT_MS],
    ["buyer", "docker-compose.buyer.yml", BUYER, 330_000],
    ["supplier", "docker-compose.supplier.yml", SUPPLIER, DOCKER_DEFAULT_MS],
    ["surplus seller", "docker-compose.surplus-seller.yml", SURPLUS, DOCKER_DEFAULT_MS],
  ])("%s: ends after 10 s, which is at or below the stop_grace_period of %s", (_name, file, limit, grace) => {
    expect(limit).toBe(10_000);
    expect(graceOf(file)).toBe(grace);
    expect(limit).toBeLessThanOrEqual(graceOf(file));
  });

  it("Paper2Agent publisher: ends after the full stop_grace_period of its compose file (17 min)", () => {
    expect(PUBLISHER).toBe(graceOf("docker-compose.paper2agent-publisher.yml"));
    expect(PUBLISHER).toBe(1_020_000);
  });
});
