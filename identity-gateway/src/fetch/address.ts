// Public unicast addresses (Part 1 Section 9, amplification): a background fetch connects only to
// an address that is globally reachable unicast. The blocks below come from the IANA IPv4 and IPv6
// Special-Purpose Address Registries (RFC 6890), as published at
// https://www.iana.org/assignments/iana-ipv4-special-registry/ and
// https://www.iana.org/assignments/iana-ipv6-special-registry/ (checked 2026-11-02). Anycast blocks
// are refused too: they are not unicast. IPv6 must be global unicast, 2000::/3 (RFC 4291 Section 2.4,
// IANA IPv6 Address Space registry).

import { isIPv4, isIPv6 } from "node:net";

/** [first address, prefix length]. */
type Block = readonly [string, number];

const IPV4_REFUSED: readonly Block[] = [
  ["0.0.0.0", 8], // "this network" (RFC 791)
  ["10.0.0.0", 8], // private use (RFC 1918)
  ["100.64.0.0", 10], // shared address space (RFC 6598)
  ["127.0.0.0", 8], // loopback (RFC 1122)
  ["169.254.0.0", 16], // link local (RFC 3927)
  ["172.16.0.0", 12], // private use (RFC 1918)
  ["192.0.0.0", 24], // IETF protocol assignments (RFC 6890), with the PCP and TURN anycast addresses
  ["192.0.2.0", 24], // documentation, TEST-NET-1 (RFC 5737)
  ["192.31.196.0", 24], // AS112-v4 anycast (RFC 7535)
  ["192.52.193.0", 24], // AMT anycast (RFC 7450)
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast (RFC 7526)
  ["192.168.0.0", 16], // private use (RFC 1918)
  ["192.175.48.0", 24], // direct delegation AS112 anycast (RFC 7534)
  ["198.18.0.0", 15], // benchmarking (RFC 2544)
  ["198.51.100.0", 24], // documentation, TEST-NET-2 (RFC 5737)
  ["203.0.113.0", 24], // documentation, TEST-NET-3 (RFC 5737)
  ["224.0.0.0", 4], // multicast (RFC 5771)
  ["240.0.0.0", 4], // reserved, with the limited broadcast address (RFC 1112, RFC 919)
];

/** Blocks inside 2000::/3 that are not global unicast. */
const IPV6_REFUSED: readonly Block[] = [
  ["2001::", 23], // IETF protocol assignments (RFC 2928): Teredo, benchmarking, ORCHID, AMT and AS112 anycast
  ["2001:db8::", 32], // documentation (RFC 3849)
  ["2002::", 16], // 6to4 (RFC 3056), deprecated; it embeds an IPv4 address
  ["2620:4f:8000::", 48], // direct delegation AS112 anycast (RFC 7534)
  ["3fff::", 20], // documentation (RFC 9637)
  ["5f00::", 16], // segment routing (SRv6) SIDs (RFC 9602)
];

function ipv4Bytes(text: string): number[] | null {
  if (!isIPv4(text)) return null;
  return text.split(".").map(Number);
}

/** The 16 bytes of an IPv6 address in text form (with "::" and an embedded dotted IPv4); null for anything else. */
function ipv6Bytes(text: string): number[] | null {
  if (!isIPv6(text) || text.includes("%")) return null;
  // Write an embedded dotted IPv4 part as two hexadecimal groups; isIPv6 has checked the syntax.
  const lastColon = text.lastIndexOf(":");
  const v4 = ipv4Bytes(text.slice(lastColon + 1));
  const hex = v4 ? `${text.slice(0, lastColon + 1)}${(v4[0]! * 256 + v4[1]!).toString(16)}:${(v4[2]! * 256 + v4[3]!).toString(16)}` : text;
  const [left = "", right] = hex.split("::");
  const leftGroups = left === "" ? [] : left.split(":");
  const rightGroups = right === undefined || right === "" ? [] : right.split(":");
  const zeros = new Array<string>(8 - leftGroups.length - rightGroups.length).fill("0");
  return [...leftGroups, ...zeros, ...rightGroups].flatMap((group) => {
    const value = parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

function inBlock(bytes: readonly number[], block: Block, toBytes: (t: string) => number[] | null): boolean {
  const base = toBytes(block[0])!;
  let bits = block[1];
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i]! & mask) !== (base[i]! & mask)) return false;
  }
  return true;
}

function publicIpv4(bytes: readonly number[]): boolean {
  return !IPV4_REFUSED.some((b) => inBlock(bytes, b, ipv4Bytes));
}

/**
 * True when `address` (an IPv4 or IPv6 address in text form) is a public unicast address. An
 * IPv4-mapped IPv6 address (::ffff:0:0/96) and an address of the well-known NAT64 prefix
 * (64:ff9b::/96, RFC 6052) count as the IPv4 address that they embed.
 */
export function isPublicUnicast(address: string): boolean {
  const v4 = ipv4Bytes(address);
  if (v4) return publicIpv4(v4);
  const v6 = ipv6Bytes(address);
  if (!v6) return false;
  const embedded = v6.slice(12);
  if (v6.slice(0, 10).every((b) => b === 0) && v6[10] === 0xff && v6[11] === 0xff) return publicIpv4(embedded);
  if (inBlock(v6, ["64:ff9b::", 96], ipv6Bytes)) return publicIpv4(embedded);
  if ((v6[0]! & 0xe0) !== 0x20) return false; // not 2000::/3
  return !IPV6_REFUSED.some((b) => inBlock(v6, b, ipv6Bytes));
}
