/**
 * The parts that the supplier Paper2Agent tests share (supplier-paper2agent.test.ts and supplier-paper2agent-identity.test.ts):
 * one echo tool with its manifest, the request that calls it, a temp folder that holds the reviewed package, and a fake tool session.
 */

import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@modelcontextprotocol/client";
import { vi } from "vitest";
import { paper2AgentManifestHash, parsePaper2AgentManifest } from "../../../packages/shared/src/paper2agent/index.js";
import type { Paper2AgentConfig } from "../../../supplier/src/config.js";
import { deriveSupplierKey } from "../../../supplier/src/paper2agent/identity.js";
import type { ToolSession } from "../../../supplier/src/paper2agent/local.js";

export const schema = { type: "object" as const, properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
export const preparedBytes = "reviewed local package";
export const supplierKey = deriveSupplierKey("11".repeat(32), 0);
export const advertRef = { txHash: "bb".repeat(32), index: 0 };
export const escrowRef = { txHash: "cc".repeat(32), index: 0 };
export const escrowText = `${escrowRef.txHash}#0`;
export const manifest = parsePaper2AgentManifest({ schema_version: 1, name: "echo_record", description: "Test-only tool",
  package_sha256: createHash("sha256").update(preparedBytes).digest("hex"), input_schema: schema, output_schema: schema,
  limits: { max_input_bytes: 4096, max_output_bytes: 4096, max_runtime_ms: 1000 } });
export const manifestHash = paper2AgentManifestHash(manifest);
export const input = { value: "hello" };
export const body = { manifest_hash: manifestHash, input };

/** The options of `vi.waitFor` in these tests: a job ends in a few ms, so the check runs every 5 ms (the default is 50 ms). */
export const POLL = { interval: 5 };

/**
 * A temp folder. The journal calls fsync twice for each save, and on a disk that costs about 3 ms for each call. /dev/shm is memory,
 * so there it costs almost nothing. These tests do not check durability. A host without /dev/shm uses the temp dir.
 */
function tempFolder(prefix: string): string {
  try {
    return mkdtempSync(join("/dev/shm", prefix));
  } catch {
    return mkdtempSync(join(tmpdir(), prefix));
  }
}

/**
 * A temp folder with the reviewed package and its manifest, and a fake tool session that lists the echo tool and returns `input`.
 * The caller removes `directory`.
 */
export function makeToolKit(prefix: string) {
  const directory = tempFolder(prefix);
  const config: Paper2AgentConfig = { executable: process.execPath, argv: [], cwd: directory,
    packagePath: join(directory, "package.bin"), manifestPath: join(directory, "manifest.json"), journalDir: join(directory, "journal") };
  writeFileSync(config.packagePath, preparedBytes);
  writeFileSync(config.manifestPath, JSON.stringify(manifest));
  const tools: Tool[] = [{ name: manifest.name, inputSchema: schema, outputSchema: schema }];
  const session = { discover: vi.fn(async () => tools), execute: vi.fn(async () => input), close: vi.fn(async (): Promise<void> => undefined) } satisfies ToolSession;
  const factory = vi.fn(() => session);
  return { directory, config, session, factory };
}
