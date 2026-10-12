import { lookup } from "node:dns/promises";
import { request } from "node:https";
import ipaddr from "ipaddr.js";
import { requestDeadline } from "./deadline.js";

export interface PublicDownload {
  bytes: Buffer;
  contentType: string;
  url: string;
}

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === "unicast"; }
  catch { return false; }
}

/** Pin the validated DNS address on every connection, including redirects. */
export async function downloadPublicHttps(
  value: string,
  maxBytes: number,
  signal: AbortSignal,
  allowedHosts?: readonly string[],
  redirects = 0,
): Promise<PublicDownload> {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443") ||
      (allowedHosts && !allowedHosts.includes(url.hostname))) throw new Error("Source URL must use an allowed public HTTPS host");
  if (redirects > 4) throw new Error("Source redirects exceed limit");
  signal.throwIfAborted();
  const addresses = await lookup(url.hostname, { all: true });
  signal.throwIfAborted();
  if (addresses.length === 0 || addresses.some((item) => !isPublicAddress(item.address))) {
    throw new Error("Source URL resolves to a non-public address");
  }
  const result = await new Promise<PublicDownload | URL>((resolve, reject) => {
    const deadline = requestDeadline(60_000, signal);
    const req = request({
      hostname: addresses[0].address,
      family: addresses[0].family,
      servername: url.hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "GET",
      agent: false,
      signal: deadline.signal,
      headers: { Host: url.host, "User-Agent": "Vector-Paper2Agent/1", "Accept-Encoding": "identity" },
    }, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.destroy();
        try { resolve(new URL(res.headers.location, url)); } catch (error) { reject(error); }
        return;
      }
      if (res.statusCode !== 200) {
        res.destroy();
        reject(new Error(`Source fetch failed with HTTP ${res.statusCode ?? "unknown"}`));
        return;
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > maxBytes) {
        res.destroy(); reject(new Error("Source exceeds download limit")); return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) res.destroy(new Error("Source exceeds download limit"));
        else chunks.push(chunk);
      });
      res.on("error", reject);
      res.on("end", () => resolve({ bytes: Buffer.concat(chunks, size),
        contentType: String(res.headers["content-type"] ?? "application/octet-stream"), url: url.href }));
    });
    req.on("error", reject);
    req.once("close", () => deadline.dispose());
    req.end();
  });
  if (result instanceof URL) return downloadPublicHttps(result.href, maxBytes, signal, allowedHosts, redirects + 1);
  return result;
}

export interface WheelMetadata {
  info: { name: string; version: string; requires_dist: string[] | null; requires_python: string | null };
  urls: Array<{ filename: string; url: string; packagetype: string; size: number; digests: { sha256: string } }>;
}

export async function pythonPackageMetadata(name: string, version: string | undefined, signal: AbortSignal): Promise<WheelMetadata> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(name) ||
      (version !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.+!-]{0,80}$/.test(version))) throw new Error("Invalid Python package name or version");
  const path = version === undefined ? name : `${name}/${encodeURIComponent(version)}`;
  const response = await downloadPublicHttps(`https://pypi.org/pypi/${path}/json`, 8 * 1024 * 1024, signal, ["pypi.org"]);
  const metadata = JSON.parse(response.bytes.toString("utf8")) as WheelMetadata;
  if (!metadata.info || !Array.isArray(metadata.urls) || metadata.urls.length > 1000) throw new Error("Invalid Python package metadata");
  return metadata;
}
