# assets/

Not tracked in git — everything here is either a vendor's own property or a
font binary. Populate it before running the app.

## Fonts (shared by every vendor)

```bash
node scripts/fetch-fonts.mjs
```

Downloads the catalogue in `shared/fonts.js` into `fonts/` and verifies each
face carries the glyphs an invoice needs. A font without ₦ (U+20A6) does not
fail at render — it silently drops the symbol — so nothing is kept that cannot
be checked.

## Letterhead artwork (one directory per vendor)

```
assets/<vendor-code>/header.png
                    footer.png
                    logo.png
                    tagline_services.png
                    tagline_slogan.png
                    template.json
```

Ask the vendor for a blank letterhead and one old invoice, then:

```bash
pip install pdfplumber pillow
python scripts/extract-template.py blank.pdf --code acme --blank --layout old-invoice.pdf
```

The blank supplies the stationery safely — nothing on it is invoice data. The
old invoice supplies the layout; only measurements are taken from it, never
text.

## Uploading

```bash
./scripts/upload-assets.sh acme          # artwork for one vendor + shared fonts
./scripts/upload-assets.sh acme --local  # local dev
```

Then paste `template.json` into the vendor's layout panel in the app and use
**Preview** before saving. The specimen is stamped and cannot be mistaken for a
real invoice.
