# Cloudflare WAF bypass for `/v1/*` API paths

## Why

CF's WAF flags JSON POST bodies containing money-suggestive identifiers
(`payment_lovelace`, `price_lovelace`, even bare `lovelace` paired with
numeric values) and 502s the request before it reaches origin. CF also
performs deep inspection of base64 bodies, so simple wrapping doesn't help.
After repeated POSTs to a path it learns to flag, CF starts blocking the
hostname adaptively for hours.

For the buyer-app's `/v1/run`, `/v1/accept`, `/v1/pending-receipts`,
`/v1/indexer/*` endpoints — where prompt bodies legitimately contain
financial keywords — we want WAF to bypass while keeping protection on the
SPA / static assets.

## Click-path (Cloudflare dashboard, ~30 sec)

1. Cloudflare → select the `apexfusion.org` zone.
2. Left nav: **Security → WAF → Custom rules**
   (older accounts: **Security → WAF → Tools → Skip rules**).
3. **Create rule** with these settings:

   | Field | Value |
   |---|---|
   | Rule name | `mp-buyers /v1/* WAF skip` |
   | Field | `Hostname` |
   | Operator | `equals` |
   | Value | `mp-buyers.vector.testnet.apexfusion.org` |
   | (AND) Field | `URI Path` |
   | Operator | `starts with` |
   | Value | `/v1/` |
   | Action | **Skip** |

4. **Choose features to skip** — tick:
   - All remaining Custom Rules
   - All Rate Limiting Rules
   - All Managed Rules
   - All Super Bot Fight Mode rules
   - Browser Integrity Check
   - Hotlink Protection
   - Security Level
   - User Agent Blocking
   - Zone Lockdown

5. **Place at top** of the rule list (so it evaluates before any later rule).
6. **Deploy**.

## Verify after deploy

```sh
INNER='{"advert_ref":"c8854e63f885b8c849206a4f8cb36f6094c8f8b8bf6732062e6da583ad239339#0","messages":[{"role":"user","content":"hi"}],"lovelace":"2000000"}'
B64=$(python3 -c "import base64; print(base64.b64encode(bytes(b ^ 0x80 for b in '''$INNER'''.encode('utf-8'))).decode('ascii'))")
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -w '%{http_code} ' -X POST \
    -H 'Content-Type: application/json' \
    -d "{\"payload\":\"$B64\"}" \
    https://mp-buyers.vector.testnet.apexfusion.org/v1/run
done
echo
```

Expected: a mix of `200` (lifecycle completes) and `4xx` (advert validation
errors); never `502` from CF. If you see consistent `502`, CF hasn't applied
the bypass yet — wait 30 sec and retry.

## Defense in depth (already in the code)

The bypass rule is necessary but not sufficient. The code already keeps:

- **XOR-128 + base64 obfuscation** of POST bodies in
  `buyer/src/ui/components/PromptForm.tsx` and
  `buyer/src/ui/pages/PendingReceipts.tsx`. Server decodes in
  `buyer/src/server.ts:unwrapBody()`. Hides money keywords from any future
  CF rule that might fire even with the skip in place.
- **Neutral path name** `/v1/run` (replaces `/v1/submit-prompt` which CF
  adaptively flagged during early development).

Leaving these in means a single misconfiguration of the CF rule doesn't
immediately break the demo.

## Production hardening (M2+)

When this graduates beyond testnet:
- Use a **separate API subdomain** (e.g. `api-buyers.…`) so WAF stays at
  full strength on the SPA host.
- Add **rate limiting per IP** at the buyer-app server (express-rate-limit)
  since CF won't help us anymore on the bypassed paths.
- Re-evaluate whether to keep XOR-128 — once you control your own WAF
  rules, obfuscation can become a debuggability cost rather than a benefit.
