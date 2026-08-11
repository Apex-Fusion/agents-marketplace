#!/usr/bin/env bash
# deploy/mainnet/deploy.sh — pull-based CD for the vector-marketplace host.
#
# Runs ON the server (root@vector-marketplace, repo at /root/agents-marketplace).
# Invoked by .github/workflows/deploy-mainnet.yml over SSH, but safe to run by
# hand: `bash deploy/mainnet/deploy.sh`.
#
# What it does:
#   1. Fetches origin/main and hard-resets the checkout to it.
#   2. Diffs old..new to work out which compose projects actually need a
#      rebuild (gateway vs suppliers vs buyer vs indexer ...). Changes under
#      packages/, patches/, contracts/ or the root manifests rebuild everything,
#      because every Dockerfile COPYs those into its build context.
#   3. Builds affected images first (all 17 supplier projects share one
#      Dockerfile/context, so build #2..#17 are layer-cache hits), THEN does a
#      rolling `up -d` so the downtime window is restart-only, not build+restart.
#   4. Suppliers are drained before recreate: /status is polled until the
#      supplier is not "working" (a busy supplier killed mid-job forfeits its
#      escrow bond). After DRAIN_TIMEOUT_SECS we recreate anyway, so a wedged
#      supplier cannot block the deploy forever.
#   5. Every restarted container must report healthy (or plain running when it
#      has no healthcheck) within HEALTH_TIMEOUT_SECS or the deploy fails.
#
# Env knobs:
#   FORCE=1                redeploy even if already at origin/main
#   DRY_RUN=1              print what would be rebuilt/restarted, change nothing
#   DRAIN_TIMEOUT_SECS=N   max wait per busy supplier   (default 600, 0 = skip)
#   HEALTH_TIMEOUT_SECS=N  max wait for healthy         (default 180)
#
# Rollback: git reset --hard <old-sha> && FORCE=1 bash deploy/mainnet/deploy.sh
# (old sha is printed below and appended to /var/log/marketplace-deploy.log).

set -euo pipefail

REPO=/root/agents-marketplace
COMPOSE_DIR="$REPO/deploy/mainnet"
LOCK=/run/marketplace-deploy.lock
LOG=/var/log/marketplace-deploy.log
DRAIN_TIMEOUT_SECS="${DRAIN_TIMEOUT_SECS:-600}"
HEALTH_TIMEOUT_SECS="${HEALTH_TIMEOUT_SECS:-180}"
FORCE="${FORCE:-0}"
DRY_RUN="${DRY_RUN:-0}"

exec 9>"$LOCK"
flock -n 9 || { echo "another deploy is already running (lock: $LOCK)"; exit 1; }

cd "$REPO"

OLD=$(git rev-parse HEAD)
git fetch origin main
NEW=$(git rev-parse FETCH_HEAD)

if [ "$OLD" = "$NEW" ] && [ "$FORCE" != "1" ]; then
  echo "already at origin/main ($NEW) — nothing to deploy (FORCE=1 to override)"
  exit 0
fi

echo "deploying $OLD -> $NEW"
if [ "$DRY_RUN" = "1" ]; then
  echo "(dry run — checkout not reset, nothing rebuilt or restarted)"
else
  git reset --hard FETCH_HEAD
fi

CHANGED=$(git diff --name-only "$OLD" "$NEW" || true)
[ "$FORCE" = "1" ] && [ -z "$CHANGED" ] && CHANGED="(forced)"

# Paths COPY'd into every image's build context (see */Dockerfile).
SHARED_RE='^(packages/|patches/|contracts/|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$|tsconfig\.base\.json$|\.npmrc$)'

changed_matches() { # changed_matches <ere> -> 0 if any changed path matches
  [ "$FORCE" = "1" ] && return 0
  echo "$CHANGED" | grep -qE "$1"
}

# Compose project -> the source prefixes that require rebuilding its image.
# Image-only projects (ollama, chatmock, tts-piper) redeploy only when their
# own compose file changes.
project_re() {
  case "$1" in
    docker-compose.indexer.yml)        echo "^indexer/|^indexer-ui/|$SHARED_RE" ;;
    docker-compose.buyer.yml)          echo "^buyer/|$SHARED_RE" ;;
    docker-compose.gateway.yml)        echo "^gateway/|$SHARED_RE" ;;
    docker-compose.wallet-monitor.yml) echo "^wallet-monitor/|$SHARED_RE" ;;
    docker-compose.supplier*.yml)      echo "^supplier/|$SHARED_RE" ;;
    *)                                 echo "" ;;
  esac
}

