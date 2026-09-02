import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Field, Table, Td, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { PASSWORD_HINT, MIN_LENGTH } from '../../shared/password.js';

const BLANK_REP = { full_name: '', job_title: '', email: '', phone: '', password: '' };

/**
 * One vendor, in full: payment and tax details, representatives, invoice
 * layout. All of it maintained by the client admin — a vendor has reps who
 * approve requests and nobody who configures anything.
 */
export default function VendorDetail({ vendor, fonts, onBack, onChanged }) {
  const [cfg, setCfg]   = useState({
    bank_account_name: vendor.bank_account_name ?? '',
    bank_account_number: vendor.bank_account_number ?? '',
    bank_name: vendor.bank_name ?? '',
    fee_naira: String((vendor.fee_kobo ?? 0) / 100),
    signatory_name: vendor.signatory_name ?? '',
    signatory_title: vendor.signatory_title ?? '',
    tin: vendor.tin ?? '',
    vat_rate_pct: vendor.vat_rate_bps ? String(vendor.vat_rate_bps / 100) : '',
    wht_rate_pct: vendor.wht_rate_bps ? String(vendor.wht_rate_bps / 100) : '',
    vat_basis: vendor.vat_basis ?? 'invoice',
  });
  const [reps, setReps]   = useState([]);
  const [rep, setRep]     = useState(BLANK_REP);
  const [tplJson, setTplJson] = useState('');
  const [tplMeta, setTplMeta] = useState(null);
  const [font, setFont]   = useState('arimo');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy]   = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [ok, setOk]       = useState(null);

  const load = useCallback(async () => {
    try {
      const [{ users }, tpl] = await Promise.all([
        api.users(vendor.id), api.vendorTemplate(vendor.id),
      ]);
      setReps(users || []);
      setTplMeta(tpl);
      setTplJson(tpl.template ? JSON.stringify(tpl.template, null, 2) : '');
      setFont(tpl.effective?.type?.family ?? 'arimo');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this vendor.');
    }
  }, [vendor.id]);
  useEffect(() => { load(); }, [load]);

  async function run(fn, id) {
    setError(null); setOk(null); setBusyId(id ?? null); setBusy(true);
    try {
      const msg = await fn();
      if (msg) setOk(msg);
      await load();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(false); setBusyId(null); }
  }

  const setC = (k) => (e) => setCfg({ ...cfg, [k]: e.target.value });
  const setR = (k) => (e) => setRep({ ...rep, [k]: e.target.value });

  const saveConfig = (e) => {
    e.preventDefault();
    run(async () => {
      const { bankChanged } = await api.saveVendorConfig(vendor.id, {
        ...cfg, fee_kobo: Math.round(Number(cfg.fee_naira || 0) * 100),
      });
      return bankChanged
        ? 'Saved. Bank details changed — that is logged; confirm it with the vendor directly.'
        : 'Saved.';
    });
  };

  const addRep = (e) => {
    e.preventDefault();
    run(async () => {
      const { user } = await api.createUser({
        ...rep, org: 'vendor', vendor_id: vendor.id, roles: ['approver'],
      });
      setRep(BLANK_REP);
      return `${user.full_name} can now sign in and approve requests.`;
    });
  };

  const toggleRep = (u) => {
    const next = u.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !confirm(
      `Remove ${u.full_name}? Invoices they approved keep their name.`)) return;
    run(() => api.setUserStatus(u.id, next), u.id);
  };

  const resetRep = (u) => {
    const pw = prompt(`New password for ${u.full_name}.\n\n${PASSWORD_HINT}\n\n`
      + 'They must change it at next sign-in, so read it out rather than writing it down.');
    if (!pw) return;
    run(async () => {
      await api.resetPassword(u.id, pw);
      return `Password set for ${u.full_name}.`;
    }, u.id);
  };

  const parseTpl = () => {
    if (!tplJson.trim()) return null;
    try { return JSON.parse(tplJson); }
    catch { throw new ApiError({ message: 'That is not valid JSON.' }, 400); }
  };

  const doPreview = () => run(async () => {
    const url = await api.previewTemplate(vendor.id, parseTpl());
    if (preview) URL.revokeObjectURL(preview);
    setPreview(url);
  });

  const saveTpl = (clear = false) => run(async () => {
    const t = await api.saveVendorTemplate(vendor.id, clear ? null : parseTpl());
    setTplMeta(t);
    if (clear) setTplJson('');
    return clear ? 'Reverted to the default layout.' : 'Layout saved.';
  });

  const setFontOnly = (key) => run(async () => {
    const base = parseTpl() ?? {};
    const t = await api.saveVendorTemplate(vendor.id, {
      ...base, version: 1, type: { ...(base.type ?? {}), family: key },
    });
    setTplJson(JSON.stringify(t.template, null, 2));
    setFont(key);
    return 'Font changed.';
  });

  const repComplete = rep.full_name && rep.job_title && rep.email && rep.phone
    && rep.password.length >= MIN_LENGTH;

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <button onClick={onBack} style={button('ghost')}>← All vendors</button>
        <strong style={{ font: `600 16px ${FONT}` }}>{vendor.name}</strong>
        <span style={{ color: T.textDim, fontSize: 13 }}>{vendor.code}</span>
      </div>

      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>

      <Card title="Payment and tax details">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Copied onto every invoice this vendor issues, at the moment it is
          issued. Changing anything here never alters a document that has
          already gone out. Bank details decide where money lands, so confirm a
          change with the vendor on a channel other than email.
        </p>
        <form onSubmit={saveConfig}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: '0 16px' }}>
            <Field label="Account name">
              <input style={inputStyle} value={cfg.bank_account_name} onChange={setC('bank_account_name')} />
            </Field>
            <Field label="Account number">
              <input style={inputStyle} value={cfg.bank_account_number} onChange={setC('bank_account_number')} />
            </Field>
            <Field label="Bank">
              <input style={inputStyle} value={cfg.bank_name} onChange={setC('bank_name')} />
            </Field>
            <Field label="Processing fee (₦)">
              <input style={inputStyle} value={cfg.fee_naira} onChange={setC('fee_naira')} inputMode="decimal" />
            </Field>
            <Field label="Signatory name">
              <input style={inputStyle} value={cfg.signatory_name} onChange={setC('signatory_name')} />
            </Field>
            <Field label="Signatory title">
              <input style={inputStyle} value={cfg.signatory_title} onChange={setC('signatory_title')} />
            </Field>
            <Field label="TIN" hint="Optional. Printed on their invoices.">
              <input style={inputStyle} value={cfg.tin} onChange={setC('tin')} />
            </Field>
            <Field label="VAT %" hint="Added to the invoice total.">
              <input style={inputStyle} value={cfg.vat_rate_pct} onChange={setC('vat_rate_pct')}
                     inputMode="decimal" placeholder="7.5" />
            </Field>
            <Field label="WHT %" hint="Shown as a deduction, not added.">
              <input style={inputStyle} value={cfg.wht_rate_pct} onChange={setC('wht_rate_pct')}
                     inputMode="decimal" placeholder="5" />
            </Field>
            <Field label="Tax applies to" hint="Fee only, where the bill is a pass-through at cost.">
              <select style={inputStyle} value={cfg.vat_basis} onChange={setC('vat_basis')}>
                <option value="invoice">The whole invoice</option>
                <option value="fee">Their fee only</option>
              </select>
            </Field>
          </div>
          <button type="submit" disabled={busy} style={button('primary', busy)}>Save details</button>
        </form>
      </Card>

      <Card title="Representatives">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          They approve requests and issue invoices. Job title, phone and email
          are printed in the signature block of every invoice they approve, so
          enter them exactly as they should appear.
        </p>
        <Table head={['Name', 'Job title', 'Email', 'Phone', 'Status', '']}
               empty={reps.length === 0 ? 'No representatives yet — nothing can be approved.' : null}>
          {reps.map((u) => {
            const off = u.status !== 'active';
            return (
              <tr key={u.id} style={{ opacity: off ? 0.5 : 1 }}>
                <Td>{u.full_name}</Td>
                <Td dim>{u.job_title || '—'}</Td>
                <Td mono>{u.email}</Td>
                <Td mono>{u.phone || '—'}</Td>
                <Td dim>{off ? 'removed' : 'active'}</Td>
                <Td right>
                  <button disabled={busyId === u.id} onClick={() => resetRep(u)}
                          style={{ ...button('ghost', busyId === u.id), marginRight: 6 }}>
                    Reset password
                  </button>
                  <button disabled={busyId === u.id} onClick={() => toggleRep(u)}
                          style={button('ghost', busyId === u.id)}>
                    {off ? 'Restore' : 'Remove'}
                  </button>
                </Td>
              </tr>
            );
          })}
        </Table>

        <form onSubmit={addRep} style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '0 16px' }}>
            <Field label="Full name">
              <input style={inputStyle} value={rep.full_name} onChange={setR('full_name')} />
            </Field>
            <Field label="Job title">
              <input style={inputStyle} value={rep.job_title} onChange={setR('job_title')} />
            </Field>
            <Field label="Email">
              <input style={inputStyle} type="email" value={rep.email} onChange={setR('email')} />
            </Field>
            <Field label="Official phone number">
              <input style={inputStyle} value={rep.phone} onChange={setR('phone')} />
            </Field>
            <Field label="Password" hint={PASSWORD_HINT}>
              <input style={inputStyle} type="password" value={rep.password} onChange={setR('password')} />
            </Field>
          </div>
          <button type="submit" disabled={busy || !repComplete}
                  style={button('primary', busy || !repComplete)}>
            Add representative
          </button>
        </form>
      </Card>

      <Card title="Invoice layout">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 12px', lineHeight: 1.5 }}>
          A digitised replica of this vendor's own invoice. Produce it from
          their blank letterhead and one old invoice:
        </p>
        <code style={{ display: 'block', margin: '0 0 14px', color: T.text, fontSize: 12 }}>
          python scripts/extract-template.py blank.pdf --code {vendor.code} --blank --layout old-invoice.pdf
        </code>

        <div style={{
          border: `1px solid ${T.border}`, borderRadius: 8, padding: '9px 12px',
          marginBottom: 14, fontSize: 13, color: T.textDim,
        }}>
          {tplMeta?.isDefault
            ? 'Using the built-in default layout — their artwork on our geometry.'
            : `Using ${vendor.name}'s own saved layout.`}
        </div>

        <Field label="Font" hint="Metric-compatible options keep their line lengths.">
          <select style={{ ...inputStyle, maxWidth: 340 }} value={font} disabled={busy}
                  onChange={(e) => setFontOnly(e.target.value)}>
            {fonts.map((f) => (
              <option key={f.key} value={f.key}>
                {f.name}{f.metricOf ? ` — like ${f.metricOf}` : ` (${f.kind})`}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Template JSON" hint="Leave empty to use the default layout.">
          <textarea
            style={{
              ...inputStyle, minHeight: 170, resize: 'vertical',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12,
            }}
            value={tplJson}
            onChange={(e) => setTplJson(e.target.value)}
            placeholder={`Paste assets/${vendor.code}/template.json`}
          />
        </Field>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button onClick={doPreview} disabled={busy} style={button('ghost', busy)}>
            {busy ? 'Rendering…' : 'Preview'}
          </button>
          <button onClick={() => saveTpl(false)} disabled={busy || !tplJson.trim()}
                  style={button('primary', busy || !tplJson.trim())}>
            Save layout
          </button>
          {!tplMeta?.isDefault && (
            <button onClick={() => saveTpl(true)} disabled={busy} style={button('ghost', busy)}>
              Revert to default
            </button>
          )}
        </div>

        {preview && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <strong style={{ font: `600 13px ${FONT}` }}>Specimen</strong>
              <a href={preview} target="_blank" rel="noreferrer"
                 style={{ color: T.blue, fontSize: 13 }}>Open full size</a>
            </div>
            <iframe title="Template specimen" src={preview}
                    style={{
                      width: '100%', height: 620, border: `1px solid ${T.border}`,
                      borderRadius: 8, background: '#fff',
                    }} />
          </div>
        )}
      </Card>
    </>
  );
}
