/**
 * paper2agent/src/publisher-config.ts — environment for the Paper2Agent publisher service.
 *
 * Required:
 *   PAPER2AGENT_PUBLISHER_TOKEN        — management bearer token: at least 32 printable
 *                                        characters, no whitespace.
 *   PAPER2AGENT_PUBLISHER_TARGETS_FILE — operator-private JSON array (mode 0600) of wallet
 *                                        slots: [{id,label,env:{SUPPLIER_PRIV_KEY_HEX,
 *                                        NETWORK_ID,OGMIOS_URL,...}}]. One wallet per slot.
 *                                        LIVE_CHAIN=1 requires NETWORK_ID=1 (Vector mainnet) and
 *                                        VECTOR_ZERO_TIME_MS equal to this process's value.
 *   PAPER2AGENT_PUBLISHER_PUBLIC_URL   — public base URL; each advert endpoint is
 *                                        <base>/tools/<target id>.
 *   PAPER2AGENT_RUNTIME_IMAGE          — exact local base image ID (sha256:<64 hex>), the
 *                                        image the builder verified the artifact with.
 *
 * Optional:
 *   PAPER2AGENT_PUBLISHER_PORT         — default 8096.
 *   PAPER2AGENT_PUBLISHER_HOST         — listen address (IP literal), default 127.0.0.1.
 *   PAPER2AGENT_PUBLISHER_DATA_DIR     — default ./data/paper2agent-publisher.
 *   DOCKER_HOST                        — unix:// socket for docker builds and for the
 *                                        supplier's fixed tool command.
 *
 * Wallet keys stay inside PublisherTarget private fields. They are passed only
 * to the in-process advert builder and to the supplier child's environment.
 */
import { accessSync, closeSync, constants, existsSync, fstatSync, openSync, readSync, statSync } from "node:fs";
import { isIP } from "node:net";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import type { WalletKey } from "@marketplace/shared/tx";
import { deriveSupplierKey } from "../../supplier/src/paper2agent/identity.js";

const TOKEN_RE = /^[\x21-\x7e]{32,}$/;
const PORT_RE = /^[1-9]\d{0,4}$/;
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/;
const TARGET_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;
const POSITIVE_INT_RE = /^[1-9]\d{0,15}$/;
const OUTPUT_REF_RE = /^[0-9a-fA-F]{64}#(?:0|[1-9]\d{0,4})$/;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const MAX_TARGETS_FILE_BYTES = 1024 * 1024;
const MAX_TARGETS = 64;

