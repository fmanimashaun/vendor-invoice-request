#!/usr/bin/env python3
"""Extract a vendor's letterhead artwork from a source PDF into assets/<code>/.

The source templates were Google Docs exports where the letterhead is a set of
raster images with soft masks for transparency. Reading the image stream alone
loses the alpha channel and the transparent areas come out black, so the SMask
has to be applied explicitly.

    pip install pdfplumber pillow
    python scripts/extract-assets.py path/to/source.pdf

Also worth knowing: in the source, the contact-address image is placed from
x=858 to x=1232 on a 1109pt-wide page, so it runs 123pt off the edge and the
address is clipped. The renderer draws that block as live text instead; this
script still extracts it so the text can be transcribed and checked.
"""

import io
import sys
from pathlib import Path

import pdfplumber
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / 'assets'

# Keyed by (x0, top) in source points.
NAMES = {
    (0, 0): 'header',
    (210, 1097): 'footer',
    (262, 106): 'logo',
    (170, 373): 'tagline_services',
    (356, 407): 'tagline_slogan',
    (858, 110): 'contact_address',
    (860, 140): 'contact_phone',
    (860, 169): 'contact_email',
    (859, 197): 'contact_website',
}


def to_image(stream):
    data = stream.get_data()
    w, h = stream.attrs['Width'], stream.attrs['Height']
    try:
        return Image.open(io.BytesIO(data))
    except Exception:
        pass
    if len(data) == w * h:
        return Image.frombytes('L', (w, h), data)
    if len(data) == w * h * 3:
        return Image.frombytes('RGB', (w, h), data)
    raise ValueError(f'unexpected {len(data)} bytes for {w}x{h}')


def main(pdf_path):
    OUT.mkdir(parents=True, exist_ok=True)
    with pdfplumber.open(pdf_path) as pdf:
        page = pdf.pages[0]
        print(f'page {page.width:.0f} x {page.height:.0f} pt')

        for img in page.images:
            key = (round(img['x0']), round(img['top']))
            name = NAMES.get(key)
            overflow = img['x1'] - page.width
            note = f'  <- runs {overflow:.0f}pt off the page' if overflow > 0.5 else ''
            print(f"  x0={key[0]:>5} top={key[1]:>5} "
                  f"{img['stream'].attrs['Width']}x{img['stream'].attrs['Height']}px "
                  f"{name or '(icon, skipped)'}{note}")

            if not name:
                continue

            base = to_image(img['stream']).convert('RGB')
            smask = img['stream'].attrs.get('SMask')
            if smask is not None:
                mask = to_image(smask.resolve() if hasattr(smask, 'resolve') else smask).convert('L')
                if mask.size != base.size:
                    mask = mask.resize(base.size, Image.LANCZOS)
                base.putalpha(mask)

            path = OUT / f'{name}.png'
            base.save(path, optimize=True)
            print(f'        -> {path.name}  {path.stat().st_size // 1024} KB')


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
