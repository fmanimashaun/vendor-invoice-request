#!/usr/bin/env python3
"""Digitise a vendor's invoice into a reusable template.

Give it one of the vendor's existing invoices. It produces:

  * assets/<code>/*.png   — the letterhead artwork, cut out of the sample
  * assets/<code>/template.json — where that artwork sits, plus the page size,
    colours, type sizes, margins and column positions read off the sample

    pip install pdfplumber pillow

    # Preferred: the vendor's blank letterhead. Nothing on the page is invoice
    # data, so everything on it is safe to keep.
    python scripts/extract-template.py blank.pdf --code acme --blank

    # A blank letterhead has no body text, so it cannot tell you where their
    # margins, columns or type sizes are. Add a populated invoice and those are
    # read from it — none of its text is kept.
    python scripts/extract-template.py blank.pdf --code acme --blank \
        --layout an-old-invoice.pdf

    # Fallback when no blank letterhead is available.
    python scripts/extract-template.py sample.pdf --code acme

Then upload the artwork and the template:

    ./scripts/upload-assets.sh acme --local
    # PUT the template body to /api/vendors/<id>/template

ASK FOR A BLANK LETTERHEAD
-------------------------
With --blank, every image and every word on the page is kept: a blank
letterhead contains no invoice data, so there is nothing to guess about and
nothing that can leak. This is the mode to use.

Without it, the script has to separate stationery from the sample invoice's own
data, and that separation is a guess:

  * every image is kept — that is the letterhead
  * text in the HEADER band is kept as `staticText` — stationery set in type
    rather than artwork, such as a company name or strapline
  * everything else is DISCARDED — that is the old invoice's addressee,
    amounts, dates and bank details, and it must not survive into the template

The header band is the bottom of the artwork cluster at the top of the page.
There is no equally safe rule for the foot: a footer band often starts high up
the page with the invoice's own payment details sitting on top of it, so the
default keeps NOTHING from the bottom. Pass --footer-band once you have looked
at the sample and know where the stationery actually begins.

This is exactly the guesswork --blank removes, which is why a blank letterhead
is worth asking for.

Whatever is kept is printed at the end of the run. Read it: anything there that
belongs to the sample invoice rather than the stationery would be reprinted on
every future document.

WHAT THIS CANNOT DO
-------------------
It cannot tell which body text was a label and which was a value, because with
one sample there is nothing to compare against. It therefore does not try to
reproduce the vendor's body layout literally — it reads their margins, columns,
colours and type sizes, and applies them to this system's own document
structure. Check the first rendered invoice against the sample side by side.

Embedded fonts are not extracted: they are usually subsets and rarely
redistributable. Text is rendered in Arimo, which is metrically compatible with
Arial. If the vendor's sample uses something far from Arial, expect the line
lengths to differ.
"""

import argparse
import io
import json
import sys
from collections import Counter
from pathlib import Path

try:
    import pdfplumber
    from PIL import Image
except ImportError:
    sys.exit('pip install pdfplumber pillow')

ROOT = Path(__file__).resolve().parent.parent


def rgb_hex(c):
    """pdfplumber colours arrive as a float, a 1-tuple, or an RGB/CMYK tuple."""
    if c is None:
        return None
    if isinstance(c, (int, float)):
        v = int(round(float(c) * 255))
        return '#%02x%02x%02x' % (v, v, v)
    c = tuple(c)
    if len(c) == 1:
        v = int(round(float(c[0]) * 255))
        return '#%02x%02x%02x' % (v, v, v)
    if len(c) == 3:
        return '#%02x%02x%02x' % tuple(int(round(float(x) * 255)) for x in c)
    if len(c) == 4:                                  # CMYK
        cy, m, y, k = (float(x) for x in c)
        return '#%02x%02x%02x' % (
            int(round(255 * (1 - cy) * (1 - k))),
            int(round(255 * (1 - m) * (1 - k))),
            int(round(255 * (1 - y) * (1 - k))),
        )
    return None