function isUrl(value: string, protocols: readonly string[]): boolean {
  try {
    return protocols.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

interface TargetEnvRule {
  required: boolean;
  valid: (value: string) => boolean;
  expected: string;
}

/**
 * The only target settings passed through. The publisher sets every other supplier
 * variable itself, including WALLET_HEALTH_INTERVAL_MS=0: a managed slot never runs
 * automatic consolidation spending.
 */
const TARGET_ENV: Record<string, TargetEnvRule> = {
  SUPPLIER_PRIV_KEY_HEX: { required: true, valid: (v) => HEX64_RE.test(v), expected: "64 hex characters" },
  NETWORK_ID: { required: true, valid: (v) => v === "0" || v === "1", expected: '"0" or "1"' },
  OGMIOS_URL: { required: true, valid: (v) => isUrl(v, ["http:", "https:", "ws:", "wss:"]), expected: "an http(s) or ws(s) URL" },
  LIVE_CHAIN: { required: false, valid: (v) => v === "0" || v === "1", expected: '"0" or "1"' },
  INDEXER_URL: { required: false, valid: (v) => isUrl(v, ["http:", "https:"]), expected: "an http(s) URL" },
  VECTOR_ZERO_TIME_MS: { required: false, valid: (v) => POSITIVE_INT_RE.test(v), expected: "a positive integer" },
  ESCROW_REF_UTXO: { required: false, valid: (v) => OUTPUT_REF_RE.test(v), expected: "<64 hex>#<index>" },
  ADVERT_REF_UTXO: { required: false, valid: (v) => OUTPUT_REF_RE.test(v), expected: "<64 hex>#<index>" },
  SUPPLIER_PUB_KEY_HEX: { required: false, valid: (v) => HEX64_RE.test(v), expected: "64 hex characters" },
  SUPPLIER_PKH: { required: false, valid: (v) => /^[0-9a-f]{56}$/.test(v), expected: "56 lowercase hex characters" },
  SUPPLIER_ADDRESS: { required: false, valid: (v) => v.length > 0 && v.length <= 200, expected: "a bech32 address" },
};

/** One operator-configured wallet slot. Secrets are private fields and never serialized. */
export class PublisherTarget {
  readonly networkId: 0 | 1;
  readonly liveChain: boolean;
  readonly ogmiosUrl: string;
  readonly supplierPkh: string;
  readonly depositAddress: string;
  readonly endpointUrl: string;
  readonly #env: Readonly<Record<string, string>>;
  readonly #key: WalletKey;

  constructor(readonly id: string, readonly label: string, env: Record<string, string>, publicUrl: string) {
    this.networkId = env.NETWORK_ID === "1" ? 1 : 0;
    this.liveChain = env.LIVE_CHAIN === "1";
    this.ogmiosUrl = env.OGMIOS_URL;
    this.#key = deriveSupplierKey(env.SUPPLIER_PRIV_KEY_HEX, this.networkId);
    this.supplierPkh = this.#key.pubKeyHash;
    this.depositAddress = this.#key.address;
    this.endpointUrl = `${publicUrl}/tools/${id}`;
    this.#env = Object.freeze({ ...env });
  }

  /** Signing identity for the in-process advert transaction. */
  walletKey(): WalletKey {
    return { ...this.#key };
  }

  /** Trusted chain settings for the supplier child, including its signing key. */
  supplierEnv(): Record<string, string> {
    return { ...this.#env };
  }

  sameWallet(other: PublisherTarget): boolean {
    return this.#key.privateKeyHex.toLowerCase() === other.#key.privateKeyHex.toLowerCase();
  }

  toJSON(): Record<string, unknown> {
    return { id: this.id, label: this.label, network_id: this.networkId, supplier_pkh: this.supplierPkh,
      deposit_address: this.depositAddress, endpoint_url: this.endpointUrl, live_chain: this.liveChain };
  }

  [inspect.custom](): string {
    return `PublisherTarget(${this.id})`;
  }
}

export interface PaperPublisherConfig {
  /** Absolute directory for publisher.db, bundles, runtime build contexts and supplier journals. */
  dataDir: string;
  port: number;
  host: string;
  token: string;
  /** No trailing slash. */
  publicUrl: string;
  /** Exact local base image ID, equal to every accepted artifact.runtime_image. */
  runtimeImage: string;
  /** Absolute docker CLI path: the supplier requires an absolute tool executable. */
  dockerPath: string;
  /** unix:// daemon socket from DOCKER_HOST, or null for the default socket. */
  dockerHost: string | null;
  /** Repository root: the supplier child's working directory, where tsx resolves. */
  repoRoot: string;
  supplierEntry: string;
  targets: PublisherTarget[];
}

function fail(message: string): never {
  throw new Error(`loadPaperPublisherConfig: ${message}`);
}

function publicUrl(value: string | undefined): string {
  let url: URL;
  try {
    url = new URL(value ?? "");
  } catch {
    fail("PAPER2AGENT_PUBLISHER_PUBLIC_URL must be an absolute URL");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!(url.protocol === "https:" || (url.protocol === "http:" && loopback)) ||
      url.username || url.password || url.search || url.hash) {
    fail("PAPER2AGENT_PUBLISHER_PUBLIC_URL must be https (http only for loopback) without credentials, query, or fragment");
  }
  return url.href.replace(/\/+$/, "");
}

/** Read through one checked descriptor: a private regular file of bounded size. */
function readTargetsFile(path: string): unknown {
  if (!isAbsolute(path)) fail("PAPER2AGENT_PUBLISHER_TARGETS_FILE must be an absolute path");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_TARGETS_FILE_BYTES) fail("the targets file must be a regular file of at most 1 MiB");
    if ((stat.mode & 0o077) !== 0) fail("the targets file holds wallet keys and must not be accessible by group or others (chmod 600)");
    const bytes = Buffer.alloc(MAX_TARGETS_FILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > MAX_TARGETS_FILE_BYTES) fail("the targets file exceeds 1 MiB");
    try {
      return JSON.parse(bytes.toString("utf8", 0, length));
    } catch {
      fail("the targets file is not valid JSON");
    }
  } finally {
    closeSync(fd);
  }
}

function targetEnv(id: string, value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`target ${id} env must be an object`);
  const env: Record<string, string> = {};
  for (const [name, setting] of Object.entries(value)) {
    const rule = Object.hasOwn(TARGET_ENV, name) ? TARGET_ENV[name] : undefined;
    // Values never appear in errors: several of them are secrets.
    if (!rule) fail(`target ${id} env ${name} is not a supported supplier chain setting`);
    if (typeof setting !== "string" || !rule.valid(setting)) fail(`target ${id} env ${name} must be ${rule.expected}`);
    env[name] = setting;
  }
  for (const [name, rule] of Object.entries(TARGET_ENV)) {
    if (rule.required && env[name] === undefined) fail(`target ${id} env ${name} is required`);
  }
  return env;
}

function parseTargets(value: unknown, url: string, env: Record<string, string | undefined>): PublisherTarget[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TARGETS) {
    fail(`the targets file must be a JSON array of 1 to ${MAX_TARGETS} targets`);
  }
  const targets: PublisherTarget[] = [];
  for (const entry of value) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) fail("each target must be an object");
    const keys = Object.keys(entry).sort().join(",");
    if (keys !== "env,id,label") fail("each target must have exactly id, label and env");
    const { id, label, env: settings } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !TARGET_ID_RE.test(id)) fail("target id must be 1-32 letters, digits, '-' or '_'");
    if (typeof label !== "string" || label.length === 0 || label.length > 120 || CONTROL_RE.test(label)) {
      fail(`target ${id} label must be 1-120 printable characters`);
    }
    if (targets.some((target) => target.id === id)) fail(`target id ${id} is duplicated`);
    const target = new PublisherTarget(id, label, targetEnv(id, settings), url);
    const supplied = target.supplierEnv();
    const derived = target.walletKey();
    if ((supplied.SUPPLIER_PUB_KEY_HEX !== undefined && supplied.SUPPLIER_PUB_KEY_HEX.toLowerCase() !== derived.pubKeyHex) ||
        (supplied.SUPPLIER_PKH !== undefined && supplied.SUPPLIER_PKH !== derived.pubKeyHash) ||
        (supplied.SUPPLIER_ADDRESS !== undefined && supplied.SUPPLIER_ADDRESS !== derived.address)) {
      fail(`target ${id} supplier identity settings do not match its signing key`);
    }
    if (targets.some((other) => other.sameWallet(target))) fail(`target ${id} reuses another target's wallet; each slot needs its own key`);
    // The shared live advert builder signs Vector mainnet transactions only; read-only slots may use testnet.
    if (target.liveChain && target.networkId !== 1) {
      fail(`live target ${id} requires NETWORK_ID=1: the shared live advert builder supports the Vector mainnet only`);
    }
    // The shared live builder reads this process's VECTOR_ZERO_TIME_MS for advert validity slots, and its
    // default is the testnet genesis. A wrong value would journal an advert that can never confirm.
    if (target.liveChain && (!supplied.VECTOR_ZERO_TIME_MS || supplied.VECTOR_ZERO_TIME_MS !== env.VECTOR_ZERO_TIME_MS)) {
      fail(`live target ${id} needs VECTOR_ZERO_TIME_MS, equal to the publisher process value`);
    }
    targets.push(target);
  }
  return targets;
}

