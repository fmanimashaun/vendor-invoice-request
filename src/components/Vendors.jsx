import React, { useCallback, useEffect, useState } from 'react';
import { T, input as inputStyle } from '../theme.js';
import { Card, Field, Table, Td, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { naira } from '../../shared/reference.js';
import VendorDetail from './VendorDetail.jsx';

const BLANK_VENDOR = {
  code: '', name: '', contact_lines: '',
  bank_account_name: '', bank_account_number: '', bank_name: '',
  fee_kobo: '100', signatory_name: '', signatory_title: '',
  font_family: 'arimo',
};

/**
 * The vendor list.
 *
 * Everything about one vendor — payment and tax details, representatives,
 * invoice layout — lives inside that vendor rather than spread across shared
 * screens, because that is how the work arrives: you onboard a vendor, then
 * set that vendor up.
 */
export default function Vendors() {
  const [vendors, setVendors] = useState(null);
  const [fonts, setFonts]     = useState([]);
  const [open, setOpen]       = useState(null);
  const [showNew, setShowNew] = useState(false);
  const [form, setForm]       = useState(BLANK_VENDOR);
  const [busy, setBusy]       = useState(false);
  const [busyId, setBusyId]   = useState(null);
  const [error, setError]     = useState(null);
  const [ok, setOk]           = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ vendors: vs }, { fonts: fs }] = await Promise.all([api.vendors(), api.fonts()]);
      setVendors(vs);
      setFonts(fs || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load vendors.');
      setVendors([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const complete = form.code && form.name && form.bank_account_name
    && form.bank_account_number && form.bank_name
    && form.signatory_name && form.signatory_title;

  async function addVendor(e) {
    e.preventDefault();
    setError(null); setOk(null); setBusy(true);
    try {
      const { vendor } = await api.createVendor({
        ...form,
        fee_kobo: Math.round(Number(form.fee_kobo || 0) * 100),
        contact_lines: form.contact_lines.split('\n').map((l) => l.trim()).filter(Boolean),
      });
      if (form.font_family && form.font_family !== 'arimo') {
        await api.saveVendorTemplate(vendor.id, { version: 1, type: { family: form.font_family } })
          .catch(() => { /* the vendor exists; the font can be set in their view */ });
      }
      setForm(BLANK_VENDOR);
      setShowNew(false);
      await load();
      setOpen(vendor.id);
      setOk(`${vendor.name} onboarded. Upload their artwork to KV under "${vendor.code}/".`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(false); }
  }

  async function toggleVendor(v) {
    const next = v.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !confirm(
      `Suspend ${v.name}? Their reps can still sign in and read their history but cannot `
      + 'approve. Invoices they already issued keep working.')) return;
    setError(null); setOk(null); setBusyId(v.id);
    try {
      await api.setVendorStatus(v.id, next);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusyId(null); }
  }

  const current = (vendors || []).find((v) => v.id === open) || null;

  if (current) {
    return (
      <VendorDetail
        vendor={current}
        fonts={fonts}
        onBack={() => { setOpen(null); load(); }}
        onChanged={load}
      />
    );
  }

  return (
    <>
      <Card
        title="Vendors"
        right={
          <button onClick={() => setShowNew(!showNew)} style={button('ghost')}>
            {showNew ? 'Cancel' : 'Onboard a vendor'}
          </button>
        }
      >
        <Banner onClose={() => setError(null)}>{error}</Banner>
        <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Every vendor sees the same pending queue; whichever approves first
          issues the invoice on their own letterhead. Open one to manage its
          payment details, representatives and invoice layout.
        </p>

        <Table head={['Vendor', 'Code', 'Fee', 'Reps', 'Invoices', 'Layout', 'Status', '']}
               empty={vendors && vendors.length === 0
                 ? 'No vendors yet. Onboard one to get started.' : null}>
          {(vendors || []).map((v) => {
            const off = v.status !== 'active';
            return (
              <tr key={v.id} onClick={() => setOpen(v.id)}
                  style={{ opacity: off ? 0.5 : 1, cursor: 'pointer' }}>
                <Td><strong style={{ color: T.blue }}>{v.name}</strong></Td>
                <Td mono dim>{v.code}</Td>
                <Td dim>{v.fee_kobo != null ? naira(v.fee_kobo) : '—'}</Td>
                <Td dim>{v.staff_count}</Td>
                <Td dim>{v.invoice_count}</Td>
                <Td dim>{v.has_template ? 'own' : 'default'}</Td>
                <Td>
                  <span style={{
                    display: 'inline-block', padding: '2px 9px', borderRadius: 999,
                    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                    color: off ? T.textDim : T.green,
                    border: `1px solid ${off ? T.border : T.green}`,
                  }}>{off ? 'suspended' : 'active'}</span>
                </Td>
                <Td right>
                  <button disabled={busyId === v.id}
                          onClick={(e) => { e.stopPropagation(); toggleVendor(v); }}
                          style={button('ghost', busyId === v.id)}>
                    {off ? 'Restore' : 'Suspend'}
                  </button>
                </Td>
              </tr>
            );
          })}
        </Table>
        {vendors === null && (
          <p style={{ color: T.textDim, fontSize: 14, padding: '14px 10px', margin: 0 }}>Loading…</p>
        )}
      </Card>

      {showNew && (
        <Card title="Onboard a vendor">
          <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
            The code becomes the prefix for this vendor's letterhead artwork in
            KV and cannot be changed later. Representatives, tax settings and
            the invoice layout are set up afterwards, inside the vendor.
          </p>
          <form onSubmit={addVendor}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: '0 16px' }}>
              <Field label="Vendor name">
                <input style={inputStyle} value={form.name} onChange={set('name')}
                       placeholder="Acme Services Ltd" />
              </Field>
              <Field label="Code" hint="Lowercase, no spaces. Permanent.">
                <input style={inputStyle} value={form.code} onChange={set('code')} placeholder="acme" />
              </Field>
              <Field label="Bank account name">
                <input style={inputStyle} value={form.bank_account_name} onChange={set('bank_account_name')} />
              </Field>
              <Field label="Account number">
                <input style={inputStyle} value={form.bank_account_number} onChange={set('bank_account_number')} />
              </Field>
              <Field label="Bank">
                <input style={inputStyle} value={form.bank_name} onChange={set('bank_name')} />
              </Field>
              <Field label="Processing fee (₦)" hint="Charged on requests this vendor approves.">
                <input style={inputStyle} type="number" min="0" step="0.01"
                       value={form.fee_kobo} onChange={set('fee_kobo')} />
              </Field>
              <Field label="Signatory name">
                <input style={inputStyle} value={form.signatory_name} onChange={set('signatory_name')} />
              </Field>
              <Field label="Signatory title">
                <input style={inputStyle} value={form.signatory_title} onChange={set('signatory_title')} />
              </Field>
              <Field label="Invoice font" hint="Match their stationery.">
                <select style={inputStyle} value={form.font_family} onChange={set('font_family')}>
                  {fonts.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.name}{f.metricOf ? ` — like ${f.metricOf}` : ` (${f.kind})`}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Letterhead contact lines" hint="One per line, as printed on their invoice.">
              <textarea style={{ ...inputStyle, minHeight: 84, resize: 'vertical' }}
                        value={form.contact_lines} onChange={set('contact_lines')} />
            </Field>
            <button type="submit" disabled={busy || !complete} style={button('primary', busy || !complete)}>
              {busy ? 'Saving…' : 'Onboard vendor'}
            </button>
          </form>
        </Card>
      )}
    </>
  );
}
