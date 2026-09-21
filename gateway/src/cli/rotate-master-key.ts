import {
  GatewayStore,
  type ResponseEncryptionUpdate,
  type SessionEncryptionUpdate,
} from "../db/store.js";
import { seal, open as unseal } from "../crypto/seal.js";

const HEX64 = /^[0-9a-fA-F]{64}$/;

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function main(): void {
  const oldKey = arg("old") ?? process.env.GATEWAY_MASTER_KEY_OLD;
  const newKey = arg("new") ?? process.env.GATEWAY_MASTER_KEY;
  const dbDir = arg("db") ?? process.env.GATEWAY_DB_DIR ?? "./data/gateway";
  if (!oldKey || !HEX64.test(oldKey)) throw new Error("rotate: --old must be 64 hex chars");
  if (!newKey || !HEX64.test(newKey)) throw new Error("rotate: --new must be 64 hex chars");
  if (oldKey === newKey) throw new Error("rotate: --old and --new are identical");

  const store = new GatewayStore(dbDir);
  // Decrypt and reseal every value before the transaction starts. A wrong old
  // key or damaged row therefore leaves the whole database unchanged.
  const keyUpdates = store.listAllKeys().map((row) => {
    const plaintext = unseal(
      { nonce: row.enc_priv_nonce, ct: row.enc_priv_ct, tag: row.enc_priv_tag },
      oldKey,
    );
    const encrypted = seal(plaintext, newKey);
    return {
      id: row.id,
      enc_priv_nonce: encrypted.nonce,
      enc_priv_ct: encrypted.ct,
      enc_priv_tag: encrypted.tag,
      master_key_version: row.master_key_version + 1,
    };
  });
  const responseUpdates: ResponseEncryptionUpdate[] = store.listStoredResponses().map((row) => {
    const input = unseal({ nonce: row.input_nonce, ct: row.input_ct, tag: row.input_tag }, oldKey);
    const encryptedInput = seal(input, newKey);
    if (row.response_nonce === null || row.response_ct === null || row.response_tag === null) {
      if (row.response_nonce !== null || row.response_ct !== null || row.response_tag !== null) {
        throw new Error(`rotate: response ${row.id} has incomplete response encryption fields`);
      }
      return {
        id: row.id,
        input_nonce: encryptedInput.nonce,
        input_ct: encryptedInput.ct,
        input_tag: encryptedInput.tag,
        response_nonce: null,
        response_ct: null,
        response_tag: null,
      };
    }
    const response = unseal({ nonce: row.response_nonce, ct: row.response_ct, tag: row.response_tag }, oldKey);
    const encryptedResponse = seal(response, newKey);
    return {
      id: row.id,
      input_nonce: encryptedInput.nonce,
      input_ct: encryptedInput.ct,
      input_tag: encryptedInput.tag,
      response_nonce: encryptedResponse.nonce,
      response_ct: encryptedResponse.ct,
      response_tag: encryptedResponse.tag,
    };
  });
  const sessionUpdates: SessionEncryptionUpdate[] = store.listEncryptedSessions().map((row) => {
    if (!row.transcript_nonce || !row.transcript_ct || !row.transcript_tag) {
      throw new Error(`rotate: active session ${row.id} has incomplete transcript encryption fields`);
    }
    const transcript = unseal({
      nonce: row.transcript_nonce,
      ct: row.transcript_ct,
      tag: row.transcript_tag,
    }, oldKey);
    const encryptedTranscript = seal(transcript, newKey);
    return {
      id: row.id,
      transcript_nonce: encryptedTranscript.nonce,
      transcript_ct: encryptedTranscript.ct,
      transcript_tag: encryptedTranscript.tag,
    };
  });

  store.rotateEncryption(keyUpdates, responseUpdates, sessionUpdates);
  console.log(
    `[gateway] rotated ${keyUpdates.length} key(s), ${responseUpdates.length} stored response(s), and ` +
    `${sessionUpdates.length} active session transcript(s) at ${dbDir}; ` +
    "restart the gateway with the NEW GATEWAY_MASTER_KEY.",
  );
}

main();
