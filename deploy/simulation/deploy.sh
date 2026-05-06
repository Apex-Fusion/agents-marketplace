#!/usr/bin/env bash
# deploy/simulation/deploy.sh — push the simulation-host stack to apex-simulation.
#
# Mirrors the rsync-only pattern used for apex-dashboard (no git clone on
# the remote — only the files we need actually leave the laptop). Idempotent:
# safe to re-run after editing either compose file.
#
# Usage:
#   bash deploy/simulation/deploy.sh                  # rsync + compose up
#   bash deploy/simulation/deploy.sh --traefik-only   # rsync + (re)start Traefik
#   bash deploy/simulation/deploy.sh --tts-only       # rsync + (re)start TTS
#
# Prereqs on local laptop:
#   - SSH alias `apex-simulation` resolves (see ~/.ssh/config)
#
# Prereqs on remote:
#   - Docker engine + compose plugin
#   - User `deploy` exists, in `docker` group
#   - Run once: `ssh apex-simulation 'docker network create traefik-net'`

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-apex-simulation}"
REMOTE_DIR="${REMOTE_DIR:-/home/deploy/marketplace-simulation}"

cd "$(dirname "$0")/../.."   # repo root

WHAT="${1:-all}"
case "$WHAT" in
  --traefik-only) WHAT=traefik ;;
  --tts-only)     WHAT=tts ;;
  ""|all|--all)   WHAT=all ;;
  *) echo "unknown arg: $WHAT" >&2; exit 1 ;;
esac

echo "→ rsync deploy/simulation/ → $REMOTE_HOST:$REMOTE_DIR/deploy/simulation/"
ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR/deploy/simulation/data/tts-piper/voices $REMOTE_DIR/deploy/simulation/data/tts-piper/config"

# Only the files we need on the host. Excludes data/ so we don't ship the
# voice models from the laptop (they're downloaded on the host on first run).
rsync -avz --delete \
  --exclude='data/' \
  --exclude='*.bak' \
  deploy/simulation/ \
  "$REMOTE_HOST:$REMOTE_DIR/deploy/simulation/"

echo
echo "→ ensure traefik-net exists on remote"
ssh "$REMOTE_HOST" "docker network inspect traefik-net >/dev/null 2>&1 || docker network create traefik-net"

if [ "$WHAT" = "all" ] || [ "$WHAT" = "traefik" ]; then
  echo
  echo "→ traefik up"
  ssh "$REMOTE_HOST" "cd $REMOTE_DIR && docker compose -f deploy/simulation/docker-compose.traefik.yml up -d"
fi

if [ "$WHAT" = "all" ] || [ "$WHAT" = "tts" ]; then
  echo
  echo "→ tts-piper up (force-recreate so env / image changes take effect)"
  ssh "$REMOTE_HOST" "cd $REMOTE_DIR && docker compose -f deploy/simulation/docker-compose.tts-piper.yml up -d --force-recreate"

  # Wait for the container to become healthy before applying voice extras.
  # On a fresh host the bind-mount config dir is empty until openedai-speech-min
  # populates it, which only happens after the server starts answering /v1/models.
  # If we touch /app/config/voice_to_speaker.yaml before then, the file isn't
  # there yet. The healthcheck (`curl /v1/models`) gates that for us.
  echo
  echo "→ waiting for tts-piper to become healthy (start_period up to 90s)"
  ssh "$REMOTE_HOST" "until [ \"\$(docker inspect marketplace-tts-piper --format '{{.State.Health.Status}}')\" = healthy ]; do sleep 5; done"

  # Install extra voices (e.g. en_US-lessac-high) and the yaml aliases for
  # them. Idempotent — does nothing on subsequent runs once everything is
  # in place. Restarts the container only if it actually changed something.
  echo
  echo "→ apply voice extras (idempotent; restarts container if it changed anything)"
  ssh "$REMOTE_HOST" "cd $REMOTE_DIR && bash deploy/simulation/install-voice-extras.sh"
fi

echo
echo "→ container status"
ssh "$REMOTE_HOST" "docker ps --filter name=traefik --filter name=marketplace-tts-piper --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'"
echo
echo "→ tail tts-piper logs (first 20 lines)"
ssh "$REMOTE_HOST" "docker logs --tail 20 marketplace-tts-piper 2>&1 || true"

echo
echo "Done. Test from your laptop once CF DNS is set:"
echo "  curl -s -X POST https://tts-piper.vector.testnet.apexfusion.org/v1/audio/speech \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"model\":\"tts-1\",\"input\":\"Hello.\",\"voice\":\"alloy\",\"response_format\":\"wav\"}' \\"
echo "    -o /tmp/out.wav && aplay /tmp/out.wav"
