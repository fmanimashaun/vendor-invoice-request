// Invoice layout templates.
//
// A template is a digitised replica of one vendor's invoice: their page size,
// their artwork and where it sits, their colours, type sizes, margins, column
// positions and vertical rhythm. The renderer is a pure interpreter of this —
// no vendor's geometry is compiled in.
//
// What a template does NOT change is the document's *structure*: letterhead,
// addressee and ref, subject, narrative, line-item table, totals, payment
// instructions, signature. Those sections and their order are the contract the
// rest of the system relies on — the duplicate guards, the numbering, the
// approver attribution. A template decides how that document looks, not what
// it says.
//
// Everything is in PDF points from the TOP of the page, because that is how
// PDF extraction tools report positions and how a designer reads a page.
// renderInvoice flips to PDF's bottom-left origin once, in one place.
//
// Omitted keys fall back to DEFAULT_TEMPLATE, so a partial template is valid
// and a vendor with no template at all renders the built-in layout.

export const DEFAULT_TEMPLATE = {
  version: 1,

  page: { w: 595.28, h: 841.89 },          // A4

  colors: {
    ink:  '#1a1a1a',
    soft: '#6b6b6b',
    rule: '#c7c7c7',
  },

  type: {
    body:    10.5,
    small:    8.2,
    subject: 11.5,
    // A font key: either one bundled in shared/fonts.js, or one an admin
    // uploaded. Falls back to Arimo when the files are not in KV, because a
    // document in the wrong face beats no document at all.
    family: 'arimo',
  },

  margins: { left: 86.4, right: 533.28 },

  // Letterhead images. `asset` is the KV key under the vendor's prefix, minus
  // the .png. Drawn in order, so later entries sit on top.
  artwork: [
    { asset: 'header',           x: 0,     top: 0,      w: 594.7, h: 245.3 },
    { asset: 'footer',           x: 112.7, top: 588.9,  w: 482.5, h: 260.9 },
    { asset: 'logo',             x: 140.6, top: 56.9,   w: 207.7, h: 69.2 },
    { asset: 'tagline_services', x: 91.2,  top: 199.9,  w: 369.3, h: 10.2 },
    { asset: 'tagline_slogan',   x: 191.1, top: 220.3,  w: 169.6, h: 12.3 },
  ],

  // Letterhead text that is part of the vendor's stationery rather than the
  // invoice: a company name set in type, a strapline, a footer address. The
  // extractor keeps text found in the header and footer bands and discards
  // everything between them, which is how a blank letterhead is synthesised
  // from a populated sample — the images and the stationery text survive, the
  // previous invoice's figures do not.
  staticText: [],

  // The vendor's contact block, drawn as live text rather than a raster: in
  // the original source it was an image running off the page edge, which
  // clipped the address.
  contact: { top: 58, lineGap: 11.5 },

  head: {
    top:        262,   // 'To:' / 'Ref:' row
    rowGap:      16,   // to the location / date row
    subjectGap:  44,   // to the centred subject line
    afterSubject: 40,
  },

  body: {
    salutationGap: 24,
    thanksGap:     24,
    lineGap:       15,
    afterNarrative: 20,
  },

  table: {
    colDesc:   86.4,
    colExtra:  300,
    colAmount: 533.28,
    headGap:    14,   // header row to the rule
    ruleGap:    12,   // rule to the first item
    rowH:       17,
    ruleWidth:   0.6,
  },

  totals: {
    beforeRule:  4,
    afterRule:  12,
    rowH:       15,
    beforeTotal:16,
    after:      32,
  },

  payment: {
    labelGap: 16,
    introGap: 20,
    rowH:     15,
    gapAfter: 26,
  },

  sign: {
    thanksGap: 30,
    nameGap:   15,
    lineGap:   14,
  },
};

/** '#1a1a1a' -> [0.102, 0.102, 0.102]. Accepts an [r,g,b] array unchanged. */
export function hexRgb(v) {
  if (Array.isArray(v)) return v;
  const h = String(v).replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
}

/**
 * Merge a vendor template over the default, one level into each section.
 *
 * Deliberately shallow-per-section rather than deeply recursive: a template is
 * a flat set of numbers grouped by area, and a deep merge would make it
 * possible to half-specify `artwork` in a way that silently produces a page
 * with someone else's letterhead on it. `artwork` is replaced wholesale or not
 * at all.
 */
export function mergeTemplate(custom) {
  if (!custom || typeof custom !== 'object') return DEFAULT_TEMPLATE;
  const out = { ...DEFAULT_TEMPLATE };
  for (const [k, v] of Object.entries(custom)) {
    if (v === null || v === undefined) continue;
    if (k === 'artwork' || k === 'staticText') {
      if (Array.isArray(v)) out[k] = v;
      continue;
    }
    out[k] = (v && typeof v === 'object' && !Array.isArray(v))
      ? { ...DEFAULT_TEMPLATE[k], ...v }
      : v;
  }
  return out;
}

