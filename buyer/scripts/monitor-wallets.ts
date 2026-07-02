/**
 * monitor-wallets.ts — show AP3X balances of every operator-owned wallet
 * (across vector-marketplace + open-webui) plus every supplier currently
 * registered on the mp-indexer, on Vector mainnet. Operator wallets below
 * a per-role threshold are marked LOW so the operator can top them up.
 *
 * Reads private keys via `ssh <host> "grep ^VAR= <path>"`. The hex value
 * lives only in the in-memory derivation result; it is never written to
 * local disk, stdout, or JSON output.
 *
 * Run:
 *   pnpm tsx buyer/scripts/monitor-wallets.ts
 *   pnpm tsx buyer/scripts/monitor-wallets.ts --json
 *   pnpm tsx buyer/scripts/monitor-wallets.ts --buyer-min 15 --supplier-min 5
 */
/* eslint-disable no-console */

import { execFileSync } from "child_process";
import { createHash } from "crypto";
import * as ed from "@noble/ed25519";
import { blake2b } from "@noble/hashes/blake2b";
import { bech32 } from "bech32";
import { ReadOnlyOgmiosProvider } from "@marketplace/shared/chain";

ed.etc.sha512Sync = (...messages: Uint8Array[]): Uint8Array => {
  const h = createHash("sha512");
  for (const m of messages) h.update(m);
  return new Uint8Array(h.digest());
};

const MAINNET_OGMIOS = "https://ogmios.vector.mainnet.apexfusion.org";
const INDEXER_URL = "https://mp-indexer.vector.apexfusion.org";
const NETWORK_ID = 1 as const;

interface OperatorSource {
  label: string;
  host: string;
  envPath: string;
  keyVar: "BUYER_PRIV_KEY_HEX" | "SUPPLIER_PRIV_KEY_HEX";
  role: "buyer" | "supplier";
}

const OPERATOR_SOURCES: OperatorSource[] = [
  {
    label: "buyer@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/buyer/.env",
    keyVar: "BUYER_PRIV_KEY_HEX",
    role: "buyer",
  },
  {
    label: "supplier-ollama@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-gpt@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.gpt",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-tts@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.tts",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-deepseek@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.deepseek",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-kimi@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.kimi",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-kimi-2@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.kimi-2",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-kimi-3@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.kimi-3",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-kimi-4@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.kimi-4",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-deepseek-flash-1@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.deepseek-flash-1",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-deepseek-flash-2@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.deepseek-flash-2",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "supplier-deepseek-flash-3@vector-marketplace",
    host: "root@91.98.147.172",
    envPath: "/root/agents-marketplace/supplier/.env.deepseek-flash-3",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "buyer@open-webui",
    host: "open-webui",
    envPath: "/root/marketplace-buyer-mainnet/.env",
    keyVar: "BUYER_PRIV_KEY_HEX",
    role: "buyer",
  },
  {
    label: "supplier@open-webui",
    host: "open-webui",
    // open-webui's mainnet supplier uses 'supplier.env' (no leading dot) —
    // a `find -name '.env*'` sweep silently misses it.
    envPath: "/root/marketplace-mainnet-supplier/supplier.env",
    keyVar: "SUPPLIER_PRIV_KEY_HEX",
    role: "supplier",
  },
  {
    label: "buyer-a@vector-modules-simulation",
    host: "user@178.105.3.133",
    envPath: "/home/user/marketplace-agents/buyer-a.env",
    keyVar: "BUYER_PRIV_KEY_HEX",
    role: "buyer",
  },
  {
    label: "buyer-b@vector-modules-simulation",
    host: "user@178.105.3.133",
    envPath: "/home/user/marketplace-agents/buyer-b.env",
    keyVar: "BUYER_PRIV_KEY_HEX",
    role: "buyer",
  },
];

// ── argv ──────────────────────────────────────────────────────────────

interface Args {
  json: boolean;
  buyerMin: bigint;
  supplierMin: bigint;
}

function parseArgs(argv: string[]): Args {
  let json = false;
  let buyerMin = 10n * 1_000_000n;
  let supplierMin = 3n * 1_000_000n;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") continue;
    if (a === "--json") json = true;
    else if (a === "--buyer-min") buyerMin = ap3xToLovelace(argv[++i]);
    else if (a === "--supplier-min") supplierMin = ap3xToLovelace(argv[++i]);
    else if (a === "-h" || a === "--help") {
      console.log(
        "usage: monitor-wallets [--json] [--buyer-min AP3X] [--supplier-min AP3X]",
      );
      process.exit(0);
    } else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return { json, buyerMin, supplierMin };
}