def save_image(img, page, out_dir, name):
    """Write one embedded image out, applying its soft mask if it has one.

    Reading the image stream alone loses the alpha channel and transparent
    areas come out black, which is why the SMask is applied explicitly.
    """
    try:
        stream = img['stream']
        raw = stream.get_data()
        width, height = int(img['srcsize'][0]), int(img['srcsize'][1])
        cs = stream.attrs.get('ColorSpace')
        mode = 'RGB'
        if hasattr(cs, 'name') and cs.name == 'DeviceGray':
            mode = 'L'
        try:
            pil = Image.frombytes(mode, (width, height), raw)
        except ValueError:
            pil = Image.open(io.BytesIO(raw))
        pil = pil.convert('RGBA')

        smask = stream.attrs.get('SMask')
        if smask is not None:
            try:
                mask_raw = smask.get_data()
                mw, mh = int(smask.attrs['Width']), int(smask.attrs['Height'])
                mask = Image.frombytes('L', (mw, mh), mask_raw).resize(pil.size)
                pil.putalpha(mask)
            except Exception:
                pass

        path = out_dir / f'{name}.png'
        pil.save(path)
        return path
    except Exception as e:                            # noqa: BLE001
        print(f'  ! could not extract {name}: {e}', file=sys.stderr)
        return None


