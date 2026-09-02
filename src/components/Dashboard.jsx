import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Field, Table, Td, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { naira } from '../../shared/reference.js';

const today = () => new Date().toISOString().slice(0, 10);
const jan1 = () => `${new Date().getUTCFullYear()}-01-01`;

/**
 * What has been issued, over a date range.
 *
 * Everything here counts INVOICES, not requests. A request is an intention; an
 * invoice is a document that exists and can be put in front of a tax
 * inspector, and only the second is worth reporting. The figures come off the
 * invoice rows too — a request's amounts were indicative until a vendor took
 * it and applied their own fee and tax.
 */
export default function Dashboard() {
  const [from, setFrom] = useState(jan1());
  const [to, setTo]     = useState(today());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async (a, b) => {
    setBusy(true); setError(null);
    try {
      setData(await api.summary(a, b));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the summary.');
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { load(jan1(), today()); }, [load]);

  const preset = (label, a, b) => (
    <button key={label} onClick={() => { setFrom(a); setTo(b); load(a, b); }}
            style={{ ...button('ghost'), padding: '5px 11px', fontSize: 12 }}>
      {label}
    </button>
  );

  const y = new Date().getUTCFullYear();
  const m = String(new Date().getUTCMonth() + 1).padStart(2, '0');

  const Breakdown = ({ title, rows, note }) => (
    <Card title={title}>
      {note && (
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 12px' }}>{note}</p>
      )}
      <Table head={['', { label: 'Invoices', right: true }, { label: 'Total', right: true }]}
             empty={(rows || []).length === 0 ? 'Nothing issued in this range.' : null}>
        {(rows || []).map((r) => (
          <tr key={r.key ?? r.label}>
            <Td>{r.label ?? r.key ?? '—'}</Td>
            <Td right dim>{r.count}</Td>
            <Td right mono>{naira(r.total_kobo)}</Td>
          </tr>
        ))}
      </Table>
    </Card>
  );

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
        color: strong ? T.text : T.text, wordBreak: 'break-word',
      }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>{hint}</div>}
    </div>
  );

  const t = data?.totals;

  return (
    <>
      <Card title="Issued invoices">
        <Banner onClose={() => setError(null)}>{error}</Banner>
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Counts documents that exist, not requests that were raised. These are
          the figures that back the spend if anyone asks what it was for.
        </p>

        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap', marginBottom: 12 }}>
          <Field label="From">
            <input style={{ ...inputStyle, width: 170 }} type="date" value={from}
                   onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <input style={{ ...inputStyle, width: 170 }} type="date" value={to}
                   onChange={(e) => setTo(e.target.value)} />
          </Field>
          <button onClick={() => load(from, to)} disabled={busy}
                  style={{ ...button('primary', busy), marginBottom: 14 }}>
            {busy ? 'Loading…' : 'Apply'}
          </button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 18 }}>
          {preset('This month', `${y}-${m}-01`, today())}
          {preset('This year', `${y}-01-01`, `${y}-12-31`)}
          {preset('Last year', `${y - 1}-01-01`, `${y - 1}-12-31`)}
        </div>

        {t && (
          <div style={{
            display: 'grid', gap: 12,
            gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))',
          }}>
            <Stat label="Invoices issued" value={t.count} />
            <Stat label="Total invoiced" value={naira(t.total_kobo)} strong
                  hint="What was transferred" />
            <Stat label="Bill amount" value={naira(t.amount_kobo)}
                  hint="Excluding fees and tax" />
            <Stat label="Processing fees" value={naira(t.fee_kobo)} />
            {t.vat_kobo > 0 && <Stat label="VAT" value={naira(t.vat_kobo)} hint="Added to totals" />}
            {t.wht_kobo > 0 && (
              <Stat label="WHT to remit" value={naira(t.wht_kobo)}
                    hint="Withheld, not part of the total" />
            )}
            {data.pending?.count > 0 && (
              <Stat label="Awaiting a vendor" value={data.pending.count}
                    hint={`${naira(data.pending.amount_kobo)} not yet issued`} />
            )}
          </div>
        )}
      </Card>

      <Breakdown title="By category" rows={data?.byType} />
      <Breakdown title="By vendor" rows={data?.byVendor} />
      <Breakdown title="By business unit" rows={data?.byBu} />
      <Breakdown title="By location" rows={data?.bySite}
                 note="Unit-wide requests are counted against the unit's numbering site." />
      <Breakdown title="By billing period" rows={data?.byMonth}
                 note="The month the bill covers, which is not always the month it was issued." />
    </>
  );
}