function ap3xToLovelace(s: string | undefined): bigint {
  if (s === undefined) throw new Error("expected AP3X value");
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid AP3X: ${s}`);
  return BigInt(Math.round(n * 1_000_000));
}

// ── wallet derivation (mirrors buyer/src/index.ts:deriveWalletKey) ───

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (clean.length % 2 !== 0) throw new Error(`odd-length hex: ${clean.length}`);
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

function bytesToHex(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i++) out += b[i].toString(16).padStart(2, "0");
  return out;
}

function deriveAddressFromPrivKey(
  privHex: string,
  networkId: 0 | 1,
): { address: string; pkhHex: string } {
  const priv = hexToBytes(privHex);
  const pub = ed.getPublicKey(priv);
  const pkh = blake2b(pub, { dkLen: 28 });
  const pkhHex = bytesToHex(pkh);
  return { address: pkhToAddress(pkhHex, networkId), pkhHex };
}

function pkhToAddress(pkhHex: string, networkId: 0 | 1): string {
  const pkh = hexToBytes(pkhHex);
  if (pkh.length !== 28)
    throw new Error(`pkh must be 28 bytes, got ${pkh.length}`);
  const header = networkId === 0 ? 0x60 : 0x61;
  const payload = new Uint8Array(29);
  payload[0] = header;
  payload.set(pkh, 1);
  const hrp = networkId === 0 ? "addr_test" : "addr";
  return bech32.encode(hrp, bech32.toWords(payload), 1023);
}

// ── ssh fetcher ──────────────────────────────────────────────────────

function fetchPrivKeyOverSsh(src: OperatorSource): string {
  const remoteCmd = `grep -E '^${src.keyVar}=' ${src.envPath} | head -n 1`;
  const out = execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", src.host, remoteCmd],
    { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const line = out.trim();
  if (!line)
    throw new Error(`${src.keyVar} not found in ${src.host}:${src.envPath}`);
  const eq = line.indexOf("=");
  if (eq === -1) throw new Error(`malformed env line at ${src.host}:${src.envPath}`);
  let value = line.slice(eq + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  if (!/^[0-9a-fA-F]+$/.test(value) || value.length < 32) {
    throw new Error(
      `${src.keyVar} at ${src.host}:${src.envPath} doesn't look like hex`,
    );
  }
  return value;
}

// ── indexer ──────────────────────────────────────────────────────────

interface IndexerSupplier {
  supplier_pkh: string;
  endpoint_url?: string;
  model?: string;
  status?: string;
  advert_status?: string;
}

async function fetchOnChainSuppliers(): Promise<IndexerSupplier[]> {
  const res = await fetch(`${INDEXER_URL}/suppliers`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`indexer /suppliers HTTP ${res.status}`);
  const j = (await res.json()) as IndexerSupplier[];
  if (!Array.isArray(j)) throw new Error(`indexer /suppliers: expected array`);
  return j;
}

// ── main ──────────────────────────────────────────────────────────────

type Kind = "operator" | "third-party-supplier";

interface Row {
  kind: Kind;
  label: string;
  address: string;
  pkhHex: string;
  role?: "buyer" | "supplier";
  lovelace: bigint;
  minLovelace: bigint | null;
  note: string;
  error: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = new ReadOnlyOgmiosProvider({ ogmiosUrl: MAINNET_OGMIOS });

