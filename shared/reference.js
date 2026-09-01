// Reference data shared by the Worker and the frontend.
//
// Business units, sites and the BU->sites map are D1 tables, edited by the
// client admin at runtime. Nothing about any particular organisation is
// compiled in: the Worker loads the tables (loadReference) and the frontend
// receives them from /api/bootstrap. Example rows live in
// scripts/seed.example.sql.
//
// Request types are the exception and stay real constants: they carry
// behaviour, not just labels. `scope` drives validation, `extraField` drives
// the form and what is printed, and `dedupe` maps to a partial unique index in
// the migration. A request type added from a UI would have no duplicate guard.

// scope 'SITE' — the site is what is being billed for; the user picks it.
// scope 'BU'   — the invoice covers the whole business unit; site_code stays
//                NULL and the BU's numberingSite is used only for the ref.
//                Keeps per-site spend reporting honest.
export const REQUEST_TYPES = [
  {
    code: 'ELEC',
    label: 'Electricity Bill',
    scope: 'SITE',
    // Captured and printed so the document can be reconciled against the
    // utility bill and read by ApprovalMax. Deliberately NOT part of `dedupe`:
    // a typo in the meter number would otherwise let a duplicate through, and
    // a site has one electricity account, unlike its several routers.
    extraField: { key: 'asset_key', label: 'Meter No.', placeholder: '04521187733' },
    // One per site per month.
    dedupe: ['site_code', 'period'],
  },
  {
    code: 'ROUTER',
    label: 'Router Internet',
    scope: 'SITE',
    extraField: { key: 'asset_key', label: 'Router No.', placeholder: '08148648357' },
    // A site can have several routers, so the number is part of the identity.
    dedupe: ['site_code', 'period', 'asset_key'],
  },
  {
    code: 'STAFFDC',
    label: 'Staff Data & Credit',
    scope: 'BU',
    extraField: null,
    // One per business unit per month.
    dedupe: ['bu_code', 'period'],
  },
];

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];

export const typeFor = (c) => REQUEST_TYPES.find((t) => t.code === c) ?? null;

/**
 * Name lookups over a loaded reference set.
 *
 * These take the reference explicitly rather than closing over a constant,
 * because the data now lives in D1 and both sides receive it: the Worker from
 * loadReference(), the frontend from /api/bootstrap. Falling back to the code
 * matters — a site that was disabled after a request was raised must still
 * render something on that old row.
 */
export const buNameIn   = (ref, c) => ref?.businessUnits?.find((b) => b.code === c)?.name ?? c;
export const siteNameIn = (ref, c) => ref?.sites?.find((s) => s.code === c)?.name ?? c;

/** The site used for numbering: the real site, or the BU fallback for BU-scope. */
export function numberingSiteIn(ref, bu_code, site_code) {
  if (site_code) return site_code;
  return ref?.businessUnits?.find((b) => b.code === bu_code)?.numbering_site ?? null;
}

/** 'RFC','GBG','2026-09',1 -> 'RFC/GBG/2026/SEP/001'. Derived, never stored. */
export function invoiceRef({ bu_code, site_code, period, seq }) {
  const [y, m] = period.split('-');
  return `${bu_code}/${site_code}/${y}/${MONTHS[+m - 1]}/${String(seq).padStart(3, '0')}`;
}

/** Slashes are path separators — downloads need a flat name. */
export const downloadName = (ref) => `${ref.replace(/\//g, '-')}.pdf`;

/** kobo -> '₦75,000.00'. Integers only; never floats for money. */
export function naira(kobo) {
  const abs = Math.abs(kobo);
  const s = `₦${Math.floor(abs / 100).toLocaleString('en-NG')}.${String(abs % 100).padStart(2, '0')}`;
  return kobo < 0 ? `-${s}` : s;
}

/** '2026-09' -> 'September 2026' */
export function periodLabel(period) {
  const [y, m] = period.split('-');
  return `${['January','February','March','April','May','June','July',
             'August','September','October','November','December'][+m - 1]} ${y}`;
}
