import React, { useCallback, useEffect, useState } from 'react';
import { T, input as inputStyle } from '../theme.js';
import {
  Card, Field, FormGrid, Table, Tr, Td, RowActions, Banner, Modal, Confirm,
  PageHeader, Status, button,
} from './Shell.jsx';
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
  const [toggling, setToggling] = useState(null);
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

  async function confirmToggle() {
    const v = toggling;
    const next = v.status === 'active' ? 'disabled' : 'active';
    setError(null); setOk(null); setBusyId(v.id);
    try {
      await api.setVendorStatus(v.id, next);
      await load();
      setToggling(null);
      setOk(next === 'disabled' ? `${v.name} suspended.` : `${v.name} restored.`);
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
        notice={ok}
        onBack={() => { setOpen(null); setOk(null); load(); }}
        onChanged={load}
      />
    );
  }

  return (
    <>
      <PageHeader
        title="Vendors"
        description="Every vendor sees the same pending queue; whichever approves first issues the invoice on their own letterhead. Open one to manage its payment details, representatives and invoice layout."
        actions={
          <button onClick={() => setShowNew(true)} style={button('primary')}>
            <span style={{ fontSize: 18, lineHeight: 0.8 }}>+</span> Onboard a vendor
          </button>
        }
      />

      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>

      <Card
        title="Onboarded vendors"
        right={vendors && <span style={{ color: T.textDim, fontSize: 13 }}>{vendors.filter((v) => v.status === 'active').length} active</span>}
      >
        <Table head={['Vendor', 'Code', 'Fee', 'Reps', 'Invoices', 'Layout', 'Status', '']}
               loading={vendors === null}
               empty={{
                 title: 'No vendors yet',
                 hint: 'Every vendor sees the same pending queue; whichever approves first issues on its own letterhead.',
                 action: <button onClick={() => setShowNew(true)} style={button('primary')}>Onboard the first vendor</button>,
               }}>
          {(vendors || []).map((v) => {
            const off = v.status !== 'active';
            return (
              <Tr key={v.id} onClick={() => setOpen(v.id)} dimmed={off}>
                <Td><strong style={{ color: T.blue, fontWeight: 600 }}>{v.name}</strong></Td>
                <Td mono dim>{v.code}</Td>
                <Td dim>{v.fee_kobo != null ? naira(v.fee_kobo) : '—'}</Td>
                <Td dim>{v.staff_count}</Td>
                <Td dim>{v.invoice_count}</Td>
                <Td dim>{v.has_template ? 'own' : 'default'}</Td>
                <Td><Status value={off ? 'suspended' : 'active'} color={off ? T.textDim : T.green} /></Td>
                <RowActions>
                  <button disabled={busyId === v.id}
                          onClick={(e) => { e.stopPropagation(); setToggling(v); }}
                          style={button(off ? 'ghost' : 'danger', busyId === v.id, 'sm')}>
                    {off ? 'Restore' : 'Suspend'}
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); setOpen(v.id); }} style={button('ghost', false, 'sm')}>
                    Open
                  </button>
                </RowActions>
              </Tr>
            );
          })}
        </Table>
      </Card>

      {showNew && (
        <OnboardVendorModal
          fonts={fonts}
          onClose={() => setShowNew(false)}
          onCreated={async (vendor) => {
            setShowNew(false);
            await load();
            setOk(`${vendor.name} onboarded. Add their representatives below, and upload their artwork to KV under "${vendor.code}/".`);
            setOpen(vendor.id);
          }}
        />
      )}

      {toggling && (
        <Confirm
          title={toggling.status === 'active' ? `Suspend ${toggling.name}?` : `Restore ${toggling.name}?`}
          confirmLabel={toggling.status === 'active' ? 'Suspend vendor' : 'Restore vendor'}
          kind={toggling.status === 'active' ? 'danger' : 'primary'}
          busy={busyId === toggling.id}
          onConfirm={confirmToggle}
          onClose={() => setToggling(null)}
        >
          {toggling.status === 'active'
            ? <>Their representatives can still sign in and read their history, but cannot claim or approve anything. Invoices they already issued keep working.</>
            : <>Their representatives can claim and approve requests again.</>}
        </Confirm>
      )}
    </>
  );
}

function OnboardVendorModal({ fonts, onClose, onCreated }) {
  const [form, setForm] = useState(BLANK_VENDOR);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const complete = form.code && form.name && form.bank_account_name
    && form.bank_account_number && form.bank_name
    && form.signatory_name && form.signatory_title;

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
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
      await onCreated(vendor);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Onboard a vendor"
      subtitle="The code becomes the prefix for this vendor's letterhead artwork in KV and cannot be changed later. Representatives, tax settings and the invoice layout are set up afterwards, inside the vendor."
      onClose={onClose}
      size="lg"
      locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="onboard-vendor" disabled={busy || !complete} style={button('primary', busy || !complete)}>
            {busy ? 'Saving…' : 'Onboard vendor'}
          </button>
        </>
      }
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="onboard-vendor" onSubmit={submit}>
        <FormGrid min={230}>
          <Field label="Vendor name">
            <input style={inputStyle} value={form.name} onChange={set('name')} autoFocus
                   placeholder="Acme Services Ltd" />
          </Field>
          <Field label="Code" hint="Lowercase, no spaces. Permanent.">
            <input style={inputStyle} value={form.code} onChange={set('code')} placeholder="acme" />
          </Field>
        </FormGrid>

        <SectionLabel>Where they are paid</SectionLabel>
        <FormGrid min={230}>
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
        </FormGrid>

        <SectionLabel>On the invoice</SectionLabel>
        <FormGrid min={230}>
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
        </FormGrid>
        <Field label="Letterhead contact lines" hint="One per line, as printed on their invoice.">
          <textarea style={{ ...inputStyle, minHeight: 84, resize: 'vertical' }}
                    value={form.contact_lines} onChange={set('contact_lines')} />
        </Field>
      </form>
    </Modal>
  );
}

const SectionLabel = ({ children }) => (
  <div style={{
    fontSize: 12, fontWeight: 700, letterSpacing: 0.4, color: T.blue,
    margin: '6px 0 12px', paddingTop: 12, borderTop: `1px solid ${T.borderSoft}`,
  }}>{children}</div>
);
