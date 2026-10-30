// Multikey encoding of an Ed25519 public key (method spec Section 7): the multicodec header 0xed01
// followed by the 32 key bytes, base58btc-encoded with the multibase prefix "z".

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_PUB_HEADER = [0xed, 0x01];

export function base58btc(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  // Base-58 digits, least significant first.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]!;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j]! << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]!];
  return out;
}

export function ed25519Multikey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error(`Ed25519 public keys are 32 bytes, got ${publicKey.length}`);
  return `z${base58btc(Uint8Array.from([...ED25519_PUB_HEADER, ...publicKey]))}`;
}
