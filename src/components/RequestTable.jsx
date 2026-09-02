import React, { useEffect, useMemo, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Table, Td, Status, button } from './Shell.jsx';
import { naira } from '../../shared/reference.js';

/**
 * Requests: filtering, sorting and pagination over one set of rows.
 *
 * Split into a hook, a filter bar and a table so a page can own the filter
 * state and drive more than the table with it — on the dashboard the figures
 * and the list answer to the same controls. Two filter bars on one screen
 * that disagree about what is being shown is worse than none.
 *
 * Nothing here links to a PDF. Rendering the document is the issuing vendor's
 * act, and an invoice is worth nothing as audit evidence if the payer can
 * produce it themselves, so the number shows as plain text. The server
 * enforces it too; this simply offers no button that would 403.
 */

const day = (v) => (v || '').slice(0, 10);
const UNIT_WIDE = 'Unit-wide';

/**
 * The dimensions you can narrow by. Each derives its options from the rows
 * present, so a filter never offers a value that would return nothing, and a
 * select with nothing to choose between hides itself.
 *
 * Data-driven because the alternative — a hand-written select per dimension —
 * is how you end up with one that reads a different field than it filters on.
 */
export const FILTERS = [
  { key: 'status', any: 'Any status',   width: 130, get: (r) => r.status },
  { key: 'type',   any: 'Any category', width: 155, get: (r) => r.type_label },
  { key: 'bu',     any: 'Any unit',     width: 125, get: (r) => r.bu_code },
  { key: 'site',   any: 'Any location', width: 165, get: (r) => r.site_label ?? UNIT_WIDE },
  { key: 'vendor', any: 'Any vendor',   width: 165, get: (r) => r.decided_vendor_name ?? '' },
  { key: 'by',     any: 'Anyone',       width: 155, get: (r) => r.created_by_name ?? '' },
];

const ALL_COLUMNS = {
  request_ref:  { label: 'Request',  get: (r) => r.request_ref },
  created_at:   { label: 'Raised',   get: (r) => r.created_at },
  created_by_name: { label: 'By',    get: (r) => r.created_by_name },
  decided_at:   { label: 'Approved', get: (r) => r.decided_at },
  bu_code:      { label: 'Unit',     get: (r) => r.bu_code },
  site_label:   { label: 'Location', get: (r) => r.site_label ?? '' },
  type_label:   { label: 'Category', get: (r) => r.type_label },
  period:       { label: 'Period',   get: (r) => r.period },
  amount:       { label: 'Amount',   get: (r) => r.issued_total_kobo ?? r.total_kobo, num: true, right: true },
  status:       { label: 'Status',   get: (r) => r.status },
  decided_vendor_name: { label: 'Vendor', get: (r) => r.decided_vendor_name ?? '' },
  invoice_no:   { label: 'Invoice no', get: (r) => r.invoice_no ?? '' },
};

const FULL = ['request_ref', 'created_at', 'created_by_name', 'bu_code', 'site_label',
  'type_label', 'period', 'amount', 'status', 'decided_vendor_name', 'invoice_no'];

export const RECENT_APPROVED = ['request_ref', 'decided_at', 'bu_code', 'site_label',
  'type_label', 'amount', 'decided_vendor_name', 'invoice_no'];

/** Filter state, plus the rows that survive it. */
export function useRequestFilters(requests, { defaultStatus = '' } = {}) {
  const initial = { status: defaultStatus, type: '', bu: '', site: '', vendor: '', by: '' };
  const [sel, setSel]   = useState(initial);
  const [q, setQ]       = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo]     = useState('');

  const options = useMemo(() => Object.fromEntries(FILTERS.map((f) => [
    f.key, [...new Set(requests.map(f.get).filter(Boolean))].sort(),
  ])), [requests]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return requests.filter((r) => {
      for (const f of FILTERS) if (sel[f.key] && f.get(r) !== sel[f.key]) return false;
      // Dates are 'YYYY-MM-DD HH:MM:SS', so comparing the date part as a
      // string is correct and needs no parsing. Looking at approved requests,
      // the date that matters is when it was approved, not when it was raised.
      const on = day(sel.status === 'approved' ? (r.decided_at || r.created_at) : r.created_at);
      if (from && on < from) return false;
      if (to && on > to) return false;
      if (!needle) return true;
      return [r.request_ref, r.invoice_no, r.description, r.site_label, r.bu_code,
        r.created_by_name, r.decided_vendor_name, r.asset_key, r.type_label]
        .some((v) => String(v ?? '').toLowerCase().includes(needle));
    });
  }, [requests, q, sel, from, to]);

  const any = q || from || to || FILTERS.some((f) => sel[f.key] !== initial[f.key]);
  const clear = () => { setQ(''); setSel(initial); setFrom(''); setTo(''); };
  const key = `${q}|${JSON.stringify(sel)}|${from}|${to}`;

  return { sel, setSel, q, setQ, from, setFrom, to, setTo, options, filtered, any, clear, key };
}

