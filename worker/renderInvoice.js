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
import { mergeTemplate, hexRgb } from '../shared/template.js';

// A4 at 72dpi. The source Google Docs template was 1109x1583pt — ~1.87x A4 and
// not a standard size. Everything below is the source geometry multiplied by K.
// Geometry, colour and artwork all come from the vendor's template. Nothing
// about any one vendor's page is compiled in — see shared/template.js.

// Column x-positions for the line-item table.

function fmtDate(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCDate()).padStart(2, '0')} ${
    ['January','February','March','April','May','June','July',
     'August','September','October','November','December'][d.getUTCMonth()]
  } ${d.getUTCFullYear()}`;
}

export async function renderInvoice(inv, assets, template) {
  const tpl = mergeTemplate(template);
  const PAGE_W = tpl.page.w;
  const PAGE_H = tpl.page.h;
  const MARGIN_L = tpl.margins.left;
  const MARGIN_R = tpl.margins.right;
  const BODY = tpl.type.body;
  const SMALL = tpl.type.small;
  const INK = rgb(...hexRgb(tpl.colors.ink));
  const INK_SOFT = rgb(...hexRgb(tpl.colors.soft));
  const RULE = rgb(...hexRgb(tpl.colors.rule));
  const COL_DESC = tpl.table.colDesc;
  const COL_EXTRA = tpl.table.colExtra;
  const COL_AMOUNT = tpl.table.colAmount;

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const regular = await pdf.embedFont(assets.fontRegular, { subset: true });
  const bold    = await pdf.embedFont(assets.fontBold,    { subset: true });

  const page = pdf.addPage([PAGE_W, PAGE_H]);

  // pdf-lib origin is bottom-left; source geometry is top-down.
  // Templates place everything from the TOP of the page; PDF's origin is
  // bottom-left. T() is the single place that flip happens.
  const T = (top) => PAGE_H - top;
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
  // Each entry names a PNG the vendor's letterhead is made of. A template that
  // lists artwork the vendor has not uploaded is skipped rather than throwing:
  // a document missing one band is recoverable, a 500 at approval is not.
  for (const art of tpl.artwork) {
    const bytes = assets.artwork?.[art.asset];
    if (!bytes) continue;
    const img = await pdf.embedPng(bytes);
    page.drawImage(img, { x: art.x, y: T(art.top) - art.h, width: art.w, height: art.h });
  }

  // Letterhead text that is part of the vendor's stationery, not the invoice.
  for (const run of tpl.staticText) {
    const font = run.bold ? bold : regular;
    const size = run.size ?? SMALL;
    const color = run.color ? rgb(...hexRgb(run.color)) : INK;
    if (run.align === 'right') textRight(run.text, run.x, run.top, { font, size, color });
    else if (run.align === 'center') textCenter(run.text, run.top, { font, size, color });
    else text(run.text, run.x, run.top, { font, size, color });
  }

  // ── Contact block: live text, not the source raster ─────────────────
  // In the source PDF this was an image running from x=858 to x=1232 on a
  // 1109pt page — 123pt off the edge, so the address was clipped.
  let cy = tpl.contact.top;
  for (const line of assets.contact) {
    textRight(line, MARGIN_R, cy, { size: SMALL, color: INK_SOFT });
    cy += tpl.contact.lineGap;
  }

  // ── Addressee / ref ─────────────────────────────────────────────────
  const ref = invoiceRef(inv);
  let y = tpl.head.top;

  text('To: ', MARGIN_L, y, { font: bold });
  text(inv.addressee, MARGIN_L + bold.widthOfTextAtSize('To: ', BODY), y, { font: bold });
  textRight(`Ref: ${ref}`, MARGIN_R, y, { font: bold });
  y += tpl.head.rowGap;

  text(inv.addressee_loc, MARGIN_L, y);
  textRight(`Date: ${fmtDate(inv.issued_at)}`, MARGIN_R, y);
  y += tpl.head.subjectGap;

  // ── Subject ─────────────────────────────────────────────────────────
  textCenter(`Request for Payment – ${inv.subject}`, y, { size: tpl.type.subject });
  y += tpl.head.afterSubject;

  // ── Salutation and narrative ────────────────────────────────────────
  // Copied onto the invoice at issue, like everything else on the document.
  text(`Dear ${inv.client_name || 'Sir/Madam'},`, MARGIN_L, y);
  y += tpl.body.salutationGap;
  text('We appreciate your continued partnership and support.', MARGIN_L, y);
  y += tpl.body.thanksGap;
  for (const line of wrap(inv.narrative, regular, BODY, MARGIN_R - MARGIN_L)) {
    text(line, MARGIN_L, y);
    y += tpl.body.lineGap;
  }
  y += tpl.body.afterNarrative;

  // ── Line items ──────────────────────────────────────────────────────
  const extraCol = inv.extra_column_label || null;

  text('Description of Item', COL_DESC, y, { font: bold });
  if (extraCol) text(extraCol, COL_EXTRA, y, { font: bold });
  textRight('Amount', COL_AMOUNT, y, { font: bold });
  y += tpl.table.headGap;
  page.drawLine({ start: { x: MARGIN_L, y: T(y) }, end: { x: MARGIN_R, y: T(y) },
                  thickness: tpl.table.ruleWidth, color: RULE });
  y += tpl.table.ruleGap;

  for (const line of inv.lines) {                       // 1..n rows (D14)
    text(line.description, COL_DESC, y);
    if (extraCol) text(line.extra || '', COL_EXTRA, y);
    textRight(naira(line.amount_kobo), COL_AMOUNT, y);
    y += tpl.table.rowH;
  }

  y += tpl.totals.beforeRule;
  page.drawLine({ start: { x: COL_EXTRA, y: T(y) }, end: { x: MARGIN_R, y: T(y) },
                  thickness: tpl.table.ruleWidth, color: RULE });
  y += tpl.totals.afterRule;

  // Three explicit figures. The source template said "credit ₦75,000 to the
  // account below [₦100 for processing fee]" and AP transfers ₦75,000.
  text('Bill amount', COL_EXTRA, y);
  textRight(naira(inv.amount_kobo), COL_AMOUNT, y);
  y += tpl.totals.rowH;
  text('Processing fee', COL_EXTRA, y);
  textRight(naira(inv.fee_kobo), COL_AMOUNT, y);
  // VAT only prints when the vendor is configured for it, so a vendor with no
  // VAT registration produces exactly the document it did before.
  if (inv.vat_kobo) {
    y += tpl.totals.rowH;
    text('VAT', COL_EXTRA, y);
    textRight(naira(inv.vat_kobo), COL_AMOUNT, y);
  }
  y += tpl.totals.beforeTotal;
  text('Total to transfer', COL_EXTRA, y, { font: bold });
  textRight(naira(inv.total_kobo), COL_AMOUNT, y, { font: bold });

  // Withholding reduces what the vendor receives but NOT what is transferred
  // against this invoice, so it sits below the total and is labelled as a
  // deduction rather than folded into a single figure.
  if (inv.wht_kobo) {
    y += tpl.totals.rowH;
    text('Less withholding tax', COL_EXTRA, y);
    textRight(`-${naira(inv.wht_kobo)}`, COL_AMOUNT, y);
    y += tpl.totals.rowH;
    text('Net to vendor after WHT', COL_EXTRA, y);
    textRight(naira(inv.total_kobo - inv.wht_kobo), COL_AMOUNT, y);
  }
  y += tpl.totals.after;

  // ── Payment instructions ────────────────────────────────────────────
  text('Payment Instructions:', MARGIN_L, y, { font: bold });
  y += tpl.payment.labelGap;
  text(`Kindly credit ${naira(inv.total_kobo)} to the account below:`, MARGIN_L, y);
  y += tpl.payment.introGap;

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
    y += tpl.payment.rowH;
  }
  y += tpl.payment.gapAfter;

  text('Thank you once again for your business.', MARGIN_L, y);
  y += tpl.sign.thanksGap;
  text('Warm Regards,', MARGIN_L, y);
  y += tpl.sign.nameGap;
  // The approver's own details, copied onto the row at issue, so the document
  // names the person who actually approved it. Falls back to the config
  // signatory for any invoice issued before approver details were captured.
  text(inv.approver_name || inv.signatory_name, MARGIN_L, y, { font: bold });
  y += tpl.sign.lineGap;
  text(inv.approver_title || inv.signatory_title, MARGIN_L, y, { font: bold });
  if (inv.approver_phone) {
    y += tpl.sign.lineGap;
    text(inv.approver_phone, MARGIN_L, y);
  }
  if (inv.approver_email) {
    y += tpl.sign.lineGap;
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
