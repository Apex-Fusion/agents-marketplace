#!/usr/bin/env python3
# voice-mappings.py — idempotently apply project-specific voice aliases to
# /app/config/voice_to_speaker.yaml inside the marketplace-tts-piper container.
#
# Why this exists:
#   The openedai-speech-min image populates voice_to_speaker.yaml on first
#   start with its OWN defaults (alloy/echo/fable/onyx/nova/shimmer mapped
#   onto the bundled LibriTTS + northern-english-male voices). Voices we
#   install ourselves (e.g. en_US-lessac-high) need a name in that yaml so
#   the OpenAI-shape `voice` field can resolve to them. This script adds
#   those entries — and only those — without disturbing the defaults.
#
# Idempotency contract:
#   Reads the yaml, compares each desired entry against what's there, only
#   rewrites if at least one entry is missing or stale. Prints "modified"
#   on write, "unchanged" otherwise — install-voice-extras.sh greps for
#   "modified" to decide whether to restart the container.
#
# Run via:
#   docker cp voice-mappings.py marketplace-tts-piper:/tmp/voice-mappings.py
#   docker exec marketplace-tts-piper python3 /tmp/voice-mappings.py

import sys
import yaml

CONFIG_PATH = "/app/config/voice_to_speaker.yaml"

# Mappings to ensure exist under `tts-1`. Adding more voices later is a
# matter of dropping the .onnx + .onnx.json into voices/ (handled by
# install-voice-extras.sh) and adding an entry here.
DESIRED_TTS1 = {
    # en_US-lessac-high — high-quality American female single-speaker voice.
    # Single-speaker model, so no `speaker:` key.
    "lessac": {"model": "voices/en_US-lessac-high.onnx"},
}


def main() -> int:
    with open(CONFIG_PATH) as f:
        cfg = yaml.safe_load(f) or {}

    cfg.setdefault("tts-1", {})

    modified_keys = []
    for name, mapping in DESIRED_TTS1.items():
        if cfg["tts-1"].get(name) != mapping:
            cfg["tts-1"][name] = mapping
            modified_keys.append(name)

    if modified_keys:
        with open(CONFIG_PATH, "w") as f:
            yaml.safe_dump(cfg, f, sort_keys=False)
        print(f"modified — applied: {', '.join(modified_keys)}")
    else:
        print("unchanged — all mappings already present")
    return 0


if __name__ == "__main__":
    sys.exit(main())