def read_layout(page, header_band, footer_band):
    """Margins, columns, type sizes and ink colour, from a populated invoice.

    Only measurements come back — never any of the text itself.
    """
    pw = float(page.width)
    words = page.extract_words(extra_attrs=['size', 'fontname', 'non_stroking_color'])
    body = [w for w in words if header_band <= float(w['top']) < footer_band]
    if not body:
        return None

    sizes = Counter(round(float(w.get('size') or 0), 1) for w in body if w.get('size'))
    body_size = sizes.most_common(1)[0][0] if sizes else 10.5
    small_size = min((sz for sz, _ in sizes.items() if sz and sz < body_size),
                     default=round(body_size * 0.78, 1))

    colors = Counter(rgb_hex(w.get('non_stroking_color')) for w in body)
    colors.pop(None, None)
    ink = colors.most_common(1)[0][0] if colors else '#1a1a1a'

    left = min(float(w['x0']) for w in body)
    right = max(float(w['x1']) for w in body)
    money = [w for w in body if any(ch.isdigit() for ch in w['text'])
             and float(w['x1']) > left + (right - left) * 0.5]
    col_amount = round(max((float(w['x1']) for w in money), default=right), 1)

    # Which family the sample is set in. Font names in a PDF are usually
    # subset-tagged like 'ABCDEF+TimesNewRomanPSMT', so match on substrings.
    names = Counter(str(w.get('fontname') or '').lower() for w in body)
    joined = ' '.join(names)
    if any(k in joined for k in ('times', 'serif', 'georgia', 'garamond',
                                 'book', 'roman', 'minion', 'cambria')):
        family = 'serif'
    elif any(k in joined for k in ('courier', 'mono', 'consol')):
        family = 'mono'
    else:
        family = 'sans'

    return {'body': body_size, 'small': small_size, 'ink': ink,
            'left': round(left, 1), 'right': round(right, 1),
            'colAmount': col_amount, 'count': len(body), 'family': family}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('pdf')
    ap.add_argument('--code', required=True, help='vendor code; must match vendors.code')
    ap.add_argument('--page', type=int, default=0)
    ap.add_argument('--blank', action='store_true',
                    help='the PDF is a blank letterhead: keep everything on it')
    ap.add_argument('--layout', default=None,
                    help='a populated invoice to read margins, columns and type '
                         'sizes from; none of its text is kept')
    ap.add_argument('--header-band', type=float, default=None,
                    help='points from the top that count as letterhead')
    ap.add_argument('--footer-band', type=float, default=None,
                    help='points from the bottom that count as letterhead')
    args = ap.parse_args()

    out_dir = ROOT / 'assets' / args.code
    out_dir.mkdir(parents=True, exist_ok=True)

    with pdfplumber.open(args.pdf) as pdf:
        page = pdf.pages[args.page]
        pw, ph = float(page.width), float(page.height)

        # ── artwork ───────────────────────────────────────────────────
        artwork = []
        for i, img in enumerate(sorted(page.images, key=lambda m: (m['top'], m['x0']))):
            x0, top = float(img['x0']), float(img['top'])
            bottom = float(img['bottom'])
            w, h = float(img['x1']) - x0, bottom - top
            if w < 8 or h < 4:                       # rules and spacer pixels
                continue
            used = {a['asset'] for a in artwork}
            if top < ph * 0.35 and w > pw * 0.6 and 'header' not in used:
                name = 'header'
            elif bottom > ph * 0.75 and w > pw * 0.5 and 'footer' not in used:
                name = 'footer'
            elif top < ph * 0.35 and 'logo' not in used:
                name = 'logo'
            else:
                # Bands and logos are named once; everything else keeps a
                # positional name. Reusing a name would overwrite the PNG that
                # was already written for it.
                name = f'art{i}'
            if save_image(img, page, out_dir, name):
                artwork.append({'asset': name, 'x': round(x0, 1), 'top': round(top, 1),
                                'w': round(w, 1), 'h': round(h, 1)})

        # Bands: where the letterhead ends and the invoice begins.
        #
        # The header band is the bottom of the artwork cluster at the top of
        # the page, which is reliable.
        #
        # The footer band is NOT the top of the footer image. A footer band
        # often starts high up the page and the invoice's own payment details
        # sit on top of it, so treating everything below the image as
        # stationery captures the sample's bank account and prints it on every
        # future document. There is no safe automatic answer, so the default
        # keeps NOTHING from the bottom of the page; pass --footer-band when
        # you have looked at the sample and know where the stationery starts.
        head_imgs = [a for a in artwork if a['top'] < ph * 0.5]
        header_band = args.header_band if args.header_band is not None else (
            max((a['top'] + a['h'] for a in head_imgs), default=ph * 0.18))
        footer_band = args.footer_band if args.footer_band is not None else ph
        if args.blank:
            # Nothing on a blank letterhead is invoice data, so there is no
            # band to draw and nothing to discard.
            header_band, footer_band = ph, ph

        # ── text ──────────────────────────────────────────────────────
        words = page.extract_words(extra_attrs=['size', 'fontname', 'non_stroking_color'])
        body = [w for w in words if header_band <= float(w['top']) < footer_band]
        static = [w for w in words
                  if float(w['top']) < header_band or float(w['top']) >= footer_band]

        # Geometry: from this page when it is a populated sample, from a second
        # document when this one is blank, and otherwise the built-in defaults.
        geo = read_layout(page, header_band, footer_band) if not args.blank else None
        layout_from = args.pdf
        if args.layout:
            with pdfplumber.open(args.layout) as lay:
                g2 = read_layout(lay.pages[args.page], 0, float(lay.pages[args.page].height))
            if g2:
                geo, layout_from = g2, args.layout
        if geo is None:
            geo = {'body': 10.5, 'small': 8.2, 'ink': '#1a1a1a',
                   'left': 86.4, 'right': round(pw - 62, 1),
                   'colAmount': round(pw - 62, 1), 'count': 0, 'family': 'sans'}
            layout_from = 'defaults'

        body_size, small_size, ink = geo['body'], geo['small'], geo['ink']
        left, right, col_amount = geo['left'], geo['right'], geo['colAmount']

        # Stationery text kept as-is, merged into lines.
        # --blank trusts the operator that this page carries no invoice data.
        # If it plainly does, say so loudly: everything here becomes stationery
        # reprinted on every future document, so a mistaken flag is the one way
        # the vendor's old figures can still leak through.
        if args.blank:
            suspicious = [w['text'] for w in words if any(
                ch in w['text'] for ch in '₦$£€') or (
                sum(c.isdigit() for c in w['text']) >= 4)]
            if len(suspicious) >= 3:
                print(f'  ! WARNING: {len(suspicious)} run(s) on this page look like '
                      'invoice data,', file=sys.stderr)
                print('  !          not stationery — for example: '
                      + ', '.join(repr(t) for t in suspicious[:4]), file=sys.stderr)
                print('  !          Is this really a BLANK letterhead? Everything on it '
                      'will be', file=sys.stderr)
                print('  !          reprinted on every invoice this vendor issues.',
                      file=sys.stderr)

        static_runs = []
        for w in sorted(static, key=lambda m: (round(float(m['top']), 1), float(m['x0']))):
            t = w['text'].strip()
            if not t:
                continue
            size = round(float(w.get('size') or small_size), 1)
            prev = static_runs[-1] if static_runs else None
            if (prev and abs(prev['top'] - round(float(w['top']), 1)) < 1.5
                    and prev['size'] == size
                    and float(w['x0']) - prev['_x1'] < size * 0.9):
                prev['text'] += ' ' + t
                prev['_x1'] = float(w['x1'])
                continue
            static_runs.append({
                'text': t,
                'x': round(float(w['x0']), 1),
                'top': round(float(w['top']), 1),
                'size': size,
                'color': rgb_hex(w.get('non_stroking_color')) or ink,
                'bold': 'bold' in str(w.get('fontname', '')).lower(),
                '_x1': float(w['x1']),
            })
        for r in static_runs:
            r.pop('_x1', None)

        template = {
            'version': 1,
            'page': {'w': round(pw, 2), 'h': round(ph, 2)},
            'colors': {'ink': ink, 'soft': '#6b6b6b', 'rule': '#c7c7c7'},
            'type': {'body': body_size, 'small': small_size,
                     'subject': round(body_size * 1.1, 1),
                     'family': geo.get('family', 'sans')},
            'margins': {'left': round(left, 1), 'right': round(right, 1)},
            'artwork': artwork,
            'staticText': static_runs,
            'table': {
                'colDesc': round(left, 1),
                'colExtra': round(left + (col_amount - left) * 0.55, 1),
                'colAmount': col_amount,
                'headGap': 14, 'ruleGap': 12, 'rowH': round(body_size * 1.6, 1),
                'ruleWidth': 0.6,
            },
            'head': {'top': round(header_band + body_size * 1.6, 1),
                     'rowGap': round(body_size * 1.5, 1),
                     'subjectGap': round(body_size * 4.2, 1),
                     'afterSubject': round(body_size * 3.8, 1)},
        }

    path = out_dir / 'template.json'
    path.write_text(json.dumps(template, indent=2), encoding='utf-8')

    mode = 'blank letterhead' if args.blank else 'populated sample'
    print(f'{len(artwork)} artwork file(s) and {len(static_runs)} stationery text run(s)  [{mode}]')
    print(f'  layout read from: {layout_from}')
    print(f'  page   {template["page"]["w"]} x {template["page"]["h"]}')
    print(f'  bands  header 0-{header_band:.0f}pt, footer {footer_band:.0f}-{ph:.0f}pt')
    print(f'  body   {body_size}pt {ink} {geo.get("family", "sans")}, margins '
          f'{template["margins"]["left"]}-{template["margins"]["right"]}')
    print(f'  wrote  {path.relative_to(ROOT)}')
    if args.blank:
        print('\n  Blank letterhead: everything on the page was kept, because none')
        print('  of it is invoice data.')
    else:
        print(f'\n  {len(body)} body text run(s) discarded — that is the sample')
        print("  invoice's own data, and keeping it would bake it into every")
        print('  future document.')
    if static_runs:
        print('\n  Kept as stationery — CHECK none of this is the sample\'s own data:')
        for r in static_runs:
            print(f'    {r["top"]:>6.1f}pt  {r["text"][:64]}')
    print(f'\nNext:  ./scripts/upload-assets.sh {args.code}')
    print(f'       PUT {{"template": <contents of template.json>}} to /api/vendors/<id>/template')


if __name__ == '__main__':
    main()