  const operatorRows: Row[] = [];
  const operatorPkhs = new Map<string, OperatorSource>();
  for (const src of OPERATOR_SOURCES) {
    const min = src.role === "buyer" ? args.buyerMin : args.supplierMin;
    try {
      const hex = fetchPrivKeyOverSsh(src);
      const { address, pkhHex } = deriveAddressFromPrivKey(hex, NETWORK_ID);
      operatorPkhs.set(pkhHex, src);
      operatorRows.push({
        kind: "operator",
        label: src.label,
        address,
        pkhHex,
        role: src.role,
        lovelace: 0n,
        minLovelace: min,
        note: "",
        error: null,
      });
    } catch (e) {
      operatorRows.push({
        kind: "operator",
        label: src.label,
        address: "",
        pkhHex: "",
        role: src.role,
        lovelace: 0n,
        minLovelace: min,
        note: "",
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const thirdPartyRows: Row[] = [];
  let suppliers: IndexerSupplier[] = [];
  let indexerError: string | null = null;
  try {
    suppliers = await fetchOnChainSuppliers();
  } catch (e) {
    indexerError = e instanceof Error ? e.message : String(e);
  }
  for (const s of suppliers) {
    if (operatorPkhs.has(s.supplier_pkh)) continue;
    let address = "";
    let note = s.endpoint_url ? `endpoint=${s.endpoint_url}` : "";
    try {
      address = pkhToAddress(s.supplier_pkh, NETWORK_ID);
    } catch (e) {
      note = `[skip] ${e instanceof Error ? e.message : String(e)}`;
    }
    thirdPartyRows.push({
      kind: "third-party-supplier",
      label: `supplier-${s.supplier_pkh.slice(0, 8)}`,
      address,
      pkhHex: s.supplier_pkh,
      lovelace: 0n,
      minLovelace: null,
      note,
      error: null,
    });
  }

  const allRows = [...operatorRows, ...thirdPartyRows];
  await Promise.all(
    allRows.map(async (row) => {
      if (row.error || !row.address) return;
      try {
        const utxos = await provider.queryUtxosByAddress(row.address);
        row.lovelace = utxos.reduce((a, u) => a + BigInt(u.lovelace), 0n);
      } catch (e) {
        row.error = e instanceof Error ? e.message : String(e);
      }
    }),
  );

  for (const row of allRows) {
    if (row.kind !== "operator" || row.error || row.minLovelace === null) continue;
    if (row.lovelace < row.minLovelace) {
      row.note = row.lovelace === 0n ? "LOW (empty)" : "LOW";
    }
  }

  const cmpAsc = (a: Row, b: Row): number => {
    if (a.lovelace === b.lovelace) return 0;
    return a.lovelace < b.lovelace ? -1 : 1;
  };
  const opSorted = operatorRows.slice().sort(cmpAsc);
  const tpSorted = thirdPartyRows.slice().sort(cmpAsc);
  const sortedRows = [...opSorted, ...tpSorted];

  if (args.json) {
    const payload = sortedRows.map((r) => ({
      kind: r.kind,
      label: r.label,
      role: r.role ?? null,
      address: r.address,
      pkh: r.pkhHex,
      ap3x: Number(r.lovelace) / 1e6,
      lovelace: r.lovelace.toString(),
      min_ap3x: r.minLovelace === null ? null : Number(r.minLovelace) / 1e6,
      note: r.note,
      error: r.error,
    }));
    console.log(
      JSON.stringify({ rows: payload, indexer_error: indexerError }, null, 2),
    );
  } else {
    printTable(sortedRows, indexerError);
  }

  const anyOperatorIssue = operatorRows.some(
    (r) =>
      r.error !== null ||
      (r.minLovelace !== null && r.lovelace < r.minLovelace),
  );
  if (anyOperatorIssue) process.exitCode = 1;
}

function fmtAp3x(lovelace: bigint): string {
  return (Number(lovelace) / 1e6).toFixed(3);
}

function padL(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padR(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function printTable(rows: Row[], indexerError: string | null): void {
  const headers = ["kind", "label", "AP3X", "min", "address", "note"];
  const cells: string[][] = [headers];
  for (const r of rows) {
    const ap3x = r.error ? "—" : fmtAp3x(r.lovelace);
    const min = r.minLovelace === null ? "—" : fmtAp3x(r.minLovelace);
    const addr = r.address || "—";
    const note = r.error ? `ERROR: ${r.error}` : r.note;
    cells.push([
      r.kind === "operator" ? "operator" : "3rd-party",
      r.label,
      ap3x,
      min,
      addr,
      note,
    ]);
  }
  const widths = headers.map((_, c) =>
    Math.max(...cells.map((r) => r[c]?.length ?? 0)),
  );
  for (const r of cells) {
    const line = r
      .map((cell, c) => (c === 2 || c === 3 ? padR(cell, widths[c]) : padL(cell, widths[c])))
      .join("  ");
    console.log(line);
  }
  const opCount = rows.filter((r) => r.kind === "operator").length;
  const opLow = rows.filter(
    (r) =>
      r.kind === "operator" &&
      !r.error &&
      r.minLovelace !== null &&
      r.lovelace < r.minLovelace,
  ).length;
  const opErr = rows.filter((r) => r.kind === "operator" && r.error).length;
  const tpCount = rows.filter((r) => r.kind === "third-party-supplier").length;
  console.log(
    `\ntotal: ${opCount} operator wallets (${opLow} LOW, ${opErr} ERROR), ${tpCount} third-party suppliers`,
  );
  if (indexerError) console.log(`\nindexer error: ${indexerError}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
