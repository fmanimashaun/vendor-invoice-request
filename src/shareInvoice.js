import { api } from './api.js';
import { downloadName } from '../shared/reference.js';

/**
 * Hand an issued invoice to WhatsApp without a manual download.
 *
 * The obvious approach does not work: wa.me and the whatsapp:// scheme carry
 * TEXT ONLY. There is no way to attach a file to either, so a share link can
 * pass a URL but never the PDF itself.
 *
 * What does work is the Web Share API. `navigator.share({ files })` opens the
 * OS share sheet, the user picks WhatsApp, and then picks the person or group
 * inside WhatsApp. Requirements, all of which the app already satisfies except
 * the last:
 *
 *   - a secure context (https, or localhost)
 *   - a real user gesture, so this must be called straight from onClick and
 *     cannot await anything before the share() call on Safari
 *   - on desktop, the INSTALLED WhatsApp app registered as a share target.
 *     WhatsApp Web in a browser tab is not one.
 *
 * Where files cannot be shared we fall back to a normal download, which is the
 * behaviour that exists today, rather than pretending the share worked.
 */
export function canShareFiles() {
  return typeof navigator !== 'undefined'
    && typeof navigator.canShare === 'function'
    && typeof navigator.share === 'function';
}

async function fetchInvoiceFile(invoiceNo) {
  const res = await fetch(api.pdfUrl(invoiceNo), { credentials: 'same-origin' });
  if (!res.ok) {
    // The PDF route is scoped to the issuing vendor, so a 404 here usually
    // means the caller is not that vendor rather than that nothing exists.
    throw new Error(res.status === 404
      ? 'That invoice is not available to your organisation.'
      : 'Could not fetch the invoice.');
  }
  const blob = await res.blob();
  return new File([blob], downloadName(invoiceNo), { type: 'application/pdf' });
}

function download(invoiceNo) {
  const a = document.createElement('a');
  a.href = api.pdfUrl(invoiceNo);
  a.download = downloadName(invoiceNo);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/**
 * Returns 'shared' | 'downloaded' | 'cancelled'.
 *
 * A cancelled share is not an error: the user closed the sheet, and telling
 * them something failed would be wrong.
 */
export async function shareInvoice(invoiceNo) {
  if (!canShareFiles()) {
    download(invoiceNo);
    return 'downloaded';
  }

  const file = await fetchInvoiceFile(invoiceNo);

  // canShare must be asked about this specific file: support for sharing files
  // is separate from support for sharing text, and varies by platform.
  if (!navigator.canShare({ files: [file] })) {
    download(invoiceNo);
    return 'downloaded';
  }

  try {
    await navigator.share({
      files: [file],
      title: invoiceNo,
      text: `Payment request ${invoiceNo}`,
    });
    return 'shared';
  } catch (err) {
    if (err?.name === 'AbortError') return 'cancelled';
    // Some desktop browsers advertise canShare and then refuse at share time.
    download(invoiceNo);
    return 'downloaded';
  }
}
