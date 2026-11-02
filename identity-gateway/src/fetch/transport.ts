// The real DNS and HTTPS used by the background jobs. The HTTPS transport connects only to the
// address that the fetcher checked: its `lookup` returns that address, so Node does no DNS lookup of
// its own between the check and the connection. TLS verifies the certificate for the host name.

import { promises as dns } from "node:dns";
import { once } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { request } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { Lookup, Transport, TransportResponse } from "./fetcher.js";
import type { TxtLookup } from "./linkage.js";

/** Every address of a host name, in the order of the system resolver. */
export const systemLookup: Lookup = async (hostname) =>
  (await dns.lookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** TXT records through the system's DNS servers, with a 10-second limit and one try. */
export function systemTxtLookup(): TxtLookup {
  const resolver = new dns.Resolver({ timeout: 10_000, tries: 1 });
  return (name) => resolver.resolveTxt(name);
}

function flatHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) flat[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return flat;
}

export const httpsTransport: Transport = async (req): Promise<TransportResponse> => {
  const host = req.url.hostname.startsWith("[") ? req.url.hostname.slice(1, -1) : req.url.hostname;
  // Node calls this instead of DNS; with `all` (Happy Eyeballs) it expects a list.
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: req.address, family: req.family }]);
    else callback(null, req.address, req.family);
  };
  const outgoing = request({
    protocol: "https:",
    host,
    port: req.url.port || 443,
    path: `${req.url.pathname}${req.url.search}`,
    method: req.method,
    headers: { ...req.headers, host: req.url.host },
    servername: isIP(host) ? undefined : host,
    lookup: pinned,
    agent: false,
    signal: req.signal,
  });
  outgoing.end(req.body ?? undefined);
  // `once` rejects when the request emits "error" first.
  const [incoming] = (await once(outgoing, "response")) as [IncomingMessage];
  return {
    status: incoming.statusCode ?? 0,
    headers: flatHeaders(incoming.headers),
    body: incoming,
    close: () => incoming.destroy(),
  };
};
