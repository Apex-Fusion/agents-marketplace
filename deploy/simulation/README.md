# `apex-simulation` host runbook

A second deploy target dedicated to "simulation"-style supplier capabilities
(starting with CPU-only PiperTTS as `audio.synthesize.v1`). Independent of
`apex-dashboard` so heavy local models can come and go without affecting
the marketplace's chain-follower / buyer-app.

## Layout

```
deploy/simulation/
├── docker-compose.traefik.yml      # Standalone Traefik on :80
├── docker-compose.tts-piper.yml    # PiperTTS behind OpenAI-compat shim
├── deploy.sh                       # rsync from laptop → apex-simulation, compose up
└── data/                           # bind-mount target (created on host; gitignored)
    └── tts-piper/{voices,config}/  # downloaded Piper voices persist here
```

## Prereqs

**On the laptop**: SSH alias `apex-simulation` resolving to the new host
(see `~/.ssh/config`). `rsync` available locally.

**On `apex-simulation` (one-shot)**:

```sh
# As root (or via sudo) — create the deploy user:
adduser --disabled-password --gecos "" deploy
usermod -aG docker deploy
sudo -u deploy mkdir -m 700 /home/deploy/.ssh
# Paste your laptop's public key:
sudo -u deploy tee /home/deploy/.ssh/authorized_keys >/dev/null <<'EOF'
ssh-ed25519 AAAA…  your-laptop-key
EOF
sudo -u deploy chmod 600 /home/deploy/.ssh/authorized_keys

# Optional but recommended — disable password SSH:
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl reload sshd
```

## Cloudflare DNS

Add an A record `tts-piper.vector.testnet.apexfusion.org` → apex-simulation
public IP. Orange cloud (proxied) is fine — CF terminates TLS, forwards
HTTP to Traefik on :80.

If CF later flags the path with a 502, mirror the existing
`Skip mp-buyers on testnet` rule for `tts-piper.…` (see
`deploy/CLOUDFLARE_WAF_BYPASS.md`). TTS bodies are short text so this is
unlikely, but the runbook is there if needed.

## Deploy

From the laptop, repo root:

```sh
# First time (and every subsequent change):
bash deploy/simulation/deploy.sh
```

`deploy.sh` does:

1. `mkdir -p` the bind-mount target dirs on the remote.
2. `rsync` only `deploy/simulation/*` to `/home/deploy/marketplace-simulation/deploy/simulation/` on apex-simulation. The voices dir (`data/`) is excluded — Piper downloads voices on first run.
3. `docker network create traefik-net` (idempotent).
4. `docker compose ... up -d` for Traefik then TTS.
5. Print container status + last 20 lines of TTS logs.

Selective re-deploys:

```sh
bash deploy/simulation/deploy.sh --traefik-only
bash deploy/simulation/deploy.sh --tts-only
```

## Voice quality

The compose file defaults to `PRELOAD_MODEL=en_US-lessac-high` — Piper's
highest-quality American-English single-speaker voice (~60 MB). Other
top-tier options:

| Model | Description | Size |
|---|---|---|
| `en_US-lessac-high` | Female, very natural, default | 60 MB |
| `en_GB-alan-high` | British male | 65 MB |
| `en_US-ryan-high` | American male | 60 MB |
| `en_US-libritts_r-medium` | Multi-speaker (904 voices) | 75 MB |

Browse the rest at <https://huggingface.co/rhasspy/piper-voices/tree/main>.
To switch, edit `PRELOAD_MODEL` in `docker-compose.tts-piper.yml`, then:

```sh
bash deploy/simulation/deploy.sh --tts-only
```

## Verify TTS end-to-end

From any laptop that resolves the CF hostname:

```sh
curl -s -X POST https://tts-piper.vector.testnet.apexfusion.org/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tts-1-hd",
    "input": "Hello from the local agents marketplace. PiperTTS, served via openedai-speech, signed via the future bonded escrow.",
    "voice": "alloy",
    "response_format": "wav"
  }' \
  -o /tmp/out.wav

aplay /tmp/out.wav     # or `mpv /tmp/out.wav` / `paplay /tmp/out.wav`
```

The OpenAI shim maps the six standard voice names (`alloy`, `echo`, `fable`,
`onyx`, `nova`, `shimmer`) onto the bundled Piper voices. The `model`
field is informational — Piper has no model picker beyond voice.

## Health probes

```sh
# Traefik (returns 404 with no host = alive)
curl -i http://<server-ip>:80

# TTS service via Traefik
curl -s https://tts-piper.vector.testnet.apexfusion.org/v1/models | jq .
```

## Wiring as a marketplace supplier (later)

Once the audio is sound, this becomes a second supplier deployment:

1. Add a `marketplace-supplier-tts` compose on apex-simulation (clone of
   `deploy/testnet/docker-compose.supplier.yml`, swap `OLLAMA_URL` →
   `http://marketplace-tts-piper:8000`, advertise capability
   `audio.synthesize.v1`).
2. New wallet (`SUPPLIER_PRIV_KEY_HEX`) so the bond is independent of
   the chat supplier.
3. `pnpm tx:post-advert` against this host's wallet to publish the
   capability. The buyer Dashboard then sees two suppliers — one for
   `llm.text.generate.v1`, one for `audio.synthesize.v1`.

Out of scope here — file under a future `UX-supplier-tts` task.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `404` on the CF hostname | Traefik up but no router matches | Container labels missed; `bash deploy.sh --tts-only` |
| `502` on first call | Cold start downloading the Piper voice (30–90 s) | Wait & retry, or pre-warm with a short curl |
| Audio file is 0 bytes | Voice model failed to download (no outbound network from host?) | `ssh apex-simulation 'docker logs marketplace-tts-piper'` — look for huggingface fetch errors |
| Want a different voice | Change `PRELOAD_MODEL` in `docker-compose.tts-piper.yml` | `bash deploy/simulation/deploy.sh --tts-only` |
