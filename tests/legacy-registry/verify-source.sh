#!/usr/bin/env bash
# Rebuilds three versions of the legacy registry source and compares each
# with the deployed blueprint (fixtures/agent-registry.plutus.json).
#
# This is the only part of the legacy script tests that needs a network:
# it clones Apex-Fusion/vector-ai-agents and aiken downloads
# aiken-lang/stdlib v3.0.0. It needs aiken v1.1.21 and node. It writes
# only to a temporary directory.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deployed="$here/fixtures/agent-registry.plutus.json"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git clone --quiet --filter=blob:none --no-checkout https://github.com/Apex-Fusion/vector-ai-agents.git "$work/repo"

# build <name> <commit> <types.ak> <validation.ak> <registry.ak>
build() {
  local dir="$work/$1"
  mkdir -p "$dir/lib/agent_registry" "$dir/validators"
  git -C "$work/repo" show "$2:$3" > "$dir/lib/agent_registry/types.ak"
  git -C "$work/repo" show "$2:$4" > "$dir/lib/agent_registry/validation.ak"
  git -C "$work/repo" show "$2:$5" > "$dir/validators/registry.ak"
  cat > "$dir/aiken.toml" <<'TOML'
name = "vector/agent-registry"
version = "1.0.0"
compiler = "v1.1.21"
plutus = "v3"
license = "Apache-2.0"

[[dependencies]]
name = "aiken-lang/stdlib"
version = "v3.0.0"
source = "github"
TOML
  (cd "$dir" && aiken build > build.log 2>&1) || { cat "$dir/build.log"; exit 1; }
  node -e '
    const fs = require("node:fs");
    const [built, deployed, name] = process.argv.slice(1);
    const b = JSON.parse(fs.readFileSync(built, "utf8")).validators[0];
    const d = JSON.parse(fs.readFileSync(deployed, "utf8")).validators[0];
    console.log(`${name}: hash ${b.hash}, same bytes as deployed: ${b.compiledCode === d.compiledCode}`);
  ' "$dir/plutus.json" "$deployed" "$1"
}

echo "Expected: only the first build has the deployed bytes (be1a0a29...)."
build "agent-registry-audit/compliant@eb05a62" eb05a62 \
  agent-registry-audit/compliant/agent-registry/types.ak \
  agent-registry-audit/compliant/agent-registry/validation.ak \
  agent-registry-audit/compliant/agent-registry/registry.ak
build "agent-registry/compliant@f6ae4bb" f6ae4bb \
  agent-registry/compliant/contracts/types.ak \
  agent-registry/compliant/contracts/validation.ak \
  agent-registry/compliant/contracts/registry.ak
build "agent-registry/original@f6ae4bb" f6ae4bb \
  agent-registry/original/contracts/agent-registry/lib/agent_registry/types.ak \
  agent-registry/original/contracts/agent-registry/lib/agent_registry/validation.ak \
  agent-registry/original/contracts/agent-registry/validators/registry.ak
