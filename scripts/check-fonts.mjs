// Verify every font in assets/ can actually render this document.
//
//   node scripts/check-fonts.mjs
//
// The failure this exists to prevent is silent. A font without the Naira glyph
// U+20A6 does not error when pdf-lib embeds it — every ₦ simply disappears
// from the invoice, and nobody notices until an approved document is already
// in a WhatsApp group. Liberation Sans is the classic example: metrically
// Arial-compatible, widely recommended, and missing the glyph.
//
// upload-assets.sh runs this before it uploads anything.

import fontkit from '@pdf-lib/fontkit';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_FAMILIES } from '../shared/template.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = process.env.ASSET_DIR || join(ROOT, 'assets');

// Everything the renderer can put on a page. Naira is the one that bites, but
// a font missing basic punctuation would be just as invisible.
const REQUIRED = [
  ['₦', 0x20a6, 'Naira sign'],
  ['–', 0x2013, 'en dash, used in the subject line'],
  ['-', 0x002d, 'hyphen'],
  ['0', 0x0030, 'digits'],
  ['A', 0x0041, 'basic Latin'],
];

let checked = 0;
let failed = 0;
let missing = 0;

for (const [family, spec] of Object.entries(FONT_FAMILIES)) {
  for (const [style, file] of [['regular', spec.regular], ['bold', spec.bold]]) {
    const path = join(ASSETS, file);
    if (!existsSync(path)) {
      // Only sans is required: the others are optional and fall back to it.
      if (family === 'sans') {
        console.error(`MISSING  ${file}  (${family} ${style}) — required`);
        missing++;
      } else {
        console.log(`skipped  ${file}  (${family} ${style}) — not present, will fall back to sans`);
      }
      continue;
    }

    let font;
    try {
      font = fontkit.create(readFileSync(path));
    } catch (e) {
      console.error(`BAD      ${file} — not a readable font: ${e.message}`);
      failed++;
      continue;
    }
    if (font.fonts) {
      console.error(`BAD      ${file} — is a font collection; supply a single face`);
      failed++;
      continue;
    }

    const gaps = REQUIRED.filter(([, cp]) => !font.hasGlyphForCodePoint(cp));
    checked++;
    if (gaps.length) {
      failed++;
      console.error(`FAIL     ${file}  (${family} ${style}, metric-compatible with ${spec.metricOf})`);
      for (const [ch, cp, what] of gaps) {
        console.error(`           missing ${ch}  U+${cp.toString(16).toUpperCase().padStart(4, '0')}  ${what}`);
      }
    } else {
      console.log(`ok       ${file}  (${family} ${style} -> ${spec.metricOf})`);
    }
  }
}

console.log(`\n${checked} font file(s) checked, ${failed} unusable, ${missing} required file(s) absent`);
if (failed || missing) {
  console.error('\nDo not upload. A font missing these glyphs drops them from every');
  console.error('invoice without raising an error.');
  process.exit(1);
}
