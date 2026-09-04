import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, MONO, input as inputStyle } from '../theme.js';
import {
  Card, Field, FormGrid, Table, Tr, Td, RowActions, Banner, Modal, Confirm,
  SuccessState, Details, Status, button,
} from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { naira } from '../../shared/reference.js';
import { PASSWORD_HINT, MIN_LENGTH } from '../../shared/password.js';
import SetPassword from './SetPassword.jsx';

// must_change_password defaults ON, matching client staff. The admin who
// typed this password knows it until the rep replaces it.
const BLANK_REP = {
  full_name: '', job_title: '', email: '', phone: '', password: '',
  must_change_password: true,
};

const cfgFrom = (vendor) => ({
  bank_account_name: vendor.bank_account_name ?? '',
  bank_account_number: vendor.bank_account_number ?? '',
  bank_name: vendor.bank_name ?? '',
  fee_naira: String((vendor.fee_kobo ?? 0) / 100),
  signatory_name: vendor.signatory_name ?? '',
  signatory_title: vendor.signatory_title ?? '',
  tin: vendor.tin ?? '',
  vat_rate_pct: vendor.vat_rate_bps ? String(vendor.vat_rate_bps / 100) : '',
  vat_basis: vendor.vat_basis ?? 'invoice',
});

/**
 * One vendor, in full: payment and tax details, representatives, invoice
 * layout. All of it maintained by the client admin — a vendor has reps who
 * approve requests and nobody who configures anything.
 *
 * Everything on this page is read-only until you open the matching dialog.
 * The page shows what is currently true; the dialog is where it changes.
 */
