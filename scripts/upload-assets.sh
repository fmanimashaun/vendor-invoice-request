#!/usr/bin/env bash
# Upload one vendor's letterhead artwork, plus the shared fonts, to ASSETS_KV.
#
# Artwork is namespaced per vendor (<code>/header.png) because every vendor
# issues on their own letterhead. The vendor code must match vendors.code.
# Fonts are shared and uploaded unprefixed.
#
# Arimo matters: it has the Naira glyph U+20A6 and is metrically compatible with
# Arial, which is what the source template used. Liberation Sans does NOT have
# the glyph and will silently drop every ₦ on the document.
#
#   Get it from https://fonts.google.com/specimen/Arimo (Apache-2.0, bundling is fine)
#   and put Arimo-Regular.ttf + Arimo-Bold.ttf in assets/.
#
#   ./scripts/upload-assets.sh acme            # remote
#   ./scripts/upload-assets.sh acme --local    # local dev
#
# Artwork is read from assets/<code>/, fonts from assets/.

set -euo pipefail

CODE="${1:-}"
FLAG="${2:---remote}"
BINDING="ASSETS_KV"

if [[ -z "$CODE" || "$CODE" == --* ]]; then
  echo "usage: $0 <vendor-code> [--local]" >&2
  exit 1
fi

ART=(header.png footer.png logo.png tagline_services.png tagline_slogan.png)
FONTS=(Arimo-Regular.ttf Arimo-Bold.ttf)

for f in "${ART[@]}"; do
  if [[ ! -f "assets/$CODE/$f" ]]; then
    echo "MISSING assets/$CODE/$f" >&2
    echo "  Run: python scripts/extract-assets.py <vendor-sample.pdf> --out assets/$CODE" >&2
    exit 1
  fi
done

for f in "${FONTS[@]}"; do
  if [[ ! -f "assets/$f" ]]; then
    echo "MISSING assets/$f" >&2
    echo "  Download Arimo from Google Fonts (see header of this script)." >&2
    exit 1
  fi
done

for f in "${ART[@]}"; do
  echo "uploading $CODE/$f"
  npx wrangler kv key put "$CODE/$f" --path "assets/$CODE/$f" --binding "$BINDING" "$FLAG"
done

for f in "${FONTS[@]}"; do
  echo "uploading $f (shared)"
  npx wrangler kv key put "$f" --path "assets/$f" --binding "$BINDING" "$FLAG"
done

echo "done — ${#ART[@]} artwork objects for $CODE, ${#FONTS[@]} shared fonts"
