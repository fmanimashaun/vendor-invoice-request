# assets/

Not tracked in git. Populate before running the app.

## Letterhead artwork

```bash
pip install pdfplumber pillow
python ../scripts/extract-assets.py path/to/an-existing-invoice.pdf
```

Produces `header.png`, `footer.png`, `logo.png`, `tagline_services.png`,
`tagline_slogan.png`.

## Fonts

Download **Arimo** from https://fonts.google.com/specimen/Arimo (Apache-2.0)
and place here:

- `Arimo-Regular.ttf`
- `Arimo-Bold.ttf`

Arimo carries the Naira sign ₦ (U+20A6) and is metrically compatible with
Arial, which the original template used. **Liberation Sans does not have the
glyph** and will silently drop every ₦ from the PDF.

## Upload to KV

```bash
../scripts/upload-assets.sh --local     # or omit --local for production
```
