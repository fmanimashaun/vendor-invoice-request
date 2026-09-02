import React from 'react';
import { T, FONT } from '../theme.js';
import { Card, button } from './Shell.jsx';
import { naira } from '../../shared/reference.js';
import {
  useRequestFilters, RequestFilters, RequestTableView, RECENT_APPROVED, emptyFor,
} from './RequestTable.jsx';

/**
 * One set of controls for the whole page.
 *
 * The figures and the list are the same data counted two ways, so they answer
 * to the same filter bar. Two ranges on one screen — one over the summary,
 * one over the table — meant the headline number and the rows beneath it could
 * describe different months, with nothing on the page saying so.
 *
 * Everything is computed from the rows already loaded rather than from a
 * separate summary call. That is what lets a filter on vendor or location move
 * the totals and not just the list.
 */
const isIssued = (r) => !!r.invoice_no;

function totals(rows) {
  const issued = rows.filter(isIssued);
  const sum = (f) => issued.reduce((n, r) => n + (r[f] || 0), 0);
  return {
    count: issued.length,
    total: sum('issued_total_kobo'),
    amount: sum('issued_amount_kobo'),
    fee: sum('issued_fee_kobo'),
    vat: sum('issued_vat_kobo'),
    wht: sum('issued_wht_kobo'),
    pending: rows.filter((r) => r.status === 'pending'),
  };
}

const Stat = ({ label, value, hint, strong }) => (
  <div style={{
    border: `1px solid ${T.border}`, borderRadius: T.radius,
    padding: '13px 15px', background: T.panelAlt, minWidth: 0,
  }}>
    <div style={{
      fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase',
      color: T.textDim, marginBottom: 6,
    }}>{label}</div>
    <div style={{
      font: `${strong ? 700 : 600} ${strong ? 20 : 17}px ${FONT}`,
      color: T.text, wordBreak: 'break-word',
    }}>{value}</div>
    {hint && <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>{hint}</div>}
  </div>
);

export default function Dashboard({ requests = [], loading = false, onSeeAll }) {
  // Approved by default: an approved request is one a vendor has stood behind,
  // and it is the only kind that can carry an invoice.
  const f = useRequestFilters(requests, { defaultStatus: 'approved' });
  const t = totals(f.filtered);

  return (
    <>
      <Card title="Issued invoices">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Counts documents that exist, not requests that were raised. These are
          the figures that back the spend if anyone asks what it was for.
          Everything on this page responds to the filters below.
        </p>

        <RequestFilters f={f} presets />

        <div style={{
          display: 'grid', gap: 12,
          gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))',
        }}>
          <Stat label="Invoices issued" value={t.count}
                hint={f.any ? 'matching these filters' : 'across everything'} />
          <Stat label="Total invoiced" value={naira(t.total)} strong
                hint="What was transferred" />
          <Stat label="Bill amount" value={naira(t.amount)} hint="Excluding fees and tax" />
          <Stat label="Processing fees" value={naira(t.fee)} />
          {t.vat > 0 && <Stat label="VAT" value={naira(t.vat)} hint="Added to totals" />}
          {t.wht > 0 && (
            <Stat label="WHT to remit" value={naira(t.wht)}
                  hint="Withheld, not part of the total" />
          )}
          {t.pending.length > 0 && (
            <Stat label="Awaiting a vendor" value={t.pending.length}
                  hint={`${naira(t.pending.reduce((n, r) => n + (r.total_kobo || 0), 0))} not yet issued`} />
          )}
        </div>
      </Card>

      <RequestTableView
        title="Recently approved"
        rows={f.filtered}
        columns={RECENT_APPROVED}
        defaultSort={{ key: 'decided_at', dir: 'desc' }}
        pageSize={10}
        loading={loading}
        resetKey={f.key}
        right={onSeeAll && (
          <button onClick={onSeeAll} style={button('ghost')}>See all requests →</button>
        )}
        empty={emptyFor(requests.length, f.clear)}
      />
    </>
  );
}
