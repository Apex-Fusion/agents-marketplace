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
#   4. Suppliers are drained before recreate: /status must report zero active
#      sessions and no working job. A timeout or unreadable status aborts the
#      rollout; deployment must not interrupt a bonded job.
#   5. Every restarted container must report healthy (or plain running when it
#      has no healthcheck) within HEALTH_TIMEOUT_SECS or the deploy fails.
#
# Env knobs:
#   FORCE=1                redeploy even if already at origin/main
#   DRY_RUN=1              print what would be rebuilt/restarted, change nothing
#   DEPLOY_REF=<sha>       deploy an existing commit instead of fetching main
#   DRAIN_TIMEOUT_SECS=N   max wait per busy supplier   (default 600, 0 = check once)
#   HEALTH_TIMEOUT_SECS=N  max wait for healthy         (default 180)
#
# Rollback: copy this script outside the checkout, then run that copy with
# DEPLOY_REF=<old-sha> FORCE=1. This does not fetch or reset back to origin/main.
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
DEPLOY_REF="${DEPLOY_REF:-}"

exec 9>"$LOCK"
flock -n 9 || { echo "another deploy is already running (lock: $LOCK)"; exit 1; }

cd "$REPO"
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
  echo "refusing to overwrite local changes in $REPO"
  exit 1
fi

OLD=$(git rev-parse HEAD)
if [ -z "$DEPLOY_REF" ]; then
  git fetch origin main
  DEPLOY_REF=FETCH_HEAD
fi
NEW=$(git rev-parse --verify --end-of-options "${DEPLOY_REF}^{commit}")

if [ "$OLD" = "$NEW" ] && [ "$FORCE" != "1" ]; then
  echo "already at requested commit ($NEW) — nothing to deploy (FORCE=1 to override)"
  exit 0
fi

echo "deploying $OLD -> $NEW"
if [ "$DRY_RUN" = "1" ]; then
  echo "(dry run — checkout not reset, nothing rebuilt or restarted)"
else
  git reset --hard "$NEW"
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
    docker-compose.surplus-seller.yml) echo "^supplier/|$SHARED_RE" ;;
    docker-compose.supplier*.yml)      echo "^supplier/|$SHARED_RE" ;;
    *)                                 echo "" ;;
  esac
}

# Restart order: infra first, suppliers last (each supplier drains first).
ORDERED_NON_SUPPLIER="docker-compose.indexer.yml docker-compose.buyer.yml docker-compose.gateway.yml docker-compose.wallet-monitor.yml docker-compose.surplus-seller.yml docker-compose.ollama.yml docker-compose.chatmock.yml docker-compose.tts-piper.yml"
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

DRAINING_CID=""
clear_supplier_drain() {
  [ -n "$DRAINING_CID" ] || return 0
  if ! docker exec "$DRAINING_CID" rm -f /dev/shm/marketplace-draining 2>/dev/null; then
    # A stopped container loses its tmpfs marker; a removed container needs
    # no cleanup. Failure on a surviving running container is not success.
    if [ "$(docker inspect -f '{{.State.Running}}' "$DRAINING_CID" 2>/dev/null)" = "true" ]; then
      echo "FAILED: could not clear admission drain on $DRAINING_CID"
      return 1
    fi
  fi
  DRAINING_CID=""
}
finish_deploy() {
  local status=$?
  trap - EXIT
  clear_supplier_drain || status=1
  exit "$status"
}
trap finish_deploy EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

drain_supplier() { # drain_supplier <compose-file>
  local cid deadline status
  cid=$(docker compose -f "$COMPOSE_DIR/$1" ps -q supplier)
  [ -n "$cid" ] || return 0
  # Stop admission before checking activity. tmpfs also clears the marker
  # when a container stops; the exit trap handles failures and unchanged up.
  DRAINING_CID="$cid"
  docker exec "$cid" touch /dev/shm/marketplace-draining
  deadline=$(( $(date +%s) + DRAIN_TIMEOUT_SECS ))
  while :; do
    status=$(docker exec "$cid" node --input-type=module -e '
      try {
        const response = await fetch("http://localhost:8080/status", {
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("status unavailable");
        const state = await response.json();
        const sessions = state.active_sessions;
        if (!Number.isInteger(sessions) || sessions < 0) throw new Error("invalid session count");
        const idle = sessions === 0 && (state.status === "free" || state.status === "offline");
        console.log(idle ? "idle" : "busy");
      } catch {
        console.log("unknown");
      }
    ' 2>/dev/null) || status=unknown
    if [ "$status" = "idle" ]; then
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "   FAILED: supplier remains $status after ${DRAIN_TIMEOUT_SECS}s; leaving it running"
      return 1
    fi
    echo "   supplier $status — waiting for every active session and job to finish..."
    sleep 15
  done
}

# Health state per container name BEFORE the rollout. The gate below exists
# to catch regressions this deploy introduces; a service that was already
# unhealthy (e.g. surplus-seller returns 503 from /healthz while its managed
# offer is paused) must not block the remaining projects — suppliers roll
# last, so aborting there leaves the fleet on the old image.
declare -A PRE_HEALTH
record_pre_health() { # record_pre_health <compose-file>
  local cid name state
  for cid in $(docker compose -f "$COMPOSE_DIR/$1" ps -q); do
    name=$(docker inspect -f '{{.Name}}' "$cid")
    state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")
    PRE_HEALTH["$name"]="$state"
  done
}

wait_healthy() { # wait_healthy <compose-file>
  local deadline cid name state
  deadline=$(( $(date +%s) + HEALTH_TIMEOUT_SECS ))
  for cid in $(docker compose -f "$COMPOSE_DIR/$1" ps -q); do
    name=$(docker inspect -f '{{.Name}}' "$cid")
    while :; do
      state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid")
      case "$state" in
        healthy|running) break ;;
        unhealthy)
          if [ "${PRE_HEALTH[$name]:-}" = "unhealthy" ]; then
            echo "   WARNING: $name is 'unhealthy' but was already unhealthy before this deploy — not a regression, continuing"
            break
          fi
          ;&
        starting|created|restarting)
          if [ "$(date +%s)" -ge "$deadline" ]; then
            echo "   FAILED: $name is '$state' after ${HEALTH_TIMEOUT_SECS}s; last logs:"
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
  record_pre_health "$f"
  case "$f" in docker-compose.supplier*) drain_supplier "$f" ;; esac
  docker compose -f "$COMPOSE_DIR/$f" up -d
  wait_healthy "$f"
  clear_supplier_drain
  echo "   ok"
done

echo "$(date -Is) $OLD -> $NEW (${AFFECTED[*]})" >> "$LOG"
echo "== deploy complete: $NEW =="
echo "rollback: cp $REPO/deploy/mainnet/deploy.sh /run/marketplace-rollback.sh && DEPLOY_REF=$OLD FORCE=1 bash /run/marketplace-rollback.sh"
