import React, { useMemo, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Table, Td, Status, button } from './Shell.jsx';
import { naira } from '../../shared/reference.js';

/**
 * Every request and where it got to. The admin's read-only view.
 *
 * Deliberately no link to the PDF. Approving and issuing are the vendor's acts,
 * and the document is worth nothing as audit evidence if the payer can produce
 * it themselves — so the admin sees that an invoice exists and what it is
 * numbered, but cannot render one. The server enforces that too; this screen
 * just does not offer a button that would 403.
 */
const COLUMNS = [
  { key: 'request_ref',   label: 'Request',   get: (r) => r.request_ref },
  { key: 'created_at',    label: 'Raised',    get: (r) => r.created_at },
  { key: 'created_by_name', label: 'By',      get: (r) => r.created_by_name },
  { key: 'bu_label',      label: 'Unit',      get: (r) => r.bu_label },
  { key: 'site_label',    label: 'Location',  get: (r) => r.site_label ?? '' },
  { key: 'type_label',    label: 'Category',  get: (r) => r.type_label },
  { key: 'period',        label: 'Period',    get: (r) => r.period },
  { key: 'total_kobo',    label: 'Amount',    get: (r) => r.total_kobo, num: true, right: true },
  { key: 'status',        label: 'Status',    get: (r) => r.status },
  { key: 'decided_vendor_name', label: 'Vendor', get: (r) => r.decided_vendor_name ?? '' },
  { key: 'invoice_no',    label: 'Invoice no', get: (r) => r.invoice_no ?? '' },
];

export default function Requests({ requests, me, acting }) {
  const [sort, setSort] = useState({ key: 'created_at', dir: 'desc' });
  const [q, setQ]             = useState('');
  const [status, setStatus]   = useState('');
  const [type, setType]       = useState('');
  const [vendor, setVendor]   = useState('');
  const [from, setFrom]       = useState('');
  const [to, setTo]           = useState('');
  const [onlyIssued, setOnlyIssued] = useState(false);

  const isAdmin = me.org === 'client' && acting === 'admin';

  const options = useMemo(() => ({
    status: [...new Set(requests.map((r) => r.status))].sort(),
    type:   [...new Set(requests.map((r) => r.type_label))].sort(),
    vendor: [...new Set(requests.map((r) => r.decided_vendor_name).filter(Boolean))].sort(),
  }), [requests]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = requests.filter((r) => {
      if (status && r.status !== status) return false;
      if (type && r.type_label !== type) return false;
      if (vendor && r.decided_vendor_name !== vendor) return false;
      if (onlyIssued && !r.invoice_no) return false;
      // created_at is 'YYYY-MM-DD HH:MM:SS', so a plain string compare on the
      // date part is correct and needs no parsing.
      if (from && (r.created_at || '').slice(0, 10) < from) return false;
      if (to && (r.created_at || '').slice(0, 10) > to) return false;
      if (!needle) return true;
      return [r.request_ref, r.invoice_no, r.description, r.site_label, r.bu_label,
        r.created_by_name, r.decided_vendor_name, r.asset_key]
        .some((v) => String(v ?? '').toLowerCase().includes(needle));
    });

    const col = COLUMNS.find((c) => c.key === sort.key) ?? COLUMNS[1];
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...out].sort((a, b) => {
      const x = col.get(a), y = col.get(b);
      if (col.num) return ((x ?? 0) - (y ?? 0)) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });
  }, [requests, q, status, type, vendor, from, to, onlyIssued, sort]);

  const total = rows.reduce((n, r) => n + (r.issued_total_kobo ?? r.total_kobo ?? 0), 0);
  const issued = rows.filter((r) => r.invoice_no).length;

  const head = COLUMNS.map((c) => ({
    label: (
      <button
        onClick={() => setSort((s) => ({
          key: c.key, dir: s.key === c.key && s.dir === 'asc' ? 'desc' : 'asc',
        }))}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          font: `700 11px ${FONT}`, letterSpacing: 0.5, textTransform: 'uppercase',
          color: sort.key === c.key ? T.blue : T.textDim,
        }}
      >
        {c.label}{sort.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
      </button>
    ),
    right: c.right,
  }));

  const clear = () => {
    setQ(''); setStatus(''); setType(''); setVendor(''); setFrom(''); setTo('');
    setOnlyIssued(false);
  };
  const filtered = q || status || type || vendor || from || to || onlyIssued;

  return (
    <Card
      title={isAdmin ? 'All requests' : 'My requests'}
      right={
        <span style={{ color: T.textDim, fontSize: 13 }}>
          {rows.length} of {requests.length} · {issued} invoiced · {naira(total)}
        </span>
      }
    >
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input style={{ ...inputStyle, width: 220 }} value={q} placeholder="Search…"
               onChange={(e) => setQ(e.target.value)} />
        <select style={{ ...inputStyle, width: 130 }} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {options.status.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select style={{ ...inputStyle, width: 160 }} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Any category</option>
          {options.type.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        {isAdmin && options.vendor.length > 0 && (
          <select style={{ ...inputStyle, width: 170 }} value={vendor} onChange={(e) => setVendor(e.target.value)}>
            <option value="">Any vendor</option>
            {options.vendor.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        <input style={{ ...inputStyle, width: 150 }} type="date" value={from}
               onChange={(e) => setFrom(e.target.value)} title="Raised from" />
        <input style={{ ...inputStyle, width: 150 }} type="date" value={to}
               onChange={(e) => setTo(e.target.value)} title="Raised to" />
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 13, color: T.textDim }}>
          <input type="checkbox" checked={onlyIssued} onChange={(e) => setOnlyIssued(e.target.checked)} />
          Invoiced only
        </label>
        {filtered && <button onClick={clear} style={button('ghost')}>Clear</button>}
      </div>

      <Table head={head} empty={rows.length === 0
        ? (requests.length ? 'Nothing matches those filters.' : 'No requests yet.') : null}>
        {rows.map((r) => (
          <tr key={r.id}>
            <Td mono>{r.request_ref}</Td>
            <Td dim>{(r.created_at || '').slice(0, 10)}</Td>
            <Td dim>{r.created_by_name}</Td>
            <Td dim>{r.bu_code}</Td>
            <Td>{r.site_label ?? <span style={{ color: T.textDim }}>unit-wide</span>}</Td>
            <Td>{r.type_label}</Td>
            <Td dim>{r.period_label}</Td>
            <Td right mono>{naira(r.issued_total_kobo ?? r.total_kobo)}</Td>
            <Td>
              <Status value={r.status} />
              {r.status === 'rejected' && r.reject_reason && (
                <div style={{ fontSize: 12, color: T.textDim, marginTop: 4, maxWidth: 220 }}>
                  {r.reject_reason}
                </div>
              )}
              {(r.ack_flags || []).length > 0 && (
                <div style={{ fontSize: 11, color: T.amber, marginTop: 4 }}>
                  ⚠ {(r.ack_flags || []).length} confirmed override{(r.ack_flags || []).length > 1 ? 's' : ''}
                </div>
              )}
            </Td>
            <Td dim>{r.decided_vendor_name ?? '—'}</Td>
            {/* The number only, never a link: the admin cannot render the PDF. */}
            <Td mono>{r.invoice_no ?? <span style={{ color: T.textDim }}>—</span>}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
