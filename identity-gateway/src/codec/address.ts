// Registry addresses (Part 1 Section 4): a record is authentic only at the exact enterprise address
// of its registry, with the script as payment credential and no stake credential. The bech32
// (BIP 173) encoder derives that address from the script hash, so a configured address can be
// checked against its policy ID.

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

function polymod(values: readonly number[]): number {
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GENERATOR[i]!;
  }
  return chk;
}

function toWords(bytes: Uint8Array): number[] {
  const words: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  return words;
}

export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words = toWords(bytes);
  const expanded = [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

/** Mainnet enterprise address of a script: header 0x71 (script payment credential, no stake credential, network 1). */
export function enterpriseScriptAddress(scriptHash: string): string {
  if (!/^[0-9a-f]{56}$/.test(scriptHash)) throw new Error("a script hash is 56 lowercase hex characters");
  return bech32Encode("addr", Uint8Array.from([0x71, ...Buffer.from(scriptHash, "hex")]));
}
