// The font catalogue.
//
// Vendors' invoices are not all set in Arial. A vendor picks a family during
// onboarding and their template records it; the renderer resolves it at render
// time. Fonts are self-hosted — fetched once with scripts/fetch-fonts.mjs and
// pushed to KV — so nothing is loaded from a third-party CDN at render time and
// a document does not depend on some font service still being up in five years.
//
// THE RULE FOR ADDING ONE: it must contain the Naira glyph U+20A6.
//
// A font without it does not error. pdf-lib embeds it happily and every ₦
// silently vanishes from the document, which nobody notices until an approved
// invoice is already in a WhatsApp group. Liberation Sans is the classic trap:
// metrically Arial-compatible, widely recommended, missing the glyph.
// scripts/fetch-fonts.mjs and scripts/check-fonts.mjs both enforce this, and so
// does the upload route for admin-supplied fonts.
//
// `metricOf` matters for fidelity: a metric-compatible substitute has the same
// character widths as the proprietary face a vendor's stationery was set in, so
// line breaks and page rhythm land where they do on their own document even
// though the letterforms differ.

export const FONT_CATALOGUE = {
  // ── metric-compatible substitutes: the highest-fidelity options ────
  arimo: {
    name: 'Arimo', metricOf: 'Arial, Helvetica', kind: 'sans',
    regular: 'https://github.com/googlefonts/Arimo/raw/main/fonts/ttf/Arimo-Regular.ttf',
    bold:    'https://github.com/googlefonts/Arimo/raw/main/fonts/ttf/Arimo-Bold.ttf',
  },
  tinos: {
    name: 'Tinos', metricOf: 'Times New Roman', kind: 'serif',
    regular: 'https://github.com/googlefonts/Tinos/raw/main/fonts/ttf/Tinos-Regular.ttf',
    bold:    'https://github.com/googlefonts/Tinos/raw/main/fonts/ttf/Tinos-Bold.ttf',
  },
  cousine: {
    name: 'Cousine', metricOf: 'Courier New', kind: 'mono',
    regular: 'https://github.com/googlefonts/Cousine/raw/main/fonts/ttf/Cousine-Regular.ttf',
    bold:    'https://github.com/googlefonts/Cousine/raw/main/fonts/ttf/Cousine-Bold.ttf',
  },
  carlito: {
    name: 'Carlito', metricOf: 'Calibri', kind: 'sans',
    regular: 'https://github.com/google/fonts/raw/main/ofl/carlito/Carlito-Regular.ttf',
    bold:    'https://github.com/google/fonts/raw/main/ofl/carlito/Carlito-Bold.ttf',
  },

  // ── common house faces, for stationery not set in an Office font ───
  //
  // Deliberately short. Caladea (Cambria), PT Sans and PT Serif were all tried
  // and all three lack U+20A6, which is exactly why the catalogue is verified
  // rather than assembled from whatever is popular.
  lato: {
    name: 'Lato', metricOf: null, kind: 'sans',
    regular: 'https://github.com/google/fonts/raw/main/ofl/lato/Lato-Regular.ttf',
    bold:    'https://github.com/google/fonts/raw/main/ofl/lato/Lato-Bold.ttf',
  },
  spectral: {
    name: 'Spectral', metricOf: null, kind: 'serif',
    regular: 'https://github.com/google/fonts/raw/main/ofl/spectral/Spectral-Regular.ttf',
    bold:    'https://github.com/google/fonts/raw/main/ofl/spectral/Spectral-Bold.ttf',
  },
  firasans: {
    name: 'Fira Sans', metricOf: null, kind: 'sans',
    regular: 'https://github.com/google/fonts/raw/main/ofl/firasans/FiraSans-Regular.ttf',
    bold:    'https://github.com/google/fonts/raw/main/ofl/firasans/FiraSans-Bold.ttf',
  },
};

/** KV keys for a font. Fonts are shared across vendors, so no vendor prefix. */
export const fontKeys = (key) => ({
  regular: `fonts/${key}-Regular.ttf`,
  bold:    `fonts/${key}-Bold.ttf`,
});

/** Glyphs the renderer can emit. Missing any of these fails silently at render. */
export const REQUIRED_GLYPHS = [
  ['₦', 0x20a6, 'Naira sign'],
  ['–', 0x2013, 'en dash, used in the subject line'],
  ['-', 0x002d, 'hyphen'],
  ['0', 0x0030, 'digits'],
  ['A', 0x0041, 'basic Latin'],
];

/** The family every deployment must have; anything missing falls back to it. */
export const FALLBACK_FONT = 'arimo';