const ctl = { ...inputStyle, padding: '6px 9px', fontSize: 13 };

export function RequestFilters({ f, showVendorFilter = true, presets = false }) {
  const y = new Date().getUTCFullYear();
  const m = String(new Date().getUTCMonth() + 1).padStart(2, '0');
  const today = new Date().toISOString().slice(0, 10);
  const range = (a, b) => { f.setFrom(a); f.setTo(b); };

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input style={{ ...ctl, width: 200 }} value={f.q} placeholder="Search…"
               onChange={(e) => f.setQ(e.target.value)} />
        {FILTERS.map((x) => {
          if (x.key === 'vendor' && !showVendorFilter) return null;
          // Nothing to choose between is not a filter, it is clutter.
          if (f.options[x.key].length < 2 && !f.sel[x.key]) return null;
          return (
            <select key={x.key} style={{ ...ctl, width: x.width }} title={x.any}
                    value={f.sel[x.key]}
                    onChange={(e) => f.setSel({ ...f.sel, [x.key]: e.target.value })}>
              <option value="">{x.any}</option>
              {f.options[x.key].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          );
        })}
        <input style={{ ...ctl, width: 145 }} type="date" title="From"
               value={f.from} onChange={(e) => f.setFrom(e.target.value)} />
        <input style={{ ...ctl, width: 145 }} type="date" title="To"
               value={f.to} onChange={(e) => f.setTo(e.target.value)} />
        {f.any && <button onClick={f.clear} style={button('ghost')}>Clear</button>}
      </div>
      {presets && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {[
            ['This month', `${y}-${m}-01`, today],
            ['This year',  `${y}-01-01`, `${y}-12-31`],
            ['Last year',  `${y - 1}-01-01`, `${y - 1}-12-31`],
            ['All time',   '', ''],
          ].map(([label, a, b]) => (
            <button key={label} onClick={() => range(a, b)}
                    style={{ ...button('ghost'), padding: '5px 11px', fontSize: 12 }}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The table, over rows someone else has already filtered. */
export function RequestTableView({
  rows: all,
  title,
  right,
  note,
  columns = FULL,
  pageSize: initialPageSize = 25,
  defaultSort = { key: 'created_at', dir: 'desc' },
  loading = false,
  empty,
  resetKey,
}) {
  const [sort, setSort] = useState(defaultSort);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  // Changing what is shown returns you to page one: page 4 of a narrower
  // result set is usually blank, and reads as a broken filter.
  useEffect(() => { setPage(1); }, [resetKey]);

  const sorted = useMemo(() => {
    const col = ALL_COLUMNS[sort.key] ?? ALL_COLUMNS.created_at;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...all].sort((a, b) => {
      const x = col.get(a), y = col.get(b);
      if (col.num) return ((x ?? 0) - (y ?? 0)) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });
  }, [all, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  useEffect(() => { if (page > pages) setPage(1); }, [page, pages]);
  const rows = sorted.slice((page - 1) * pageSize, page * pageSize);

  const head = columns.map((k) => {
    const c = ALL_COLUMNS[k];
    return {
      right: c.right,
      label: (
        <button
          onClick={() => setSort((s) => ({
            key: k, dir: s.key === k && s.dir === 'asc' ? 'desc' : 'asc',
          }))}
          title={`Sort by ${c.label}`}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            font: `700 11px ${FONT}`, letterSpacing: 0.5, textTransform: 'uppercase',
            color: sort.key === k ? T.blue : T.textDim,
          }}
        >
          {c.label}{sort.key === k ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
      ),
    };
  });

  const cell = (key, r) => {
    switch (key) {
      case 'request_ref': return <Td key={key} mono>{r.request_ref}</Td>;
      case 'created_at':  return <Td key={key} dim>{day(r.created_at)}</Td>;
      case 'decided_at':  return <Td key={key} dim>{day(r.decided_at) || '—'}</Td>;
      case 'created_by_name': return <Td key={key} dim>{r.created_by_name}</Td>;
      case 'bu_code':     return <Td key={key} dim>{r.bu_code}</Td>;
      case 'site_label':  return (
        <Td key={key}>{r.site_label ?? <span style={{ color: T.textDim }}>unit-wide</span>}</Td>
      );
      case 'type_label':  return <Td key={key}>{r.type_label}</Td>;
      case 'period':      return <Td key={key} dim>{r.period_label}</Td>;
      case 'amount':      return (
        <Td key={key} right mono>{naira(r.issued_total_kobo ?? r.total_kobo)}</Td>
      );
      case 'status':      return (
        <Td key={key}>
          <Status value={r.status} />
          {r.status === 'rejected' && r.reject_reason && (
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 4, maxWidth: 220 }}>
              {r.reject_reason}
            </div>
          )}
          {(r.ack_flags || []).length > 0 && (
            <div style={{ fontSize: 11, color: T.amber, marginTop: 4 }}>
              ⚠ {r.ack_flags.length} confirmed override{r.ack_flags.length > 1 ? 's' : ''}
            </div>
          )}
        </Td>
      );
      case 'decided_vendor_name':
        return <Td key={key} dim>{r.decided_vendor_name ?? '—'}</Td>;
      case 'invoice_no':
        return <Td key={key} mono>{r.invoice_no ?? <span style={{ color: T.textDim }}>—</span>}</Td>;
      default: return <Td key={key} />;
    }
  };

  return (
    <Card title={title} right={right}>
      {note && (
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>{note}</p>
      )}
      <Table head={head} loading={loading} empty={empty}>
        {rows.map((r) => <tr key={r.id}>{columns.map((k) => cell(k, r))}</tr>)}
      </Table>
      {sorted.length > 0 && (
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          marginTop: 14, color: T.textDim, fontSize: 13,
        }}>
          <span>
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, sorted.length)} of {sorted.length}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}
                    style={button('ghost', page <= 1)}>Previous</button>
            <button disabled={page >= pages} onClick={() => setPage(page + 1)}
                    style={button('ghost', page >= pages)}>Next</button>
          </div>
          <span>Page {page} of {pages}</span>
          <select style={{ ...ctl, width: 108, marginLeft: 'auto' }} value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
        </div>
      )}
    </Card>
  );
}