/**
 * Reject a template that would render an unusable document.
 *
 * Returns an array of problems; empty means usable. This runs when a template
 * is uploaded rather than at render time — a vendor finding out their layout
 * is broken at the moment they approve something is far too late.
 */
export function validateTemplate(t) {
  const errs = [];
  if (!t || typeof t !== 'object') return ['Template must be an object.'];

  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const page = { ...DEFAULT_TEMPLATE.page, ...(t.page || {}) };
  if (!num(page.w) || !num(page.h) || page.w <= 0 || page.h <= 0) {
    errs.push('page.w and page.h must be positive numbers.');
  }

  const m = { ...DEFAULT_TEMPLATE.margins, ...(t.margins || {}) };
  if (!num(m.left) || !num(m.right)) errs.push('margins.left and margins.right must be numbers.');
  else if (m.right <= m.left) errs.push('margins.right must be greater than margins.left.');
  else if (m.right > page.w) errs.push('margins.right is off the right edge of the page.');

  const tbl = { ...DEFAULT_TEMPLATE.table, ...(t.table || {}) };
  for (const k of ['colDesc', 'colExtra', 'colAmount']) {
    if (!num(tbl[k])) errs.push(`table.${k} must be a number.`);
  }
  if (num(tbl.colDesc) && num(tbl.colExtra) && tbl.colExtra <= tbl.colDesc) {
    errs.push('table.colExtra must sit to the right of table.colDesc.');
  }
  if (num(tbl.colAmount) && tbl.colAmount > page.w) {
    errs.push('table.colAmount is off the right edge of the page.');
  }
  if (num(tbl.rowH) && tbl.rowH <= 0) errs.push('table.rowH must be positive.');

  if (t.artwork !== undefined) {
    if (!Array.isArray(t.artwork)) errs.push('artwork must be an array.');
    else t.artwork.forEach((a, i) => {
      if (!a || typeof a.asset !== 'string' || !/^[a-z0-9_]+$/.test(a.asset)) {
        errs.push(`artwork[${i}].asset must be a lowercase key like "header".`);
      }
      for (const k of ['x', 'top', 'w', 'h']) {
        if (!num(a?.[k])) errs.push(`artwork[${i}].${k} must be a number.`);
      }
      // Off-page artwork is the failure that produced a clipped address in the
      // original source document, so it is caught here rather than shipped.
      // A few points of bleed past the edge is ordinary print design, though,
      // and rejecting that would reject most real letterheads: the original
      // bug ran 123pt off a 1109pt page, which is 11%. Allow 5%.
      const bleedX = page.w * 0.05;
      const bleedY = page.h * 0.05;
      if (num(a?.x) && num(a?.w) && a.x + a.w > page.w + bleedX) {
        errs.push(`artwork[${i}] ("${a.asset}") runs ${Math.round(a.x + a.w - page.w)}pt off the right edge.`);
      }
      if (num(a?.top) && num(a?.h) && a.top + a.h > page.h + bleedY) {
        errs.push(`artwork[${i}] ("${a.asset}") runs ${Math.round(a.top + a.h - page.h)}pt off the bottom.`);
      }
    });
  }

  // Only the shape is checked here; whether the family actually exists is a
  // database question and is answered by the route that stores the template.
  const fam = t.type?.family;
  if (fam !== undefined && !/^[a-z0-9][a-z0-9-]{1,30}$/.test(String(fam))) {
    errs.push('type.family must be a lowercase font key like "arimo".');
  }

  if (t.staticText !== undefined) {
    if (!Array.isArray(t.staticText)) errs.push('staticText must be an array.');
    else t.staticText.forEach((r, i) => {
      if (typeof r?.text !== 'string' || !r.text.length) {
        errs.push(`staticText[${i}].text must be a non-empty string.`);
      }
      for (const k of ['x', 'top']) {
        if (!num(r?.[k])) errs.push(`staticText[${i}].${k} must be a number.`);
      }
      if (r?.size !== undefined && (!num(r.size) || r.size <= 0)) {
        errs.push(`staticText[${i}].size must be a positive number.`);
      }
      if (r?.align !== undefined && !['left', 'right', 'center'].includes(r.align)) {
        errs.push(`staticText[${i}].align must be left, right or center.`);
      }
    });
  }

  for (const [sec, keys] of [['colors', ['ink', 'soft', 'rule']]]) {
    for (const k of keys) {
      const v = t[sec]?.[k];
      if (v !== undefined && !Array.isArray(v) && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(v))) {
        errs.push(`${sec}.${k} must be a hex colour like "#1a1a1a".`);
      }
    }
  }

  return errs;
}
