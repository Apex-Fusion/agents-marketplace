/**
 * gateway/src/cli/create-demo-key.ts — mint the shared demo API key.
 *
 * Same custodial machinery as POST /signup, but sets demo=1: withdraw is
 * blocked, /account hides the deposit address, chat completions run through
 * the session-backed demo executor, and per-IP rate limits apply. Public
 * signup can never mint a demo key — this CLI is the only path.
 *
 * Run inside the gateway container (hits the volume-mounted DB):
 *   docker exec <gateway> pnpm --filter @marketplace/gateway create-demo-key
 * Or locally:
 *   GATEWAY_MASTER_KEY=<64hex> GATEWAY_DB_DIR=./data/gateway NETWORK_ID=1 \
 *   pnpm --filter @marketplace/gateway create-demo-key [--label shared-demo]
 *
 * The raw key is printed ONCE and never stored (only its sha256).
 */

import { randomBytes, randomUUID } from "crypto";
import { GatewayStore } from "../db/store.js";
import { genPrivKeyHex, deriveWalletKey } from "../wallet.js";
import { seal } from "../crypto/seal.js";
import { hashApiKey } from "../middleware/apiKeyAuth.js";

const HEX64 = /^[0-9a-fA-F]{64}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const masterKey = process.env.GATEWAY_MASTER_KEY;
  if (!masterKey || !HEX64.test(masterKey)) {
    throw new Error("create-demo-key: GATEWAY_MASTER_KEY must be 64 hex chars");
  }
  const dbDir = arg("db") ?? process.env.GATEWAY_DB_DIR ?? "./data/gateway";
  const networkId: 0 | 1 = process.env.NETWORK_ID === "1" ? 1 : 0;
  const label = arg("label") ?? "shared-demo";

  const privHex = genPrivKeyHex();
  const walletKey = deriveWalletKey(privHex, networkId);
  const sealed = seal(privHex, masterKey);

  const rawKey = `vk_${networkId === 1 ? "live" : "test"}_${randomBytes(24).toString("hex")}`;

  const store = new GatewayStore(dbDir);
  store.insertKey({
    id: randomUUID(),
    key_hash: hashApiKey(rawKey),
    key_prefix: rawKey.slice(0, 12),
    label,
    wallet_pkh: walletKey.pubKeyHash,
    deposit_address: walletKey.address,
    enc_priv_nonce: sealed.nonce,
    enc_priv_ct: sealed.ct,
    enc_priv_tag: sealed.tag,
    master_key_version: 1,
    created_at: Date.now(),
    demo: 1,
  });

  // eslint-disable-next-line no-console
  console.log(
    [
      `[gateway] demo key created (label=${label}, network=${networkId === 1 ? "mainnet" : "testnet"})`,
      ``,
      `  api_key:         ${rawKey}`,
      `  deposit_address: ${walletKey.address}`,
      ``,
      `Save the api_key now — it is shown only once. Fund the deposit address`,
      `with the demo float (withdrawals are disabled for this key).`,
    ].join("\n"),
  );
}

main();
