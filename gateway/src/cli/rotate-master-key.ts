/**
 * gateway/src/cli/rotate-master-key.ts — re-encrypt all custodial keys.
 *
 * Decrypts every api_keys row with the OLD master key and re-encrypts with the
 * NEW one, bumping master_key_version. Run with the gateway stopped.
 *
 *   GATEWAY_DB_DIR=./data/gateway \
 *   pnpm --filter @marketplace/gateway rotate-master-key \
 *     --old <64hex-old> --new <64hex-new>
 */

import { GatewayStore } from "../db/store.js";
import { seal, open as unseal } from "../crypto/seal.js";

const HEX64 = /^[0-9a-fA-F]{64}$/;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const oldKey = arg("old") ?? process.env.GATEWAY_MASTER_KEY_OLD;
  const newKey = arg("new") ?? process.env.GATEWAY_MASTER_KEY;
  const dbDir = arg("db") ?? process.env.GATEWAY_DB_DIR ?? "./data/gateway";

  if (!oldKey || !HEX64.test(oldKey)) throw new Error("rotate: --old must be 64 hex chars");
  if (!newKey || !HEX64.test(newKey)) throw new Error("rotate: --new must be 64 hex chars");
  if (oldKey === newKey) throw new Error("rotate: --old and --new are identical");

  const store = new GatewayStore(dbDir);
  const rows = store.listAllKeys();
  let rotated = 0;
  for (const row of rows) {
    const priv = unseal(
      { nonce: row.enc_priv_nonce, ct: row.enc_priv_ct, tag: row.enc_priv_tag },
      oldKey,
    );
    const sealed = seal(priv, newKey);
    store.updateKeyEncryption(row.id, {
      enc_priv_nonce: sealed.nonce,
      enc_priv_ct: sealed.ct,
      enc_priv_tag: sealed.tag,
      master_key_version: row.master_key_version + 1,
    });
    rotated += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`[gateway] rotated ${rotated} key(s) at ${dbDir}; restart the gateway with the NEW GATEWAY_MASTER_KEY.`);
}

main();
