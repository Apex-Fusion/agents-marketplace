// The identity deployment tool (Part 2 §11 step 2). Runbook: README.md in this directory.
//   npx tsx contracts/identity-marketplace/deploy/cli.ts <command> --network mainnet [options]

import { parseArgs, type ParseArgsConfig } from "node:util";
import { fileURLToPath } from "node:url";
import { TxConstructionError } from "@marketplace/shared";
import { check } from "./check.js";
import { allowlist, keygen, plan, publishRefs, seal, seed, sign, submit } from "./commands.js";
import { defaultIo, type Io } from "./context.js";
import { DeployError } from "./network.js";

type Options = NonNullable<ParseArgsConfig["options"]>;

const COMMON: Options = {
  network: { type: "string" },
  dir: { type: "string" },
  ogmios: { type: "string" },
  "submit-url": { type: "string" },
  koios: { type: "string" },
  "legacy-policy": { type: "string" },
};
const TX_MODES: Options = {
  submit: { type: "boolean" },
  build: { type: "boolean" },
  rebuild: { type: "boolean" },
  wait: { type: "string" },
};

const COMMANDS: Record<string, Options> = {
  keygen: { ...COMMON, out: { type: "string" }, name: { type: "string" } },
  allowlist: { ...COMMON, "cutoff-slot": { type: "string" }, cutoff: { type: "string" } },
  seed: { ...COMMON, ...TX_MODES, skey: { type: "string" }, operator: { type: "string" }, to: { type: "string" }, amount: { type: "string" } },
  plan: {
    ...COMMON, seed: { type: "string" }, "seed-address": { type: "string" }, allowlist: { type: "string" }, "no-seed-check": { type: "boolean" },
    operator: { type: "string" }, skey: { type: "string" }, "seed-amount": { type: "string" },
  },
  "publish-refs": { ...COMMON, ...TX_MODES, scripts: { type: "string" }, to: { type: "string" }, skey: { type: "string" }, operator: { type: "string" } },
  seal: { ...COMMON, ...TX_MODES, "module1-manifest": { type: "string" }, "seed-skey": { type: "string" } },
  check: { ...COMMON, "module1-manifest": { type: "string" } },
  sign: { tx: { type: "string" }, skey: { type: "string" }, out: { type: "string" } },
  submit: { ...COMMON, tx: { type: "string" }, submit: { type: "boolean" }, wait: { type: "string" } },
};

const USAGE = `usage: npx tsx contracts/identity-marketplace/deploy/cli.ts <command> [options]

commands (each with --network mainnet|testnet, except sign):
  keygen        --out <dir> [--name operator]
  allowlist     --cutoff-slot <slot> | --cutoff now [--legacy-policy <hex>]
  seed          --to <seal-seed address> --amount <AP3X> [--skey <operator key> | --operator <address>]
  plan          [--seed <txid#ix>] [--seed-address <address>] [--allowlist <file>] [--no-seed-check]
                [--skey <operator key> | --operator <address>] [--seed-amount <AP3X>]
  publish-refs  [--scripts identity,attestation,delegation,vault,escrow,advert] [--to <address>]
                [--skey <operator key> | --operator <address>]
  seal          --module1-manifest <file> [--seed-skey <seal-seed key>]
  check         [--module1-manifest <file>]
  sign          --tx <file> --skey <key> [--out <file>]
  submit        --tx <signed file> [--submit]

transaction commands (seed, publish-refs, seal): dry run by default; --submit sends (with a key);
--build writes unsigned transactions for sign and submit; --rebuild builds a recorded step again;
--wait <seconds> after a submit (default 180).
common: --dir <state dir> (default contracts/identity-marketplace/deploy/state/<network>),
--ogmios <url>, --submit-url <url>, --koios <url> (or VECTOR_OGMIOS_URL, VECTOR_SUBMIT_URL, VECTOR_KOIOS_URL).`;

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const flag = (value: unknown): boolean => value === true;

function waitSeconds(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0) throw new DeployError("--wait must be a number of seconds");
  return seconds;
}

export async function main(argv: readonly string[], io: Io = defaultIo, env: Record<string, string | undefined> = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help") {
    io.out(USAGE);
    return command === undefined ? 1 : 0;
  }
  const options = COMMANDS[command];
  if (options === undefined) throw new DeployError(`unknown command ${command}\n${USAGE}`);
  let values: Record<string, unknown>;
  try {
    values = parseArgs({ args: [...rest], options, strict: true, allowPositionals: false }).values;
  } catch (error) {
    throw new DeployError(`${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const common = {
    network: text(values.network),
    dir: text(values.dir),
    ogmios: text(values.ogmios),
    submitUrl: text(values["submit-url"]),
    koios: text(values.koios),
    legacyPolicy: text(values["legacy-policy"]),
  };
  const modes = { submit: flag(values.submit), build: flag(values.build), rebuild: flag(values.rebuild), wait: waitSeconds(values.wait) };
  switch (command) {
    case "keygen":
      return keygen({ ...common, out: text(values.out), name: text(values.name) }, io, env);
    case "allowlist":
      return allowlist({ ...common, cutoffSlot: text(values["cutoff-slot"]), cutoff: text(values.cutoff) }, io, env);
    case "seed":
      return seed({ ...common, ...modes, skey: text(values.skey), operator: text(values.operator), to: text(values.to), amount: text(values.amount) }, io, env);
    case "plan":
      return plan({
        ...common, seed: text(values.seed), seedAddress: text(values["seed-address"]), allowlist: text(values.allowlist),
        seedCheck: !flag(values["no-seed-check"]), operator: text(values.operator), skey: text(values.skey), seedAmount: text(values["seed-amount"]),
      }, io, env);
    case "publish-refs":
      return publishRefs({ ...common, ...modes, scripts: text(values.scripts), to: text(values.to), skey: text(values.skey), operator: text(values.operator) }, io, env);
    case "seal":
      return seal({ ...common, ...modes, manifest: text(values["module1-manifest"]), seedSkey: text(values["seed-skey"]) }, io, env);
    case "check":
      return check({ ...common, manifest: text(values["module1-manifest"]) }, io, env);
    case "sign":
      return sign({ tx: text(values.tx), skey: text(values.skey), out: text(values.out) }, io);
    default:
      return submit({ ...common, tx: text(values.tx), submit: flag(values.submit), wait: modes.wait }, io, env);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (status) => process.exit(status),
    (error: unknown) => {
      if (error instanceof DeployError || error instanceof TxConstructionError) {
        process.stderr.write(`error: ${error.message}\n`);
      } else {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      }
      process.exit(1);
    },
  );
}
