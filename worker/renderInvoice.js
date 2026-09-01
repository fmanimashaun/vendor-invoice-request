// renderInvoice.js — payment request PDF, rendered on the issuing vendor's letterhead.
// Pure function: invoice data + assets -> PDF bytes. Runs in a Cloudflare Worker
// or in Node. No filesystem access, no globals.
//
//   const bytes = await renderInvoice(invoice, assets);
//
// `assets` holds the letterhead artwork and font bytes as Uint8Array, loaded by
// the caller (KV in the Worker, fs in Node).

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { invoiceRef, naira } from '../shared/reference.js';

// A4 at 72dpi. The source Google Docs template was 1109x1583pt — ~1.87x A4 and
// not a standard size. Everything below is the source geometry multiplied by K.
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const K = PAGE_W / 1109;

const INK       = rgb(0.1, 0.1, 0.1);
const INK_SOFT  = rgb(0.42, 0.42, 0.42);
const RULE      = rgb(0.78, 0.78, 0.78);

const MARGIN_L  = 86.4;                  // x=161 in source
const MARGIN_R  = PAGE_W - 62;
const BODY      = 10.5;                  // source 20pt x K
const SMALL     = 8.2;

// Column x-positions for the line-item table.
const COL_DESC   = MARGIN_L;
const COL_EXTRA  = 300;
const COL_AMOUNT = MARGIN_R;             // right-aligned


