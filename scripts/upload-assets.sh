#!/usr/bin/env bash
# Upload one vendor's letterhead artwork, plus the shared fonts, to ASSETS_KV.
#
# Artwork is namespaced per vendor (<code>/header.png) because every vendor
# issues on their own letterhead. The vendor code must match vendors.code.
# Fonts are shared and uploaded unprefixed.
#
# Fonts must carry the Naira glyph U+20A6. Liberation Sans does NOT and will
# silently drop every ₦ on the document, so scripts/check-fonts.mjs verifies
# every file before anything is uploaded.
#
# The bundled catalogue is in shared/fonts.js. Fetch it once with
#   node scripts/fetch-fonts.mjs
# which downloads each family and verifies the glyphs before keeping it.
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

# Artwork is whatever the vendor's template names; these are the usual bands.
ART=(header.png footer.png logo.png tagline_services.png tagline_slogan.png)

# Fonts are shared across vendors. Only the sans pair is required — a vendor
# whose template asks for a family that is absent falls back to sans.
#   Arimo   -> Arial / Helvetica     Tinos  -> Times New Roman
#   Cousine -> Courier New
# Fonts live in assets/fonts/ and upload under the fonts/ prefix, shared by
# every vendor. Fetch them with: node scripts/fetch-fonts.mjs

for f in "${ART[@]}"; do
  if [[ ! -f "assets/$CODE/$f" ]]; then
    echo "MISSING assets/$CODE/$f" >&2
    echo "  Run: python scripts/extract-assets.py <vendor-sample.pdf> --out assets/$CODE" >&2
    exit 1
  fi
done

if [[ ! -d assets/fonts ]]; then
  echo "MISSING assets/fonts/ — run: node scripts/fetch-fonts.mjs" >&2
  exit 1
fi

# A font without the Naira glyph does not error, it silently drops every ₦.
echo "checking fonts"
node scripts/check-fonts.mjs || exit 1

for f in "${ART[@]}"; do
  echo "uploading $CODE/$f"
  npx wrangler kv key put "$CODE/$f" --path "assets/$CODE/$f" --binding "$BINDING" "$FLAG"
done

FONTS_UPLOADED=0
for path in assets/fonts/*.ttf; do
  [[ -f "$path" ]] || continue
  f="$(basename "$path")"
  echo "uploading fonts/$f (shared)"
  npx wrangler kv key put "fonts/$f" --path "$path" --binding "$BINDING" "$FLAG"
  FONTS_UPLOADED=$((FONTS_UPLOADED + 1))
done

echo "done — ${#ART[@]} artwork objects for $CODE, $FONTS_UPLOADED shared fonts"