export const emptyFor = (total, clear) => (total
  ? {
      title: 'Nothing matches those filters',
      hint: 'Try a wider date range, or clear the filters to see everything.',
      action: <button onClick={clear} style={button('ghost')}>Clear filters</button>,
    }
  : {
      title: 'No requests yet',
      hint: 'Raised requests appear here with their status, and their invoice '
        + 'number once a vendor has issued one.',
    });

/** Self-contained: its own filters, its own table. Used by the request list. */
export default function RequestTable({
  requests, title, columns = FULL, pageSize = 25,
  defaultStatus = '', defaultSort, showVendorFilter = true, loading = false,
}) {
  const f = useRequestFilters(requests, { defaultStatus });
  const total = f.filtered.reduce((n, r) => n + (r.issued_total_kobo ?? r.total_kobo ?? 0), 0);

  return (
    <RequestTableView
      title={title}
      rows={f.filtered}
      columns={columns}
      pageSize={pageSize}
      defaultSort={defaultSort}
      loading={loading}
      resetKey={f.key}
      right={
        <span style={{ color: T.textDim, fontSize: 13 }}>
          {f.filtered.length === requests.length
            ? `${f.filtered.length} request${f.filtered.length === 1 ? '' : 's'}`
            : `${f.filtered.length} of ${requests.length}`} · {naira(total)}
        </span>
      }
      note={<RequestFilters f={f} showVendorFilter={showVendorFilter} />}
      empty={emptyFor(requests.length, f.clear)}
    />
  );
}
