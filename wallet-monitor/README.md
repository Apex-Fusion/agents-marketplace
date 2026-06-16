# wallet-monitor

One-shot wallet-balance Slack alerter for the `vector-marketplace` mainnet box.

Checks every wallet in `wallets.json` against a threshold (default **10 APEX**),
posts a combined Slack message when any wallet is below it, re-reminds every
`reminder_hours` while a wallet stays low, and posts a recovery message when it
climbs back above. Balances are read from Ogmios via
`ReadOnlyOgmiosProvider` (`@marketplace/shared/chain`) — the same client behind
the buyer's `/v1/wallet/balance` and `buyer/scripts/monitor-wallets.ts`.

It is **not** a long-running server: it runs once and exits, invoked hourly by
cron through `docker compose run --rm`. Dedup state lives in
`wallet-monitor/data/state.json` (bind-mounted, gitignored).

## Files

| File | Purpose |
| --- | --- |
| `src/index.ts` | one-shot check + classify + Slack post + state |
| `src/config.ts` | env loading + `wallets.json` parsing/validation |
| `src/slack.ts` | `postSlack()` Incoming-Webhook helper |
| `wallets.json` | the wallet list + thresholds (gitignored; see `wallets.example.json`) |
| `.env` | `SLACK_WEBHOOK_URL` (gitignored; see `.env.example`) |

## Deploy on the box (one-time)

1. **Generate `wallets.json`.** From a laptop with SSH access, run
   `pnpm tsx buyer/scripts/monitor-wallets.ts --json` and copy the `address` of
   each of the 7 `*@vector-marketplace` rows into `wallet-monitor/wallets.json`
   (start from `wallets.example.json`). Per-wallet `min_ap3x` is optional.
2. **Set the webhook.** `cp wallet-monitor/.env.example wallet-monitor/.env` and
   fill in `SLACK_WEBHOOK_URL`.
3. **Build.** `docker compose -f deploy/mainnet/docker-compose.wallet-monitor.yml build`
4. **Smoke-test the webhook.**
   `docker compose -f deploy/mainnet/docker-compose.wallet-monitor.yml run --rm -e TEST=1 wallet-monitor`
   → expect a "✅ wallet-monitor configured" message in Slack.
5. **Schedule it.** Add `/etc/cron.d/wallet-monitor`:
   ```cron
   0 * * * * root cd /root/agents-marketplace && docker compose -f deploy/mainnet/docker-compose.wallet-monitor.yml run --rm wallet-monitor >> /var/log/wallet-monitor.log 2>&1
   ```

## Behaviour notes

- **Failures don't alert.** If Ogmios is unreachable or a wallet query errors,
  the run logs to stderr and exits non-zero — no Slack noise — and that wallet's
  state is left untouched (an Ogmios blip is never mistaken for a recovery).
- **State only advances on a successful post.** A failed Slack POST leaves the
  state file unchanged so the alert retries on the next run.