function fmtDate(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${
    ['January','February','March','April','May','June','July',
     'August','September','October','November','December'][d.getUTCMonth()]
  } ${d.getUTCFullYear()}`;
}

export async function renderInvoice(inv, assets) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const regular = await pdf.embedFont(assets.fontRegular, { subset: true });
  const bold    = await pdf.embedFont(assets.fontBold,    { subset: true });

  const page = pdf.addPage([PAGE_W, PAGE_H]);

  // pdf-lib origin is bottom-left; source geometry is top-down.
  // T() takes a top offset already in A4 points (used for all body text).
  const T = (top) => PAGE_H - top;
  // ART() takes a top offset in *source template* points and scales it.
  // Both axes must be scaled — scaling only x and the dimensions drops the
  // footer off the page and slides the taglines into the body.
  const ART = (topSrc) => PAGE_H - topSrc * K;
  const text = (s, x, top, { font = regular, size = BODY, color = INK } = {}) =>
    page.drawText(String(s), { x, y: T(top) - size, size, font, color });
  const textRight = (s, xRight, top, { font = regular, size = BODY, color = INK } = {}) =>
    page.drawText(String(s), {
      x: xRight - font.widthOfTextAtSize(String(s), size),
      y: T(top) - size, size, font, color,
    });
  const textCenter = (s, top, { font = bold, size = BODY, color = INK } = {}) =>
    page.drawText(String(s), {
      x: (PAGE_W - font.widthOfTextAtSize(String(s), size)) / 2,
      y: T(top) - size, size, font, color,
    });

  // ── Letterhead artwork ──────────────────────────────────────────────
  // Only reached for an issued invoice. Never render these for a requester
  // preview — see the letterhead invariant in DESIGN.md §1.
  const headerImg = await pdf.embedPng(assets.header);
  page.drawImage(headerImg, { x: 0, y: ART(457), width: 1108 * K, height: 457 * K });

  const footerImg = await pdf.embedPng(assets.footer);
  page.drawImage(footerImg, { x: 210 * K, y: ART(1583), width: 899 * K, height: 486 * K });

  const logoImg = await pdf.embedPng(assets.logo);
  page.drawImage(logoImg, { x: 262 * K, y: ART(235), width: 387 * K, height: 129 * K });

  const tagServices = await pdf.embedPng(assets.taglineServices);
  page.drawImage(tagServices, { x: 170 * K, y: ART(392), width: 688 * K, height: 19 * K });

  const tagSlogan = await pdf.embedPng(assets.taglineSlogan);
  page.drawImage(tagSlogan, { x: 356 * K, y: ART(430), width: 316 * K, height: 23 * K });

  // ── Contact block: live text, not the source raster ─────────────────
  // In the source PDF this was an image running from x=858 to x=1232 on a
  // 1109pt page — 123pt off the edge, so the address was clipped.
  let cy = 58;
  for (const line of assets.contact) {
    textRight(line, MARGIN_R, cy, { size: SMALL, color: INK_SOFT });
    cy += 11.5;
  }

  // ── Addressee / ref ─────────────────────────────────────────────────
  const ref = invoiceRef(inv);
  let y = 262;

  text('To: ', MARGIN_L, y, { font: bold });
  text(inv.addressee, MARGIN_L + bold.widthOfTextAtSize('To: ', BODY), y, { font: bold });
  textRight(`Ref: ${ref}`, MARGIN_R, y, { font: bold });
  y += 16;

  text(inv.addressee_loc, MARGIN_L, y);
  textRight(`Date: ${fmtDate(inv.issued_at)}`, MARGIN_R, y);
  y += 44;

  // ── Subject ─────────────────────────────────────────────────────────
  textCenter(`Request for Payment – ${inv.subject}`, y, { size: 11.5 });
  y += 40;

  // ── Salutation and narrative ────────────────────────────────────────
  // Copied onto the invoice at issue, like everything else on the document.
  text(`Dear ${inv.client_name || 'Sir/Madam'},`, MARGIN_L, y);
  y += 24;
  text('We appreciate your continued partnership and support.', MARGIN_L, y);
  y += 24;
  for (const line of wrap(inv.narrative, regular, BODY, MARGIN_R - MARGIN_L)) {
    text(line, MARGIN_L, y);
    y += 15;
  }
  y += 20;

  // ── Line items ──────────────────────────────────────────────────────
  const extraCol = inv.extra_column_label || null;

  text('Description of Item', COL_DESC, y, { font: bold });
  if (extraCol) text(extraCol, COL_EXTRA, y, { font: bold });
  textRight('Amount', COL_AMOUNT, y, { font: bold });
  y += 14;
  page.drawLine({ start: { x: MARGIN_L, y: T(y) }, end: { x: MARGIN_R, y: T(y) }, thickness: 0.6, color: RULE });
  y += 12;

  for (const line of inv.lines) {                       // 1..n rows (D14)
    text(line.description, COL_DESC, y);
    if (extraCol) text(line.extra || '', COL_EXTRA, y);
    textRight(naira(line.amount_kobo), COL_AMOUNT, y);
    y += 17;
  }

  y += 4;
  page.drawLine({ start: { x: COL_EXTRA, y: T(y) }, end: { x: MARGIN_R, y: T(y) }, thickness: 0.6, color: RULE });
  y += 12;

  // Three explicit figures. The source template said "credit ₦75,000 to the
  // account below [₦100 for processing fee]" and AP transfers ₦75,000.
  text('Bill amount', COL_EXTRA, y);
  textRight(naira(inv.amount_kobo), COL_AMOUNT, y);
  y += 15;
  text('Processing fee', COL_EXTRA, y);
  textRight(naira(inv.fee_kobo), COL_AMOUNT, y);
  // VAT only prints when the vendor is configured for it, so a vendor with no
  // VAT registration produces exactly the document it did before.
  if (inv.vat_kobo) {
    y += 15;
    text('VAT', COL_EXTRA, y);
    textRight(naira(inv.vat_kobo), COL_AMOUNT, y);
  }
  y += 16;
  text('Total to transfer', COL_EXTRA, y, { font: bold });
  textRight(naira(inv.total_kobo), COL_AMOUNT, y, { font: bold });

  // Withholding reduces what the vendor receives but NOT what is transferred
  // against this invoice, so it sits below the total and is labelled as a
  // deduction rather than folded into a single figure.
  if (inv.wht_kobo) {
    y += 15;
    text('Less withholding tax', COL_EXTRA, y);
    textRight(`-${naira(inv.wht_kobo)}`, COL_AMOUNT, y);
    y += 15;
    text('Net to vendor after WHT', COL_EXTRA, y);
    textRight(naira(inv.total_kobo - inv.wht_kobo), COL_AMOUNT, y);
  }
  y += 32;

  // ── Payment instructions ────────────────────────────────────────────
  text('Payment Instructions:', MARGIN_L, y, { font: bold });
  y += 16;
  text(`Kindly credit ${naira(inv.total_kobo)} to the account below:`, MARGIN_L, y);
  y += 20;

  const bankRows = [
    ['Account Name:',   inv.bank_account_name],
    ['Account Number:', inv.bank_account_number],
    ['Bank Name:',      inv.bank_name],
  ];
  // Derive the value column from the widest label rather than hardcoding an
  // offset, or a longer label collides with its value.
  const valueX = MARGIN_L + Math.max(
    ...bankRows.map(([l]) => bold.widthOfTextAtSize(l, BODY)),
  ) + 8;
  for (const [label, value] of bankRows) {
    text(label, MARGIN_L, y, { font: bold });
    text(value, valueX, y);
    y += 15;
  }
  y += 26;

  text('Thank you once again for your business.', MARGIN_L, y);
  y += 30;
  text('Warm Regards,', MARGIN_L, y);
  y += 15;
  // The approver's own details, copied onto the row at issue, so the document
  // names the person who actually approved it. Falls back to the config
  // signatory for any invoice issued before approver details were captured.
  text(inv.approver_name || inv.signatory_name, MARGIN_L, y, { font: bold });
  y += 14;
  text(inv.approver_title || inv.signatory_title, MARGIN_L, y, { font: bold });
  if (inv.approver_phone) {
    y += 14;
    text(inv.approver_phone, MARGIN_L, y);
  }
  if (inv.approver_email) {
    y += 14;
    text(inv.approver_email, MARGIN_L, y);
  }

  // ── Metadata ────────────────────────────────────────────────────────
  // The source PDFs all inherited the title 'Lekki Clinic lab- Data(July)' from
  // the Google Doc they were duplicated from. Set it explicitly.
  pdf.setTitle(ref);
  // The issuing vendor, not the platform: the document is theirs. Falls back
  // only for a row issued before vendors existed.
  pdf.setAuthor(inv.vendor_name || 'Vendor');
  pdf.setSubject(`Request for Payment – ${inv.subject}`);
  pdf.setProducer('Vendor Invoice Request Platform');
  pdf.setCreator('Vendor Invoice Request Platform');
  const issued = new Date(inv.issued_at);
  pdf.setCreationDate(issued);
  pdf.setModificationDate(issued);

  return pdf.save({ useObjectStreams: false });
}

/** Greedy word wrap to a pixel width. */
function wrap(str, font, size, maxWidth) {
  const out = [];
  let line = '';
  for (const word of String(str).split(/\s+/)) {
    const test = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      out.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) out.push(line);
  return out;
}
