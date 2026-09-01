// Download the bundled font catalogue into assets/fonts/, verifying each one.
//
//   node scripts/fetch-fonts.mjs
//   node scripts/fetch-fonts.mjs --force      # re-download files already present
//
// Fonts are self-hosted: fetched once here, pushed to KV by upload-assets.sh,
// and served from there. Nothing is loaded from a font CDN at render time.
//
// Every file is checked for the glyphs the renderer can emit before it is kept.
// A font without U+20A6 does not error at render — it silently drops every ₦ —
// so one that fails is deleted rather than left on disk to be uploaded later by
// accident.

import fontkit from '@pdf-lib/fontkit';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FONT_CATALOGUE, REQUIRED_GLYPHS, FALLBACK_FONT } from '../shared/fonts.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(process.env.ASSET_DIR || join(ROOT, 'assets'), 'fonts');
const force = process.argv.includes('--force');

mkdirSync(OUT, { recursive: true });

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 4096) throw new Error(`suspiciously small (${buf.length} bytes)`);
  return buf;
}

function verify(bytes) {
  const font = fontkit.create(Buffer.from(bytes));
  if (font.fonts) return ['is a font collection, not a single face'];
  return REQUIRED_GLYPHS
    .filter(([, cp]) => !font.hasGlyphForCodePoint(cp))
    .map(([ch, cp, what]) => `missing ${ch} U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${what})`);
}

let ok = 0;
let failed = 0;
const problems = [];

for (const [key, spec] of Object.entries(FONT_CATALOGUE)) {
  const styles = [['Regular', spec.regular], ['Bold', spec.bold]];
  const written = [];
  let bad = null;

  for (const [style, url] of styles) {
    const path = join(OUT, `${key}-${style}.ttf`);
    if (!force && existsSync(path) && statSync(path).size > 4096) {
      written.push(path);
      continue;
    }
    try {
      const bytes = await download(url);
      const gaps = verify(bytes);
      if (gaps.length) {
        bad = `${style}: ${gaps.join('; ')}`;
        break;
      }
      writeFileSync(path, bytes);
      written.push(path);
    } catch (e) {
      bad = `${style}: ${e.message}`;
      break;
    }
  }

  if (bad) {
    // Never leave half a family on disk: a Regular with no Bold would upload
    // and then fall back mid-document.
    for (const p of written) { try { unlinkSync(p); } catch { /* already gone */ } }
    failed++;
    problems.push(`  ${key.padEnd(10)} ${spec.name} — ${bad}`);
    console.log(`skip  ${key.padEnd(10)} ${bad}`);
  } else {
    ok++;
    const metric = spec.metricOf ? `metric-compatible with ${spec.metricOf}` : spec.kind;
    console.log(`ok    ${key.padEnd(10)} ${spec.name.padEnd(12)} ${metric}`);
  }
}

console.log(`\n${ok} font famil${ok === 1 ? 'y' : 'ies'} available, ${failed} unavailable`);
if (problems.length) {
  console.log('\nNot bundled:');
  for (const p of problems) console.log(p);
  console.log('\nA family listed here is simply unavailable — the rest still work,');
  console.log('and an admin can upload any font the catalogue does not cover.');
}

if (!existsSync(join(OUT, `${FALLBACK_FONT}-Regular.ttf`))) {
  console.error(`\n${FALLBACK_FONT} is the fallback every other family relies on `
    + 'and it could not be fetched. Fix that before deploying.');
  process.exit(1);
}
