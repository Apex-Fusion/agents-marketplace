import { describe, expect, test } from "vitest";
import { isPublicUnicast } from "../../src/fetch/address.js";

describe("public unicast addresses (Part 1 Section 9)", () => {
  test.each([
    "93.184.216.34",
    "1.1.1.1",
    "8.8.8.8",
    "91.98.147.172",
    "2606:4700:4700::1111",
    "2a01:4f8:c17:1234::1",
    "2001:4860:4860::8888",
    "::ffff:93.184.216.34",
    "64:ff9b::808:808",
  ])("%s is public", (address) => {
    expect(isPublicUnicast(address)).toBe(true);
  });

  test.each([
    ["this network", "0.0.0.0"],
    ["private 10/8", "10.1.2.3"],
    ["shared address space", "100.64.0.1"],
    ["loopback", "127.0.0.1"],
    ["link local (cloud metadata)", "169.254.169.254"],
    ["private 172.16/12", "172.31.255.255"],
    ["IETF protocol assignments", "192.0.0.9"],
    ["TEST-NET-1", "192.0.2.1"],
    ["AS112 anycast", "192.31.196.1"],
    ["6to4 relay anycast", "192.88.99.1"],
    ["private 192.168/16", "192.168.1.1"],
    ["benchmarking", "198.19.0.1"],
    ["TEST-NET-2", "198.51.100.7"],
    ["TEST-NET-3", "203.0.113.9"],
    ["multicast", "224.0.0.1"],
    ["reserved", "240.0.0.1"],
    ["broadcast", "255.255.255.255"],
    ["IPv6 unspecified", "::"],
    ["IPv6 loopback", "::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped private", "::ffff:10.0.0.1"],
    ["NAT64 of a private address", "64:ff9b::a00:1"],
    ["NAT64 local use", "64:ff9b:1::1"],
    ["discard", "100::1"],
    ["Teredo", "2001::1"],
    ["documentation", "2001:db8::1"],
    ["6to4", "2002:a00:1::1"],
    ["documentation 3fff::/20", "3fff::1"],
    ["SRv6", "5f00::1"],
    ["unique local", "fd12:3456::1"],
    ["link local", "fe80::1"],
    ["link local with a zone", "fe80::1%eth0"],
    ["multicast", "ff02::1"],
    ["IPv4-compatible", "::1.2.3.4"],
    ["not an address", "example.org"],
    ["empty", ""],
  ])("%s (%s) is refused", (_name, address) => {
    expect(isPublicUnicast(address)).toBe(false);
  });
});
