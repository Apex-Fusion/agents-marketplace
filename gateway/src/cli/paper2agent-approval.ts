import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { GatewayStore } from "../db/store.js";
import {
  approvePaper2Agent,
  revokePaper2Agent,
  type Paper2AgentApprovalInput,
} from "../paper2agent/service.js";

const USAGE = `paper2agent-approval approve --key-id ID --manifest-hash HEX64 --supplier-pkh HEX56
  --max-price-lovelace INTEGER --max-total-spend-lovelace INTEGER [--max-calls INTEGER] [--db DIRECTORY]
paper2agent-approval revoke --key-id ID [--db DIRECTORY]

Use an existing dedicated key's ID, not its API key. Both money limits are required.
The call limit defaults to one. Existing approvals cannot be replaced or reset.`;

type ApprovalCommand = { dbDir: string } & (
  | { action: "approve"; input: Paper2AgentApprovalInput }
  | { action: "revoke"; keyId: string }
);

/** Parse all limits before opening the database. There are no money defaults. */
export function parseApprovalCommand(args: string[], dbDir = process.env.GATEWAY_DB_DIR ?? "./data/gateway"): ApprovalCommand {
  const { values, positionals } = parseArgs({
    args, strict: true, allowPositionals: true,
    options: {
      db: { type: "string" },
      "key-id": { type: "string" },
      "manifest-hash": { type: "string" },
      "supplier-pkh": { type: "string" },
      "max-price-lovelace": { type: "string" },
      "max-total-spend-lovelace": { type: "string" },
      "max-calls": { type: "string" },
    },
  });
  if (positionals.length !== 1 || !["approve", "revoke"].includes(positionals[0])) {
    throw new Error("choose approve or revoke");
  }
  const keyId = values["key-id"];
  if (!keyId || keyId.startsWith("vk_")) throw new Error("a key ID is required, not an API key");
  const path = values.db ?? dbDir;
  if (!path) throw new Error("database directory is required");
  if (positionals[0] === "revoke") {
    if (Object.keys(values).some((name) => name !== "key-id" && name !== "db")) {
      throw new Error("revoke only accepts key-id and db");
    }
    return { action: "revoke", keyId, dbDir: path };
  }
  const manifestHash = values["manifest-hash"];
  const supplierPkh = values["supplier-pkh"];
  if (!manifestHash || !/^[0-9a-f]{64}$/.test(manifestHash)) throw new Error("manifest hash must be lowercase hex");
  if (!supplierPkh || !/^[0-9a-f]{56}$/.test(supplierPkh)) throw new Error("supplier PKH must be lowercase hex");
  const price = values["max-price-lovelace"];
  const spend = values["max-total-spend-lovelace"];
  if (!price || !/^(0|[1-9][0-9]*)$/.test(price) || !spend || !/^[1-9][0-9]*$/.test(spend)) {
    throw new Error("explicit integer limits are required: nonnegative price and positive total spend");
  }
  const calls = values["max-calls"] ?? "1";
  const maxCalls = Number(calls);
  if (!/^[1-9][0-9]*$/.test(calls) || !Number.isSafeInteger(maxCalls)) {
    throw new Error("max-calls must be a positive safe integer");
  }
  return {
    action: "approve", dbDir: path,
    input: { keyId, manifestHash, supplierPkh, maxPriceLovelace: BigInt(price), maxTotalSpendLovelace: BigInt(spend), maxCalls },
  };
}

function main(): void {
  if (process.argv.slice(2).includes("--help")) {
    console.log(USAGE);
    return;
  }
  try {
    const command = parseApprovalCommand(process.argv.slice(2));
    const store = new GatewayStore(command.dbDir);
    if (command.action === "approve") approvePaper2Agent(store, command.input);
    else revokePaper2Agent(store, command.keyId);
    console.log(`[gateway] Paper2Agent approval ${command.action === "approve" ? "created" : "revoked"}.`);
  } catch {
    // Never echo operator arguments, API keys, database contents, or secrets.
    console.error(`Paper2Agent approval change failed. Check the key ID, limits, and existing approval.\n${USAGE}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
