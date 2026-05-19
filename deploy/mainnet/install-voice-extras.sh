#!/usr/bin/env bash
# install-voice-extras.sh — runs ON THE HOST (vector-marketplace, as root)
# after `docker compose -f deploy/mainnet/docker-compose.tts-piper.yml up -d`
# to install Piper voices and yaml mappings beyond what the
# openedai-speech-min image ships with.
#
# Idempotent: every step is a no-op if it already finished previously.
# Safe to re-run after a host wipe — a fresh `data/` dir gets the same
# voices back.
#
# Mirrors deploy/simulation/install-voice-extras.sh; differs only in:
#   - CONTAINER name (mainnet-prefixed)
#   - resolves VOICES_DIR + voice-mappings.py relative to deploy/mainnet/
#
# What it does (in order):
#   1. Ensure the bind-mount voice files are present (curl -sSL with `[ -s ]` guard).
#   2. Copy voice-mappings.py into the container and execute it as root.
#      The script edits /app/config/voice_to_speaker.yaml (host bind-mount) to
#      add custom voice aliases. It prints "modified" or "unchanged" — we
#      restart only on the former.
#   3. Restart the container if either step changed something.
#
# Usage:
#   bash deploy/mainnet/install-voice-extras.sh

set -euo pipefail

MAINNET_DIR="$(cd "$(dirname "$0")" && pwd)"
VOICES_DIR="$MAINNET_DIR/data/tts-piper/voices"
CONTAINER="marketplace-mainnet-tts-piper"

mkdir -p "$VOICES_DIR"
changes=0

# --- 1. Voice files to install (filename → URL) ---
# Add entries here when you want another voice baked into the deploy.
# Each .onnx pairs with a .onnx.json — both must be downloaded.
voices=(
  "en_US-lessac-high.onnx|https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx"
  "en_US-lessac-high.onnx.json|https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high/en_US-lessac-high.onnx.json"
)

for entry in "${voices[@]}"; do
  fn="${entry%%|*}"
  url="${entry##*|}"
  if [ -s "$VOICES_DIR/$fn" ]; then
    echo "voice: already installed — $fn"
    continue
  fi
  echo "voice: downloading $fn"
  # `--fail` so HTTP 4xx/5xx aborts (HF returns html on 404 by default).
  # Download to a tmp file then mv, so a partial download from a network
  # blip doesn't leave a half-file that the next run treats as installed.
  tmp="$VOICES_DIR/.${fn}.partial"
  curl -sSL --fail --output "$tmp" "$url"
  mv "$tmp" "$VOICES_DIR/$fn"
  changes=1
done

# --- 2. Yaml mapping additions inside the container ---
docker cp "$MAINNET_DIR/voice-mappings.py" "$CONTAINER:/tmp/voice-mappings.py" >/dev/null
mapping_output="$(docker exec "$CONTAINER" python3 /tmp/voice-mappings.py)"
echo "mapping: $mapping_output"
if [[ "$mapping_output" == modified* ]]; then
  changes=1
fi

# --- 3. Restart only if anything changed ---
if [ "$changes" -eq 1 ]; then
  echo "→ restarting $CONTAINER to pick up new voices/mappings"
  docker restart "$CONTAINER" >/dev/null
else
  echo "✓ voice extras already up to date — no restart needed"
fi