function dockerExecutable(path: string | undefined): string {
  for (const directory of (path ?? "").split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "docker");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  fail("the docker CLI was not found on an absolute PATH entry");
}

function dockerHost(env: Record<string, string | undefined>): string | null {
  const host = env.DOCKER_HOST ?? "";
  if (host !== "") {
    if (!/^unix:\/\/\/[^\0\s]+$/.test(host)) fail("DOCKER_HOST must be a local unix:// socket");
    return host;
  }
  // The supplier's fixed docker command runs without HOME, so a CLI context cannot reach it.
  if ((env.DOCKER_CONTEXT ?? "default") !== "default") fail("DOCKER_CONTEXT is not supported; set DOCKER_HOST to the daemon socket");
  return null;
}

export function loadPaperPublisherConfig(env: Record<string, string | undefined> = process.env): PaperPublisherConfig {
  const portText = env.PAPER2AGENT_PUBLISHER_PORT ?? "";
  let port = 8096;
  if (portText !== "") {
    if (!PORT_RE.test(portText) || Number(portText) > 65535) fail("PAPER2AGENT_PUBLISHER_PORT must be an integer from 1 to 65535");
    port = Number(portText);
  }
  const host = env.PAPER2AGENT_PUBLISHER_HOST || "127.0.0.1";
  if (isIP(host) === 0) fail("PAPER2AGENT_PUBLISHER_HOST must be an IP address literal");
  const runtimeImage = env.PAPER2AGENT_RUNTIME_IMAGE ?? "";
  if (!IMAGE_ID_RE.test(runtimeImage)) fail("PAPER2AGENT_RUNTIME_IMAGE must be an exact local image ID (sha256:<64 hex>)");
  const managementToken = env.PAPER2AGENT_PUBLISHER_TOKEN ?? "";
  if (!TOKEN_RE.test(managementToken)) fail("PAPER2AGENT_PUBLISHER_TOKEN must be at least 32 printable characters without whitespace");
  const url = publicUrl(env.PAPER2AGENT_PUBLISHER_PUBLIC_URL);
  const targetsFile = env.PAPER2AGENT_PUBLISHER_TARGETS_FILE ?? "";
  if (targetsFile === "") fail("PAPER2AGENT_PUBLISHER_TARGETS_FILE is required");
  const targets = parseTargets(readTargetsFile(targetsFile), url, env);
  const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const supplierEntry = join(repoRoot, "supplier", "src", "index.ts");
  if (!existsSync(supplierEntry)) fail(`the supplier entry point ${supplierEntry} is missing`);
  return {
    dataDir: resolve(env.PAPER2AGENT_PUBLISHER_DATA_DIR || "./data/paper2agent-publisher"),
    port,
    host,
    token: managementToken,
    publicUrl: url,
    runtimeImage,
    dockerPath: dockerExecutable(env.PATH),
    dockerHost: dockerHost(env),
    repoRoot,
    supplierEntry,
    targets,
  };
}
