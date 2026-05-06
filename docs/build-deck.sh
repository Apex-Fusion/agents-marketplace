#!/usr/bin/env bash
# build-deck.sh — render docs/EXECUTIVE_SUMMARY.md to PDF + PPTX with
# inline mermaid diagrams rasterised to PNG (Marp's PDF/PPTX exporters
# don't render mermaid blocks themselves, so we pre-render them with
# mermaid-cli and substitute image references into a copy of the markdown).
#
# Outputs:
#   docs/EXECUTIVE_SUMMARY.pdf
#   docs/EXECUTIVE_SUMMARY.pptx
#   docs/img/diagram-*.png  (intermediate)
#   docs/EXECUTIVE_SUMMARY.rendered.md  (intermediate; mermaid → !(img))

set -euo pipefail
cd "$(dirname "$0")/.."

SRC=docs/EXECUTIVE_SUMMARY.md
TMP=docs/EXECUTIVE_SUMMARY.rendered.md
IMGDIR=docs/img
PDF=docs/EXECUTIVE_SUMMARY.pdf
PPTX=docs/EXECUTIVE_SUMMARY.pptx

mkdir -p "$IMGDIR"
# Clear both .mmd and .png so removing a mermaid block from the source
# also removes its image artifacts (otherwise stale diagrams would linger
# in docs/img/ and might be picked up by an external viewer).
rm -f "$IMGDIR"/diagram-*.mmd "$IMGDIR"/diagram-*.png

# ── 1. Extract each ```mermaid``` block → diagram-NNN.mmd → diagram-NNN.png
node - <<'JS'
const fs = require('fs');
const md = fs.readFileSync('docs/EXECUTIVE_SUMMARY.md', 'utf8');
const re = /```mermaid\n([\s\S]*?)```/g;
let m, n = 0;
const blocks = [];
while ((m = re.exec(md)) !== null) {
  n++;
  const file = `docs/img/diagram-${String(n).padStart(3,'0')}.mmd`;
  fs.writeFileSync(file, m[1]);
  blocks.push({ file, png: file.replace(/\.mmd$/, '.png') });
}
fs.writeFileSync('docs/img/.blocks.json', JSON.stringify(blocks));
console.log(`extracted ${n} mermaid blocks`);
JS

# ── 2. Render each .mmd → .png with mermaid-cli
for f in "$IMGDIR"/diagram-*.mmd; do
  png="${f%.mmd}.png"
  echo "rendering $f → $png"
  npx --yes @mermaid-js/mermaid-cli@latest -i "$f" -o "$png" \
    -t default -b transparent --width 1600 --height 900 --scale 2 \
    --puppeteerConfigFile docs/puppeteer.json
done

# ── 3. Build the rendered markdown — mermaid blocks → image references
node - <<'JS'
const fs = require('fs');
const md = fs.readFileSync('docs/EXECUTIVE_SUMMARY.md', 'utf8');
let n = 0;
const out = md.replace(/```mermaid\n([\s\S]*?)```/g, () => {
  n++;
  const png = `img/diagram-${String(n).padStart(3,'0')}.png`;
  return `![${png}](${png})`;
});
fs.writeFileSync('docs/EXECUTIVE_SUMMARY.rendered.md', out);
console.log(`substituted ${n} blocks`);
JS

# ── 4. Render PDF + PPTX with Marp CLI
echo "→ PDF"
npx --yes @marp-team/marp-cli@latest --pdf --allow-local-files \
  -o "$PDF" "$TMP"

echo "→ PPTX"
npx --yes @marp-team/marp-cli@latest --pptx --allow-local-files \
  -o "$PPTX" "$TMP"

echo "done. ls -la docs/EXECUTIVE_SUMMARY.*"
ls -la docs/EXECUTIVE_SUMMARY.*
