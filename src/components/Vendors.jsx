import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Field, Table, Td, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { naira } from '../../shared/reference.js';

const BLANK_VENDOR = {
  code: '', name: '', contact_lines: '',
  bank_account_name: '', bank_account_number: '', bank_name: '',
  fee_kobo: '100', signatory_name: '', signatory_title: '',
  tin: '', vat_rate_pct: '', wht_rate_pct: '', vat_basis: 'invoice',
  font_family: 'arimo',
};
const BLANK_USER = { full_name: '', job_title: '', email: '', phone: '', role: 'approver', password: '' };

/**
 * Vendors and their staff, owned by the client admin.
 *
 * Job title, email and phone are not decoration: they are copied onto every
 * invoice that person approves, so the document names whoever approved it.
 * That is why they are required rather than optional.
 *
 * Removal is a disable, not a delete — an approver's name has to keep
 * resolving on invoices they already issued, and a suspended vendor's issued
 * documents have to keep rendering.
 */
export default function Vendors() {
  const [vendors, setVendors] = useState(null);
  const [fonts, setFonts]     = useState([]);
  const [users, setUsers]     = useState([]);
  const [selected, setSelected] = useState(null);   // vendor id
  const [showNewVendor, setShowNewVendor] = useState(false);
  const [vForm, setVForm]     = useState(BLANK_VENDOR);
  const [uForm, setUForm]     = useState(BLANK_USER);
  const [busy, setBusy]       = useState(false);
  const [busyId, setBusyId]   = useState(null);
  const [error, setError]     = useState(null);
  const [ok, setOk]           = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ vendors: vs }, { users: us }, { fonts: fs }] =
        await Promise.all([api.vendors(), api.users(), api.fonts()]);
      setVendors(vs);
      setUsers(us);
      setFonts(fs || []);
      setSelected((cur) => cur ?? vs[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load vendors.');
      setVendors([]);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setV = (k) => (e) => setVForm({ ...vForm, [k]: e.target.value });
  const setU = (k) => (e) => setUForm({ ...uForm, [k]: e.target.value });

  const vendorComplete = vForm.code && vForm.name && vForm.bank_account_name
    && vForm.bank_account_number && vForm.bank_name
    && vForm.signatory_name && vForm.signatory_title;
  const userComplete = selected && uForm.full_name && uForm.job_title
    && uForm.email && uForm.phone && uForm.password.length >= 12;

  async function addVendor(e) {
    e.preventDefault();
    setError(null); setOk(null); setBusy(true);
    try {
      const fee = Math.round(Number(vForm.fee_kobo || 0) * 100);
      const { vendor } = await api.createVendor({
        ...vForm,
        fee_kobo: fee,
        contact_lines: vForm.contact_lines.split('\n').map((l) => l.trim()).filter(Boolean),
      });
      setVForm(BLANK_VENDOR);
      setShowNewVendor(false);
      setOk(`${vendor.name} onboarded. Upload their letterhead artwork to KV under "${vendor.code}/".`);
      await load();
      setSelected(vendor.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function addUser(e) {
    e.preventDefault();
    setError(null); setOk(null); setBusy(true);
    try {
      const { user } = await api.createUser({ ...uForm, vendor_id: selected });
      setUForm(BLANK_USER);
      setOk(`${user.full_name} can now sign in.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleUser(u) {
    const next = u.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled'
        && !confirm(`Remove ${u.full_name}? They will no longer be able to sign in. Invoices they approved keep their name.`)) return;
    setError(null); setOk(null); setBusyId(`u${u.id}`);
    try {
      await api.setUserStatus(u.id, next);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusyId(null); }
  }

  async function toggleVendor(v) {
    const next = v.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled'
        && !confirm(`Suspend ${v.name}? Their staff can still sign in and read their history, but cannot approve. Invoices they already issued keep working.`)) return;
    setError(null); setOk(null); setBusyId(`v${v.id}`);
    try {
      await api.setVendorStatus(v.id, next);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusyId(null); }
  }

  const current = (vendors || []).find((v) => v.id === selected) || null;
  const staff = users.filter((u) => u.vendor_id === selected);

  return (
    <>
      <Card
        title="Vendors"
        right={
          <button onClick={() => setShowNewVendor(!showNewVendor)} style={button('ghost')}>
            {showNewVendor ? 'Cancel' : 'Onboard a vendor'}
          </button>
        }
      >
        <Banner onClose={() => setError(null)}>{error}</Banner>
        <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>

        <Table
          head={['Vendor', 'Code', 'Fee', 'Staff', 'Invoices', 'Status', '']}
          empty={vendors && vendors.length === 0 ? 'No vendors yet. Onboard one to get started.' : null}
        >
          {(vendors || []).map((v) => {
            const off = v.status !== 'active';
            return (
              <tr
                key={v.id}
                onClick={() => setSelected(v.id)}
                style={{
                  opacity: off ? 0.5 : 1, cursor: 'pointer',
                  background: v.id === selected ? `${T.blue}14` : undefined,
                }}
              >
                <Td>{v.name}</Td>
                <Td mono dim>{v.code}</Td>
                <Td dim>{v.fee_kobo != null ? naira(v.fee_kobo) : '—'}</Td>
                <Td dim>{v.staff_count}</Td>
                <Td dim>{v.invoice_count}</Td>
                <Td>
                  <span style={{
                    display: 'inline-block', padding: '2px 9px', borderRadius: 999,
                    fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                    color: off ? T.textDim : T.green,
                    border: `1px solid ${off ? T.border : T.green}`,
                  }}>{off ? 'suspended' : 'active'}</span>
                </Td>
                <Td right>
                  <button
                    disabled={busyId === `v${v.id}`}
                    onClick={(e) => { e.stopPropagation(); toggleVendor(v); }}
                    style={button('ghost', busyId === `v${v.id}`)}
                  >{off ? 'Restore' : 'Suspend'}</button>
                </Td>
              </tr>
            );
          })}
        </Table>
        {vendors === null && (
          <p style={{ color: T.textDim, fontSize: 14, padding: '14px 10px', margin: 0 }}>Loading…</p>
        )}
      </Card>

      {showNewVendor && (
        <Card title="Onboard a vendor">
          <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
            The code becomes the prefix for this vendor's letterhead artwork in
            KV and cannot be changed later. After saving, extract their artwork
            from a sample invoice and upload it under that prefix — until you
            do, their approvals will succeed but the PDF will not render.
          </p>
          <form onSubmit={addVendor}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: '0 16px' }}>
              <Field label="Vendor name">
                <input style={inputStyle} value={vForm.name} onChange={setV('name')}
                       placeholder="Acme Services Ltd" />
              </Field>
              <Field label="Code" hint="Lowercase, no spaces. Permanent.">
                <input style={inputStyle} value={vForm.code} onChange={setV('code')}
                       placeholder="acme" />
              </Field>
              <Field label="Bank account name">
                <input style={inputStyle} value={vForm.bank_account_name} onChange={setV('bank_account_name')} />
              </Field>
              <Field label="Account number">
                <input style={inputStyle} value={vForm.bank_account_number} onChange={setV('bank_account_number')} />
              </Field>
              <Field label="Bank">
                <input style={inputStyle} value={vForm.bank_name} onChange={setV('bank_name')} />
              </Field>
              <Field label="Processing fee (₦)" hint="Charged on requests this vendor approves.">
                <input style={inputStyle} type="number" min="0" step="0.01"
                       value={vForm.fee_kobo} onChange={setV('fee_kobo')} />
              </Field>
              <Field label="Signatory name">
                <input style={inputStyle} value={vForm.signatory_name} onChange={setV('signatory_name')} />
              </Field>
              <Field label="Signatory title">
                <input style={inputStyle} value={vForm.signatory_title} onChange={setV('signatory_title')} />
              </Field>
              <Field label="TIN" hint="Optional. Printed on their invoices.">
                <input style={inputStyle} value={vForm.tin} onChange={setV('tin')} />
              </Field>
              <Field label="VAT %" hint="Leave blank if not VAT registered.">
                <input style={inputStyle} type="number" min="0" max="100" step="0.01"
                       value={vForm.vat_rate_pct} onChange={setV('vat_rate_pct')} placeholder="7.5" />
              </Field>
              <Field label="WHT %" hint="Withheld by the payer, not added to the total.">
                <input style={inputStyle} type="number" min="0" max="100" step="0.01"
                       value={vForm.wht_rate_pct} onChange={setV('wht_rate_pct')} placeholder="5" />
              </Field>
              <Field label="Invoice font"
                     hint="Match their stationery. Metric-compatible options keep their line lengths.">
                <select style={inputStyle} value={vForm.font_family} onChange={setV('font_family')}>
                  {fonts.map((f) => (
                    <option key={f.key} value={f.key}>
                      {f.name}{f.metricOf ? ` — like ${f.metricOf}` : ` (${f.kind})`}
                      {f.builtin ? '' : ' · uploaded'}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Tax applies to"
                     hint="Fee only, where the bill is a pass-through at cost.">
                <select style={inputStyle} value={vForm.vat_basis} onChange={setV('vat_basis')}>
                  <option value="invoice">The whole invoice</option>
                  <option value="fee">Their fee only</option>
                </select>
              </Field>
            </div>
            <Field label="Letterhead contact lines" hint="One per line, as printed on their invoice.">
              <textarea style={{ ...inputStyle, minHeight: 92, resize: 'vertical' }}
                        value={vForm.contact_lines} onChange={setV('contact_lines')}
                        placeholder={'Address: 1 Example Street,\nLagos\nPhone: +234 800 000 0000'} />
            </Field>
            <button type="submit" disabled={busy || !vendorComplete}
                    style={button('primary', busy || !vendorComplete)}>
              {busy ? 'Saving…' : 'Onboard vendor'}
            </button>
          </form>
        </Card>
      )}

      {current && (
        <Card title={`${current.name} — staff`}>
          <Table
            head={['Name', 'Job title', 'Email', 'Phone', 'Role', 'Status', '']}
            empty={staff.length === 0 ? 'No staff for this vendor yet.' : null}
          >
            {staff.map((u) => {
              const off = u.status !== 'active';
              return (
                <tr key={u.id} style={{ opacity: off ? 0.5 : 1 }}>
                  <Td>{u.full_name}</Td>
                  <Td dim>{u.job_title || '—'}</Td>
                  <Td mono>{u.email}</Td>
                  <Td mono>{u.phone || '—'}</Td>
                  <Td dim>{u.role}</Td>
                  <Td>
                    <span style={{
                      display: 'inline-block', padding: '2px 9px', borderRadius: 999,
                      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                      color: off ? T.textDim : T.green,
                      border: `1px solid ${off ? T.border : T.green}`,
                    }}>{off ? 'removed' : 'active'}</span>
                  </Td>
                  <Td right>
                    <button disabled={busyId === `u${u.id}`} onClick={() => toggleUser(u)}
                            style={button('ghost', busyId === `u${u.id}`)}>
                      {off ? 'Restore' : 'Remove'}
                    </button>
                  </Td>
                </tr>
              );
            })}
          </Table>

          <div style={{ borderTop: `1px solid ${T.border}`, marginTop: 18, paddingTop: 18 }}>
            <h3 style={{ margin: '0 0 6px', font: `600 14px ${FONT}`, color: T.text }}>
              Add someone to {current.name}
            </h3>
            <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
              These details appear in the signature block of every invoice this
              person approves, so enter them exactly as they should be printed.
            </p>
            <form onSubmit={addUser}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: '0 16px' }}>
                <Field label="Full name">
                  <input style={inputStyle} value={uForm.full_name} onChange={setU('full_name')} />
                </Field>
                <Field label="Job title">
                  <input style={inputStyle} value={uForm.job_title} onChange={setU('job_title')}
                         placeholder="Business Development Manager" />
                </Field>
                <Field label="Email">
                  <input style={inputStyle} type="email" value={uForm.email} onChange={setU('email')} />
                </Field>
                <Field label="Official phone number">
                  <input style={inputStyle} value={uForm.phone} onChange={setU('phone')}
                         placeholder="+234 803 555 0142" />
                </Field>
                <Field label="Role" hint="Approvers and admins can approve requests.">
                  <select style={inputStyle} value={uForm.role} onChange={setU('role')}>
                    <option value="approver">Approver</option>
                    <option value="admin">Admin</option>
                    <option value="requester">Requester</option>
                  </select>
                </Field>
                <Field label="Temporary password" hint="At least 12 characters.">
                  <input style={inputStyle} type="password" value={uForm.password} onChange={setU('password')} />
                </Field>
              </div>
              <button type="submit" disabled={busy || !userComplete}
                      style={button('primary', busy || !userComplete)}>
                {busy ? 'Adding…' : 'Add user'}
              </button>
            </form>
          </div>
        </Card>
      )}
    </>
  );
}