export default function VendorDetail({ vendor, fonts, notice, onBack, onChanged }) {
  const [reps, setReps]   = useState(null);
  const [tplMeta, setTplMeta] = useState(null);
  const [font, setFont]   = useState('arimo');
  const [busy, setBusy]   = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [ok, setOk]       = useState(notice || null);

  // Which dialog is open, if any.
  const [editingConfig, setEditingConfig] = useState(false);
  const [addingRep, setAddingRep] = useState(false);
  const [resetting, setResetting] = useState(null);
  const [toggling, setToggling] = useState(null);
  const [editingLayout, setEditingLayout] = useState(false);
  const [reverting, setReverting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [{ users }, tpl] = await Promise.all([
        api.users(vendor.id), api.vendorTemplate(vendor.id),
      ]);
      setReps(users || []);
      setTplMeta(tpl);
      setFont(tpl.effective?.type?.family ?? 'arimo');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this vendor.');
      setReps([]);
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
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
      return false;
    } finally { setBusy(false); setBusyId(null); }
  }

  async function confirmToggle() {
    const u = toggling;
    const next = u.status === 'active' ? 'disabled' : 'active';
    const done = await run(() => api.setUserStatus(u.id, next).then(() =>
      next === 'disabled' ? `${u.full_name} removed. Invoices they approved keep their name.` : `${u.full_name} restored.`), u.id);
    if (done) setToggling(null);
  }

  const setFontOnly = (key) => run(async () => {
    const base = tplMeta?.template ?? {};
    const t = await api.saveVendorTemplate(vendor.id, {
      ...base, version: 1, type: { ...(base.type ?? {}), family: key },
    });
    setTplMeta(t);
    setFont(key);
    return 'Font changed.';
  });

  const fontName = (key) => fonts.find((f) => f.key === key)?.name || key;
  const off = vendor.status !== 'active';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20, flexWrap: 'wrap' }}>
        <button onClick={onBack} style={button('ghost', false, 'sm')}>← All vendors</button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h1 style={{ margin: 0, font: `700 22px ${FONT}`, letterSpacing: -0.2 }}>{vendor.name}</h1>
          <span style={{ color: T.textDim, fontSize: 13, fontFamily: MONO }}>{vendor.code}</span>
          <Status value={off ? 'suspended' : 'active'} color={off ? T.textDim : T.green} />
        </div>
      </div>

      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>

      <Card
        title="Payment and tax details"
        subtitle="Copied onto every invoice this vendor issues, at the moment it is issued. Changing anything here never alters a document that has already gone out."
        right={<button onClick={() => setEditingConfig(true)} style={button('ghost', false, 'sm')}>Edit details</button>}
      >
        <Details rows={[
          ['Account name', vendor.bank_account_name],
          ['Account number', vendor.bank_account_number, true],
          ['Bank', vendor.bank_name],
          ['Processing fee', vendor.fee_kobo != null ? naira(vendor.fee_kobo) : null],
          ['Signatory', vendor.signatory_name && `${vendor.signatory_name}${vendor.signatory_title ? ` · ${vendor.signatory_title}` : ''}`],
          ['TIN', vendor.tin, true],
          ['VAT', vendor.vat_rate_bps ? `${vendor.vat_rate_bps / 100}% on ${vendor.vat_basis === 'fee' ? 'their fee only' : 'the whole invoice'}` : 'None'],
        ]} />
      </Card>

      <Card
        title="Representatives"
        subtitle="They approve requests and issue invoices. Job title, phone and email are printed in the signature block of every invoice they approve."
        right={
          <button onClick={() => setAddingRep(true)} style={button('primary', false, 'sm')}>
            <span style={{ fontSize: 16, lineHeight: 0.8 }}>+</span> Add representative
          </button>
        }
      >
        <Table head={['Name', 'Job title', 'Email', 'Phone', 'Status', '']}
               loading={reps === null}
               empty={{
                 title: 'No representatives yet',
                 hint: 'Until this vendor has someone who can sign in, it cannot approve a request or issue an invoice.',
                 action: <button onClick={() => setAddingRep(true)} style={button('primary')}>Add the first representative</button>,
               }}>
          {(reps || []).map((u) => {
            const gone = u.status !== 'active';
            return (
              <Tr key={u.id} dimmed={gone}>
                <Td><strong style={{ fontWeight: 600 }}>{u.full_name}</strong></Td>
                <Td dim>{u.job_title || '—'}</Td>
                <Td mono dim>{u.email}</Td>
                <Td mono dim>{u.phone || '—'}</Td>
                <Td><Status value={gone ? 'removed' : 'active'} color={gone ? T.textDim : T.green} /></Td>
                <RowActions>
                  <button disabled={busyId === u.id} onClick={() => setResetting(u)}
                          style={button('ghost', busyId === u.id, 'sm')}>
                    Reset password
                  </button>
                  <button disabled={busyId === u.id} onClick={() => setToggling(u)}
                          style={button(gone ? 'ghost' : 'danger', busyId === u.id, 'sm')}>
                    {gone ? 'Restore' : 'Remove'}
                  </button>
                </RowActions>
              </Tr>
            );
          })}
        </Table>
      </Card>

      <Card
        title="Invoice layout"
        subtitle="A digitised replica of this vendor's own invoice, so the document they issue looks like the one they would have typed."
        right={
          <>
            {tplMeta && !tplMeta.isDefault && (
              <button onClick={() => setReverting(true)} disabled={busy} style={button('ghost', busy, 'sm')}>Revert to default</button>
            )}
            <button onClick={() => setEditingLayout(true)} disabled={!tplMeta} style={button('ghost', !tplMeta, 'sm')}>
              {tplMeta?.isDefault ? 'Add their layout' : 'Edit layout'}
            </button>
          </>
        }
      >
        <Details rows={[
          ['Layout', tplMeta ? (tplMeta.isDefault ? 'Built-in default — their artwork on our geometry' : `${vendor.name}'s own saved layout`) : 'Loading…'],
          ['Font', fontName(font)],
        ]} />
        <Field label="Change font" hint="Metric-compatible options keep their line lengths. Applies immediately." style={{ marginTop: 18, marginBottom: 0 }}>
          <select style={{ ...inputStyle, maxWidth: 340 }} value={font} disabled={busy}
                  onChange={(e) => setFontOnly(e.target.value)}>
            {fonts.map((f) => (
              <option key={f.key} value={f.key}>
                {f.name}{f.metricOf ? ` — like ${f.metricOf}` : ` (${f.kind})`}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      {editingConfig && (
        <EditConfigModal
          vendor={vendor}
          onClose={() => setEditingConfig(false)}
          onSaved={async (bankChanged) => {
            setEditingConfig(false);
            await run(async () => bankChanged
              ? 'Saved. Bank details changed — that is logged; confirm it with the vendor directly.'
              : 'Details saved.');
          }}
        />
      )}

      {addingRep && (
        <AddRepModal
          vendor={vendor}
          onClose={() => setAddingRep(false)}
          onCreated={async () => { await load(); onChanged?.(); }}
        />
      )}

      {resetting && (
        <SetPassword
          user={resetting}
          onClose={() => setResetting(null)}
          onDone={(pw, mustChange) => {
            const u = resetting;
            setResetting(null);
            run(async () => {
              await api.resetPassword(u.id, pw, mustChange);
              return `Password set for ${u.full_name}.`
                + (mustChange ? ' They must change it at next sign-in.'
                              : ' They were NOT asked to change it.');
            }, u.id);
          }}
        />
      )}

      {toggling && (
        <Confirm
          title={toggling.status === 'active' ? `Remove ${toggling.full_name}?` : `Restore ${toggling.full_name}?`}
          confirmLabel={toggling.status === 'active' ? 'Remove' : 'Restore'}
          kind={toggling.status === 'active' ? 'danger' : 'primary'}
          busy={busyId === toggling.id}
          onConfirm={confirmToggle}
          onClose={() => setToggling(null)}
        >
          {toggling.status === 'active'
            ? <>They will not be able to sign in or approve anything. Invoices they already approved keep their name — nothing is deleted.</>
            : <>They will be able to sign in and approve requests again.</>}
        </Confirm>
      )}

      {editingLayout && tplMeta && (
        <LayoutModal
          vendor={vendor}
          template={tplMeta.template}
          onClose={() => setEditingLayout(false)}
          onSaved={async () => {
            setEditingLayout(false);
            await run(async () => 'Layout saved. Issued invoices keep the layout they were issued with.');
          }}
        />
      )}

      {reverting && (
        <Confirm
          title="Revert to the default layout?"
          confirmLabel="Revert"
          kind="danger"
          busy={busy}
          onConfirm={async () => {
            const done = await run(async () => {
              await api.saveVendorTemplate(vendor.id, null);
              return 'Reverted to the default layout.';
            });
            if (done) setReverting(false);
          }}
          onClose={() => setReverting(false)}
        >
          Their saved layout is discarded and new invoices use the built-in
          geometry with their artwork. Invoices already issued are not affected.
        </Confirm>
      )}
    </>
  );
}

function EditConfigModal({ vendor, onClose, onSaved }) {
  const [cfg, setCfg] = useState(() => cfgFrom(vendor));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setCfg({ ...cfg, [k]: e.target.value });

  const bankTouched = cfg.bank_account_name !== (vendor.bank_account_name ?? '')
    || cfg.bank_account_number !== (vendor.bank_account_number ?? '')
    || cfg.bank_name !== (vendor.bank_name ?? '');

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const { bankChanged } = await api.saveVendorConfig(vendor.id, {
        ...cfg, fee_kobo: Math.round(Number(cfg.fee_naira || 0) * 100),
      });
      await onSaved(bankChanged);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Edit ${vendor.name}`}
      subtitle="Printed on every invoice they issue from now on. Nothing already issued changes."
      onClose={onClose}
      size="lg"
      locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="edit-vendor-config" disabled={busy} style={button('primary', busy)}>
            {busy ? 'Saving…' : 'Save details'}
          </button>
        </>
      }
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>
      {bankTouched && (
        <Banner kind="warn">
          You are changing where this vendor is paid. The change is logged. Confirm
          it with the vendor on a channel other than email before saving.
        </Banner>
      )}
      <form id="edit-vendor-config" onSubmit={submit}>
        <FormGrid min={220}>
          <Field label="Account name">
            <input style={inputStyle} value={cfg.bank_account_name} onChange={set('bank_account_name')} autoFocus />
          </Field>
          <Field label="Account number">
            <input style={inputStyle} value={cfg.bank_account_number} onChange={set('bank_account_number')} />
          </Field>
          <Field label="Bank">
            <input style={inputStyle} value={cfg.bank_name} onChange={set('bank_name')} />
          </Field>
          <Field label="Processing fee (₦)">
            <input style={inputStyle} value={cfg.fee_naira} onChange={set('fee_naira')} inputMode="decimal" />
          </Field>
          <Field label="Signatory name">
            <input style={inputStyle} value={cfg.signatory_name} onChange={set('signatory_name')} />
          </Field>
          <Field label="Signatory title">
            <input style={inputStyle} value={cfg.signatory_title} onChange={set('signatory_title')} />
          </Field>
          <Field label="TIN" hint="Optional. Printed on their invoices.">
            <input style={inputStyle} value={cfg.tin} onChange={set('tin')} />
          </Field>
          <Field label="VAT %" hint="Added to the invoice total. Leave blank for none.">
            <input style={inputStyle} value={cfg.vat_rate_pct} onChange={set('vat_rate_pct')}
                   inputMode="decimal" placeholder="7.5" />
          </Field>
          <Field label="Tax applies to" hint="Fee only, where the bill is a pass-through at cost.">
            <select style={inputStyle} value={cfg.vat_basis} onChange={set('vat_basis')}>
              <option value="invoice">The whole invoice</option>
              <option value="fee">Their fee only</option>
            </select>
          </Field>
        </FormGrid>
      </form>
    </Modal>
  );
}

function AddRepModal({ vendor, onClose, onCreated }) {
  const [rep, setRep] = useState(BLANK_REP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [made, setMade] = useState(null);
  const set = (k) => (e) => setRep({ ...rep, [k]: e.target.value });

  const complete = rep.full_name.trim() && rep.job_title.trim() && rep.email.trim() && rep.phone.trim()
    && rep.password.length >= MIN_LENGTH;

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const { user } = await api.createUser({
        ...rep, org: 'vendor', vendor_id: vendor.id, roles: ['approver'],
      });
      setMade({ ...user, mustChange: rep.must_change_password });
      await onCreated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(false); }
  }

  if (made) {
    return (
      <Modal title="Representative added" onClose={onClose} size="sm"
        actions={
          <>
            <button onClick={onClose} style={button('ghost')}>Done</button>
            <button onClick={() => { setMade(null); setRep(BLANK_REP); }} style={button('primary')}>Add another</button>
          </>
        }>
        <SuccessState title={`${made.full_name} can now approve for ${vendor.name}`}>
          Give them their email and the password you set.{' '}
          {made.mustChange
            ? 'They will choose their own password the first time they sign in.'
            : <span style={{ color: T.amber }}>They will keep the password you typed — you know it too.</span>}
        </SuccessState>
      </Modal>
    );
  }

  return (
    <Modal
      title={`Add a representative for ${vendor.name}`}
      subtitle="Job title, phone and email are printed in the signature block of every invoice they approve, so enter them exactly as they should appear."
      onClose={onClose}
      locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="add-rep" disabled={busy || !complete} style={button('primary', busy || !complete)}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </>
      }
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="add-rep" onSubmit={submit}>
        <FormGrid>
          <Field label="Full name">
            <input style={inputStyle} value={rep.full_name} onChange={set('full_name')} autoFocus />
          </Field>
          <Field label="Job title">
            <input style={inputStyle} value={rep.job_title} onChange={set('job_title')} placeholder="Business Development Manager" />
          </Field>
          <Field label="Email">
            <input style={inputStyle} type="email" value={rep.email} onChange={set('email')} />
          </Field>
          <Field label="Official phone number">
            <input style={inputStyle} value={rep.phone} onChange={set('phone')} placeholder="+234 803 555 0142" />
          </Field>
        </FormGrid>
        <Field label="Temporary password" hint={PASSWORD_HINT}>
          <input style={inputStyle} type="password" value={rep.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, lineHeight: 1.45 }}>
          <input type="checkbox" checked={rep.must_change_password} style={{ marginTop: 3 }}
                 onChange={(e) => setRep({ ...rep, must_change_password: e.target.checked })} />
          <span>
            Make them choose their own password when they first sign in
            <div style={{ fontSize: 12, color: rep.must_change_password ? T.textDim : T.amber, marginTop: 3 }}>
              {rep.must_change_password
                ? 'Leave this on unless you mean for them to keep the password you just typed.'
                : 'They will keep the password you typed, which you also know.'}
            </div>
          </span>
        </label>
      </form>
    </Modal>
  );
}

/**
 * The template JSON, a specimen render, and Save. The specimen is rendered
 * server-side from whatever is in the box, so what you preview is what will
 * be saved — not what was saved last time.
 */
function LayoutModal({ vendor, template, onClose, onSaved }) {
  const [json, setJson] = useState(template ? JSON.stringify(template, null, 2) : '');
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);   // 'preview' | 'save'
  const [error, setError] = useState(null);

  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);

  const parse = () => {
    if (!json.trim()) return null;
    try { return JSON.parse(json); }
    catch { throw new ApiError({ message: 'That is not valid JSON.' }, 400); }
  };

  async function doPreview() {
    setError(null); setBusy('preview');
    try {
      const url = await api.previewTemplate(vendor.id, parse());
      if (preview) URL.revokeObjectURL(preview);
      setPreview(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(null); }
  }

  async function save() {
    setError(null); setBusy('save');
    try {
      await api.saveVendorTemplate(vendor.id, parse());
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
      setBusy(null);
    }
  }

  return (
    <Modal
      title={`${vendor.name}'s invoice layout`}
      subtitle="Produce the template from their blank letterhead and one old invoice, then paste it here."
      onClose={onClose}
      size="xl"
      locked={!!busy}
      actions={
        <>
          <button onClick={onClose} disabled={!!busy} style={button('ghost', !!busy)}>Cancel</button>
          <button onClick={doPreview} disabled={!!busy} style={button('ghost', !!busy)}>
            {busy === 'preview' ? 'Rendering…' : 'Preview specimen'}
          </button>
          <button onClick={save} disabled={!!busy || !json.trim()} style={button('primary', !!busy || !json.trim())}>
            {busy === 'save' ? 'Saving…' : 'Save layout'}
          </button>
        </>
      }
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <code style={{
        display: 'block', margin: '0 0 14px', padding: '9px 12px', color: T.text, fontSize: 12,
        background: T.bg, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, fontFamily: MONO,
        overflowX: 'auto', whiteSpace: 'nowrap',
      }}>
        python scripts/extract-template.py blank.pdf --code {vendor.code} --blank --layout old-invoice.pdf
      </code>
      <div style={{ display: 'grid', gridTemplateColumns: preview ? 'minmax(280px, 1fr) minmax(320px, 1.2fr)' : '1fr', gap: 18 }}>
        <Field label="Template JSON" hint="Leave empty to use the default layout." style={{ marginBottom: 0 }}>
          <textarea
            style={{
              ...inputStyle, minHeight: preview ? 560 : 320, resize: 'vertical',
              fontFamily: MONO, fontSize: 12, lineHeight: 1.5,
            }}
            value={json}
            autoFocus
            onChange={(e) => setJson(e.target.value)}
            placeholder={`Paste assets/${vendor.code}/template.json`}
          />
        </Field>
        {preview && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: T.textDim }}>Specimen</span>
              <a href={preview} target="_blank" rel="noreferrer" style={{ color: T.blue, fontSize: 13 }}>Open full size</a>
            </div>
            <iframe title="Template specimen" src={preview}
                    style={{ width: '100%', height: 560, border: `1px solid ${T.border}`, borderRadius: T.radiusSm, background: '#fff' }} />
          </div>
        )}
      </div>
    </Modal>
  );
}