# Restart order: infra first, suppliers last (each supplier drains first).
ORDERED_NON_SUPPLIER="docker-compose.indexer.yml docker-compose.buyer.yml docker-compose.gateway.yml docker-compose.wallet-monitor.yml docker-compose.ollama.yml docker-compose.chatmock.yml docker-compose.tts-piper.yml"
SUPPLIERS=$(cd "$COMPOSE_DIR" && ls docker-compose.supplier*.yml)

AFFECTED=()
for f in $ORDERED_NON_SUPPLIER $SUPPLIERS; do
  [ -f "$COMPOSE_DIR/$f" ] || continue
  re=$(project_re "$f")
  hit=0
  [ -n "$re" ] && changed_matches "$re" && hit=1
  changed_matches "^deploy/mainnet/$f\$" && hit=1
  [ "$hit" = "1" ] || continue
  if [ -z "$(docker compose -f "$COMPOSE_DIR/$f" ps -q 2>/dev/null)" ]; then
    echo "skip $f — affected but no running containers on this host"
    continue
  fi
  AFFECTED+=("$f")
done

if [ "${#AFFECTED[@]}" -eq 0 ]; then
  echo "no running compose project is affected by $OLD..$NEW — done"
  echo "$(date -Is) $OLD -> $NEW (no services affected)" >> "$LOG"
  exit 0
fi

echo "affected projects: ${AFFECTED[*]}"

if [ "$DRY_RUN" = "1" ]; then
  echo "(dry run — stopping before build/rollout)"
  exit 0
fi

echo "== build phase =="
for f in "${AFFECTED[@]}"; do
  echo "-- building $f"
  docker compose -f "$COMPOSE_DIR/$f" build
done

drain_supplier() { # drain_supplier <compose-file>
  [ "$DRAIN_TIMEOUT_SECS" = "0" ] && return 0
  local cid deadline status
  cid=$(docker compose -f "$COMPOSE_DIR/$1" ps -q | head -1)
  [ -n "$cid" ] || return 0
  deadline=$(( $(date +%s) + DRAIN_TIMEOUT_SECS ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    status=$(docker exec "$cid" wget -qO- http://localhost:8080/status 2>/dev/null \
      | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4 || true)
    if [ "$status" != "working" ]; then
      return 0
    fi
    echo "   supplier busy (status=working) — waiting for job to finish..."
    sleep 15
  done
  echo "   WARNING: still busy after ${DRAIN_TIMEOUT_SECS}s — recreating anyway"
}

wait_healthy() { # wait_healthy <compose-file>
  local deadline cid state
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
  for cid in $(docker compose -f "$COMPOSE_DIR/$1" ps -q); do
    while :; do
      state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")
      case "$state" in
        healthy|running) break ;;
        starting|unhealthy|created|restarting)
          if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "   FAILED: $(docker inspect -f '{{.Name}}' "$cid") is '$state' after ${HEALTH_TIMEOUT_SECS}s; last logs:"
            docker logs --tail 50 "$cid" 2>&1 | sed 's/^/   | /'
            return 1
          fi
          sleep 5 ;;
        *) echo "   FAILED: container state '$state'"; docker logs --tail 50 "$cid" 2>&1 | sed 's/^/   | /'; return 1 ;;
      esac
    done
  done
}

echo "== rollout phase =="
for f in "${AFFECTED[@]}"; do
  echo "-- rolling out $f"
  case "$f" in docker-compose.supplier*) drain_supplier "$f" ;; esac
  docker compose -f "$COMPOSE_DIR/$f" up -d
  wait_healthy "$f"
  echo "   ok"
done

echo "$(date -Is) $OLD -> $NEW (${AFFECTED[*]})" >> "$LOG"
echo "== deploy complete: $NEW =="
echo "rollback: cd $REPO && git reset --hard $OLD && FORCE=1 bash deploy/mainnet/deploy.sh"
