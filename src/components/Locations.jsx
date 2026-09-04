import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, MONO, input as inputStyle } from '../theme.js';
import {
  Card, Field, FormGrid, Table, Tr, Td, RowActions, Banner, Modal, Confirm,
  Details, Status, PageHeader, SubTabs, button,
} from './Shell.jsx';
import { api, ApiError } from '../api.js';
import Audit from './Audit.jsx';
import Branding from './Branding.jsx';
import { naira } from '../../shared/reference.js';

/**
 * Locations and platform settings, owned by the client admin.
 *
 * Codes are immutable and the UI says so: they are written as plain text onto
 * every request and invoice, so changing one would orphan history. Names are
 * editable, and deactivating removes a location from the request form without
 * touching anything already raised against it.
 *
 * Request types are not editable here on purpose — they carry behaviour, not
 * just labels, and one added without its duplicate-guard index would have no
 * duplicate protection at all.
 *
 * Every panel shows what is currently true. Changing it opens a dialog.
 */
export default function Locations({ feeKobo, orgName, logo, favicon, onSaved }) {
  const [sub, setSub]       = useState('locations');
  const [ref, setRef]       = useState(null);
  const [fonts, setFonts]   = useState([]);
  const [ssoCfg, setSsoCfg] = useState(null);
  const [numbering, setNumbering] = useState(null);
  const [busy, setBusy]     = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError]   = useState(null);
  const [ok, setOk]         = useState(null);

  // Which dialog is open. One at a time; each is a small, complete task.
  const [dialog, setDialog] = useState(null);   // { kind, ...payload }

  const load = useCallback(async () => {
    try {
      setRef(await api.reference());
      setFonts((await api.fonts()).fonts || []);
      setNumbering(await api.numbering());
      setSsoCfg(await api.ssoConfig());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load settings.');
      setRef({ businessUnits: [], sites: [], buSites: {} });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function run(fn, id) {
    setError(null); setOk(null); setBusyId(id ?? null); setBusy(true);
    try {
      const msg = await fn();
      if (msg) setOk(msg);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
      return false;
    } finally { setBusy(false); setBusyId(null); }
  }

  const close = () => setDialog(null);
  /** Close the dialog, then report and reload. */
  const finish = async (msg) => { close(); await run(async () => msg); };

  const sites = ref?.sites ?? [];
  const bus = ref?.businessUnits ?? [];
  const buSites = ref?.buSites ?? {};
  const busFor = (code) => bus.filter((b) => (buSites[b.code] || []).includes(code));

  const PANES = {
    locations: <>
      <Card
        title="Locations"
        subtitle="Codes are permanent — they are written onto every request and invoice. Names can be changed freely. Deactivating hides a location from the request form; requests already raised against it are untouched."
        right={
          <button onClick={() => setDialog({ kind: 'site' })} style={button('primary', false, 'sm')}>
            <span style={{ fontSize: 16, lineHeight: 0.8 }}>+</span> Add location
          </button>
        }
      >
        <Table head={['Code', 'Name', 'Billed by', 'Status', '']}
               loading={!ref}
               empty={{
                 title: 'No locations yet',
                 hint: 'A location must exist before anyone can raise a request against it.',
                 action: <button onClick={() => setDialog({ kind: 'site' })} style={button('primary')}>Add the first location</button>,
               }}>
          {sites.map((s) => {
            const off = s.status !== 'active';
            return (
              <Tr key={s.code} dimmed={off}>
                <Td mono>{s.code}</Td>
                <Td>{s.name}</Td>
                <Td dim>{busFor(s.code).map((b) => b.code).join(', ') || '—'}</Td>
                <Td><Status value={off ? 'inactive' : 'active'} color={off ? T.textDim : T.green} /></Td>
                <RowActions>
                  <button onClick={() => setDialog({ kind: 'site', site: s })} style={button('ghost', false, 'sm')}>Edit</button>
                  <button disabled={busyId === s.code}
                          onClick={() => setDialog({ kind: 'toggle-site', site: s })}
                          style={button(off ? 'ghost' : 'danger', busyId === s.code, 'sm')}>
                    {off ? 'Activate' : 'Deactivate'}
                  </button>
                </RowActions>
              </Tr>
            );
          })}
        </Table>
      </Card>

      <Card
        title="Business units"
        subtitle="A unit groups the locations it is billed for and supplies the numbering site for unit-wide requests."
        right={
          <button onClick={() => setDialog({ kind: 'bu' })} style={button('primary', false, 'sm')}>
            <span style={{ fontSize: 16, lineHeight: 0.8 }}>+</span> Add business unit
          </button>
        }
      >
        <Table head={['Code', 'Name', 'Numbering site', 'Locations', 'Status', '']}
               loading={!ref}
               empty={{
                 title: 'No business units yet',
                 action: <button onClick={() => setDialog({ kind: 'bu' })} style={button('primary')}>Add the first unit</button>,
               }}>
          {bus.map((b) => {
            const off = b.status !== 'active';
            return (
              <Tr key={b.code} dimmed={off}>
                <Td mono>{b.code}</Td>
                <Td>{b.name}</Td>
                <Td mono dim>{b.numbering_site}</Td>
                <Td dim>{(buSites[b.code] || []).join(', ') || '—'}</Td>
                <Td><Status value={off ? 'inactive' : 'active'} color={off ? T.textDim : T.green} /></Td>
                <RowActions>
                  <button onClick={() => setDialog({ kind: 'bu', bu: b })} style={button('ghost', false, 'sm')}>Edit</button>
                  <button disabled={busyId === b.code}
                          onClick={() => setDialog({ kind: 'toggle-bu', bu: b })}
                          style={button(off ? 'ghost' : 'danger', busyId === b.code, 'sm')}>
                    {off ? 'Activate' : 'Deactivate'}
                  </button>
                </RowActions>
              </Tr>
            );
          })}
        </Table>
      </Card>

      <Card
        title="Which locations each unit may bill for"
        subtitle="A location can belong to more than one unit — Lekki is billed by both RFC and Retail. Ticking applies immediately."
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', font: `14px ${FONT}` }}>
            <thead>
              <tr>
                <th style={{ padding: '8px 12px', textAlign: 'left', color: T.textDim, fontSize: 11 }} />
                {bus.map((b) => (
                  <th key={b.code} style={{
                    padding: '8px 12px', color: T.textDim, fontSize: 11,
                    fontWeight: 700, letterSpacing: 0.5, fontFamily: MONO,
                  }}>{b.code}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <Tr key={s.code}>
                  <Td>{s.name} <span style={{ color: T.textDim, fontFamily: MONO, fontSize: 12 }}>{s.code}</span></Td>
                  {bus.map((b) => {
                    const on = (buSites[b.code] || []).includes(s.code);
                    return (
                      <td key={b.code} style={{ padding: '6px 12px', textAlign: 'center', borderBottom: `1px solid ${T.borderSoft}` }}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy}
                          style={{ width: 16, height: 16, cursor: 'pointer' }}
                          onChange={() => run(() => api.linkBuSite(b.code, s.code, !on))}
                        />
                      </td>
                    );
                  })}
                </Tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>,

    organisation: <>
      <Card
        title="Organisation"
        subtitle="Your organisation's name is shown in the header and printed as the salutation on every invoice issued from this deployment. The fee is a placeholder shown to requesters; the fee actually billed belongs to whichever vendor approves."
        right={<button onClick={() => setDialog({ kind: 'org' })} style={button('ghost', false, 'sm')}>Edit</button>}
      >
        <Details rows={[
          ['Organisation name', orgName],
          ['Indicative processing fee', naira(feeKobo ?? 0)],
        ]} />
      </Card>
      <Branding orgName={orgName} feeKobo={feeKobo} logo={logo} favicon={favicon} onSaved={onSaved} />
    </>,

    invoicing: <>
      <Card
        title="Invoice numbering"
        subtitle="Invoice numbers must never repeat: your approvals system already holds the ones issued so far and rejects a duplicate, which blocks a legitimate payment. The floor matters when the system is rebuilt somewhere else without its data — set it above every number ever issued and a fresh deployment cannot reissue one."
        right={<button onClick={() => setDialog({ kind: 'floor' })} disabled={!numbering} style={button('ghost', !numbering, 'sm')}>Raise the floor</button>}
      >
        <Details rows={[
          ['Highest sequence issued here', numbering ? String(numbering.highestSeq) : 'Loading…', true],
          ['Most recent invoice', numbering ? (numbering.latestInvoiceNo || 'none yet') : 'Loading…', true],
          ['Current floor', numbering ? (numbering.seqFloor || 'none') : 'Loading…', true],
        ]} />
      </Card>

      <Card
        title="Fonts"
        subtitle="Assigned to a vendor so their invoice matches their own stationery. Metric-compatible options have the same character widths as the face they stand in for. Everything here is self-hosted; nothing is fetched from a font service when an invoice is rendered."
        right={
          <button onClick={() => setDialog({ kind: 'font' })} style={button('primary', false, 'sm')}>
            <span style={{ fontSize: 16, lineHeight: 0.8 }}>+</span> Upload a font
          </button>
        }
      >
        <Table head={['Font', 'Stands in for', 'Kind', 'Source', '']}
               empty={{
                 title: 'No fonts loaded',
                 hint: 'Run scripts/fetch-fonts.mjs to pull the bundled catalogue, or upload one.',
               }}>
          {fonts.map((f) => (
            <Tr key={f.key}>
              <Td>{f.name} <span style={{ color: T.textDim, fontFamily: MONO, fontSize: 12 }}>{f.key}</span></Td>
              <Td dim>{f.metricOf || '—'}</Td>
              <Td dim>{f.kind}</Td>
              <Td dim>{f.builtin ? 'bundled' : 'uploaded'}</Td>
              <RowActions>
                {!f.builtin && (
                  <button disabled={busyId === f.key}
                          onClick={() => setDialog({ kind: 'remove-font', font: f })}
                          style={button('danger', busyId === f.key, 'sm')}>Remove</button>
                )}
              </RowActions>
            </Tr>
          ))}
        </Table>
      </Card>
    </>,

    audit: <Audit />,

    signin: <>
      <Card
        title="Staff single sign-on"
        subtitle="Optional. Until it is set up, your staff sign in with a password. Vendors always use a password — they are not in your directory — so this only ever affects your own people. Switching it on does not cut passwords off straight away; that happens the first time somebody actually completes a sign-on, so a wrong setting cannot lock you out."
        right={<button onClick={() => setDialog({ kind: 'sso' })} disabled={!ssoCfg} style={button('ghost', !ssoCfg, 'sm')}>Edit sign-on settings</button>}
      >
        {ssoCfg && (
          <Details rows={[
            ['Single sign-on', <Status value={ssoCfg.enabled ? 'on' : 'off'} color={ssoCfg.enabled ? T.green : T.textDim} />],
            ['Proven to work', <Status value={ssoCfg.verified ? `yes · ${ssoCfg.verifiedAt}` : 'not yet'} color={ssoCfg.verified ? T.green : T.amber} />],
            ['Staff password sign-in', <Status value={ssoCfg.clientPassword ? 'still available' : 'disabled'} color={ssoCfg.clientPassword ? T.amber : T.green} />],
            ['Team domain', ssoCfg.teamDomain, true],
            ['Application AUD', ssoCfg.aud, true],
            ['Allowed email domains', ssoCfg.allowedDomains, true],
          ]} />
        )}
      </Card>
    </>,
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="Locations, the organisation's own details, invoice numbering and fonts, sign-in, and the audit trail."
      />
      <SubTabs
        tabs={[
          ['locations', 'Locations & units'],
          ['organisation', 'Organisation'],
          ['invoicing', 'Invoicing'],
          ['signin', 'Sign-in'],
          ['audit', 'Audit trail'],
        ]}
        active={sub}
        onChange={setSub}
      />
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>
      {PANES[sub]}

      {dialog?.kind === 'site' && (
        <SiteModal site={dialog.site} bus={bus} onClose={close}
                   onSaved={(name) => finish(`${name} ${dialog.site ? 'updated' : 'added'}.`)} />
      )}
      {dialog?.kind === 'bu' && (
        <BuModal bu={dialog.bu} sites={sites} onClose={close}
                 onSaved={(name) => finish(`${name} ${dialog.bu ? 'updated' : 'added'}.`)} />
      )}
      {dialog?.kind === 'toggle-site' && (
        <Confirm
          title={dialog.site.status === 'active' ? `Deactivate ${dialog.site.name}?` : `Activate ${dialog.site.name}?`}
          confirmLabel={dialog.site.status === 'active' ? 'Deactivate' : 'Activate'}
          kind={dialog.site.status === 'active' ? 'danger' : 'primary'}
          busy={busy}
          onClose={close}
          onConfirm={async () => {
            const s = dialog.site;
            const next = s.status === 'active' ? 'disabled' : 'active';
            const done = await run(() => api.updateSite(s.code, { name: s.name, status: next })
              .then(() => `${s.name} ${next === 'active' ? 'activated' : 'deactivated'}.`), s.code);
            if (done) close();
          }}
        >
          {dialog.site.status === 'active'
            ? <>It disappears from the request form. Requests already raised against it are untouched, and it can be activated again later.</>
            : <>It becomes available on the request form again.</>}
        </Confirm>
      )}
      {dialog?.kind === 'toggle-bu' && (
        <Confirm
          title={dialog.bu.status === 'active' ? `Deactivate ${dialog.bu.name}?` : `Activate ${dialog.bu.name}?`}
          confirmLabel={dialog.bu.status === 'active' ? 'Deactivate' : 'Activate'}
          kind={dialog.bu.status === 'active' ? 'danger' : 'primary'}
          busy={busy}
          onClose={close}
          onConfirm={async () => {
            const b = dialog.bu;
            const next = b.status === 'active' ? 'disabled' : 'active';
            const done = await run(() => api.updateBu(b.code, { name: b.name, status: next })
              .then(() => `${b.name} ${next === 'active' ? 'activated' : 'deactivated'}.`), b.code);
            if (done) close();
          }}
        >
          {dialog.bu.status === 'active'
            ? <>Nobody can raise a request for this unit until it is activated again. Existing requests are untouched.</>
            : <>Requests can be raised for this unit again.</>}
        </Confirm>
      )}
      {dialog?.kind === 'org' && (
        <OrgModal orgName={orgName} feeKobo={feeKobo} onClose={close}
                  onSaved={async (cfg) => { onSaved?.(cfg); await finish('Saved.'); }} />
      )}
      {dialog?.kind === 'floor' && numbering && (
        <FloorModal numbering={numbering} feeKobo={feeKobo} onClose={close}
                    onSaved={async (cfg) => { onSaved?.(cfg); await finish('Floor raised.'); }} />
      )}
      {dialog?.kind === 'font' && (
        <FontModal onClose={close} onSaved={(name) => finish(`${name} added and available to every vendor.`)} />
      )}
      {dialog?.kind === 'remove-font' && (
        <Confirm
          title={`Remove ${dialog.font.name}?`}
          confirmLabel="Remove font"
          kind="danger"
          busy={busy}
          onClose={close}
          onConfirm={async () => {
            const f = dialog.font;
            const done = await run(async () => { await api.deleteFont(f.key); return `${f.name} removed.`; }, f.key);
            if (done) close();
          }}
        >
          It is deleted from storage. A font a vendor is still using cannot be
          removed — change their layout first.
        </Confirm>
      )}
      {dialog?.kind === 'sso' && ssoCfg && (
        <SsoModal cfg={ssoCfg} onClose={close}
                  onSaved={(cfg) => finish(cfg.enabled
                    ? 'Single sign-on is on. Staff passwords keep working until someone signs in with it successfully.'
                    : 'Single sign-on is off. Staff sign in with a password.')} />
      )}
    </>
  );
}

/** Shared shape for the small edit dialogs: form, busy flag, error banner. */
function useSubmit(fn) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (e) => {
    e?.preventDefault();
    setError(null); setBusy(true);
    try { await fn(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Network problem. Try again.'); setBusy(false); }
  };
  return { busy, error, setError, submit };
}

function SiteModal({ site, bus, onClose, onSaved }) {
  const editing = !!site;
  const [form, setForm] = useState({ code: site?.code ?? '', name: site?.name ?? '', bu_code: '' });
  const { busy, error, setError, submit } = useSubmit(async () => {
    if (editing) await api.updateSite(site.code, { name: form.name.trim() });
    else await api.createSite({ ...form, code: form.code.trim(), name: form.name.trim() });
    await onSaved(form.name.trim());
  });
  const ready = form.name.trim() && (editing || form.code.trim());

  return (
    <Modal title={editing ? `Edit ${site.name}` : 'Add a location'} onClose={onClose} size="sm" locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="site-form" disabled={busy || !ready} style={button('primary', busy || !ready)}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Add location'}
          </button>
        </>
      }>
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="site-form" onSubmit={submit}>
        <Field label="Code" hint={editing ? 'Permanent — it is written onto every request and invoice.' : '2–8 characters. Permanent once saved.'}>
          <input style={{ ...inputStyle, fontFamily: MONO }} value={form.code} disabled={editing} autoFocus={!editing}
                 onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })}
                 placeholder="IKJ" />
        </Field>
        <Field label="Name">
          <input style={inputStyle} value={form.name} autoFocus={editing}
                 onChange={(e) => setForm({ ...form, name: e.target.value })}
                 placeholder="Ikeja Clinic" />
        </Field>
        {!editing && (
          <Field label="Billed by" hint="You can attach more units afterwards from the matrix." style={{ marginBottom: 0 }}>
            <select style={inputStyle} value={form.bu_code}
                    onChange={(e) => setForm({ ...form, bu_code: e.target.value })}>
              <option value="">— none yet —</option>
              {bus.map((b) => <option key={b.code} value={b.code}>{b.code} — {b.name}</option>)}
            </select>
          </Field>
        )}
      </form>
    </Modal>
  );
}

function BuModal({ bu, sites, onClose, onSaved }) {
  const editing = !!bu;
  const [form, setForm] = useState({ code: bu?.code ?? '', name: bu?.name ?? '', numbering_site: bu?.numbering_site ?? '' });
  const { busy, error, setError, submit } = useSubmit(async () => {
    if (editing) await api.updateBu(bu.code, { name: form.name.trim(), numbering_site: form.numbering_site });
    else await api.createBu({ ...form, code: form.code.trim(), name: form.name.trim() });
    await onSaved(form.name.trim());
  });
  const ready = form.name.trim() && form.numbering_site && (editing || form.code.trim());

  return (
    <Modal title={editing ? `Edit ${bu.name}` : 'Add a business unit'} onClose={onClose} size="sm" locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="bu-form" disabled={busy || !ready} style={button('primary', busy || !ready)}>
            {busy ? 'Saving…' : editing ? 'Save' : 'Add business unit'}
          </button>
        </>
      }>
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="bu-form" onSubmit={submit}>
        <Field label="Code" hint="Permanent.">
          <input style={{ ...inputStyle, fontFamily: MONO }} value={form.code} disabled={editing} autoFocus={!editing}
                 onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="RFC" />
        </Field>
        <Field label="Name">
          <input style={inputStyle} value={form.name} autoFocus={editing}
                 onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        {/* BU-scope requests store site_code NULL and borrow this for the
            invoice ref, so it must always point at a real site. */}
        <Field label="Numbering site" hint="Used in the invoice reference for unit-wide requests." style={{ marginBottom: 0 }}>
          <select style={inputStyle} value={form.numbering_site}
                  onChange={(e) => setForm({ ...form, numbering_site: e.target.value })}>
            <option value="">— pick one —</option>
            {sites.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
          </select>
        </Field>
      </form>
    </Modal>
  );
}

function OrgModal({ orgName, feeKobo, onClose, onSaved }) {
  const [org, setOrg] = useState(orgName ?? '');
  const [fee, setFee] = useState(String((feeKobo ?? 0) / 100));
  const { busy, error, setError, submit } = useSubmit(async () => {
    const { config } = await api.savePlatformConfig({
      default_fee_kobo: Math.round(Number(fee) * 100),
      org_name: org.trim() || undefined,
    });
    await onSaved(config);
  });
  const ready = org.trim() && fee !== '' && Number(fee) >= 0;

  return (
    <Modal title="Organisation" onClose={onClose} size="sm" locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="org-form" disabled={busy || !ready} style={button('primary', busy || !ready)}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }>
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="org-form" onSubmit={submit}>
        <Field label="Organisation name" hint="Header and invoice salutation.">
          <input style={inputStyle} value={org} autoFocus onChange={(e) => setOrg(e.target.value)} placeholder="Example Group" />
        </Field>
        <Field label="Indicative processing fee (₦)" hint="Shown to requesters so they see a total. The fee actually billed is the approving vendor's." style={{ marginBottom: 0 }}>
          <input style={inputStyle} type="number" min="0" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function FloorModal({ numbering, feeKobo, onClose, onSaved }) {
  const [floor, setFloor] = useState(String(numbering.seqFloor ?? 0));
  const { busy, error, setError, submit } = useSubmit(async () => {
    const { config } = await api.savePlatformConfig({
      default_fee_kobo: feeKobo ?? 0,
      seq_floor: Number(floor),
    });
    await onSaved(config);
  });
  const n = Number(floor);
  const ready = floor !== '' && Number.isInteger(n) && n >= (numbering.seqFloor ?? 0);

  return (
    <Modal title="Raise the sequence floor" onClose={onClose} size="sm" locked={busy}
      subtitle="Can only be raised. Leave at 0 on a first deployment."
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="floor-form" disabled={busy || !ready} style={button('primary', busy || !ready)}>
            {busy ? 'Saving…' : 'Set floor'}
          </button>
        </>
      }>
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="floor-form" onSubmit={submit}>
        <Field label="Start sequences above"
               hint={`Highest issued here: ${numbering.highestSeq}. Current floor: ${numbering.seqFloor || 'none'}.`}
               error={floor !== '' && n < (numbering.seqFloor ?? 0) ? 'The floor can only be raised.' : undefined}
               style={{ marginBottom: 0 }}>
          <input style={{ ...inputStyle, fontFamily: MONO }} type="number" min={numbering.seqFloor ?? 0} autoFocus
                 value={floor} onChange={(e) => setFloor(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function FontModal({ onClose, onSaved }) {
  const [font, setFont] = useState({ key: '', name: '', kind: 'sans', metric_of: '' });
  const [files, setFiles] = useState({ regular: null, bold: null });
  const { busy, error, setError, submit } = useSubmit(async () => {
    const form = new FormData();
    form.set('key', font.key.trim().toLowerCase());
    form.set('name', font.name.trim());
    form.set('kind', font.kind);
    if (font.metric_of.trim()) form.set('metric_of', font.metric_of.trim());
    form.set('regular', files.regular);
    form.set('bold', files.bold);
    const { font: made } = await api.uploadFont(form);
    await onSaved(made.name);
  });
  const ready = font.key.trim() && font.name.trim() && files.regular && files.bold;

  return (
    <Modal title="Upload a font" onClose={onClose} locked={busy}
      subtitle="For stationery the bundled list does not cover. Both weights are required, and each is checked for the characters an invoice needs — a font without the ₦ sign is rejected here, because at render time it would drop the symbol silently rather than fail."
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="font-form" disabled={busy || !ready} style={button('primary', busy || !ready)}>
            {busy ? 'Checking and uploading…' : 'Upload font'}
          </button>
        </>
      }>
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="font-form" onSubmit={submit}>
        <FormGrid>
          <Field label="Key" hint="Lowercase. Permanent.">
            <input style={{ ...inputStyle, fontFamily: MONO }} value={font.key} autoFocus
                   onChange={(e) => setFont({ ...font, key: e.target.value })} placeholder="housesans" />
          </Field>
          <Field label="Name">
            <input style={inputStyle} value={font.name}
                   onChange={(e) => setFont({ ...font, name: e.target.value })} placeholder="House Sans" />
          </Field>
          <Field label="Kind">
            <select style={inputStyle} value={font.kind}
                    onChange={(e) => setFont({ ...font, kind: e.target.value })}>
              <option value="sans">Sans</option>
              <option value="serif">Serif</option>
              <option value="mono">Mono</option>
            </select>
          </Field>
          <Field label="Stands in for" hint="Optional, e.g. Garamond.">
            <input style={inputStyle} value={font.metric_of}
                   onChange={(e) => setFont({ ...font, metric_of: e.target.value })} />
          </Field>
          <Field label="Regular (.ttf)">
            <input style={inputStyle} type="file" accept=".ttf,.otf"
                   onChange={(e) => setFiles({ ...files, regular: e.target.files?.[0] || null })} />
          </Field>
          <Field label="Bold (.ttf)">
            <input style={inputStyle} type="file" accept=".ttf,.otf"
                   onChange={(e) => setFiles({ ...files, bold: e.target.files?.[0] || null })} />
          </Field>
        </FormGrid>
      </form>
    </Modal>
  );
}

function SsoModal({ cfg, onClose, onSaved }) {
  const [sso, setSso] = useState({
    team_domain: cfg.teamDomain || '', aud: cfg.aud || '',
    allowed_domains: cfg.allowedDomains || '', enabled: !!cfg.enabled,
  });
  const { busy, error, setError, submit } = useSubmit(async () => {
    const saved = await api.saveSsoConfig(sso);
    await onSaved(saved);
  });

  return (
    <Modal title="Staff single sign-on" onClose={onClose} locked={busy}
      subtitle="Cloudflare Access in front of the staff sign-in. Vendors are unaffected."
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="sso-form" disabled={busy} style={button('primary', busy)}>
            {busy ? 'Saving…' : 'Save sign-on settings'}
          </button>
        </>
      }>
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="sso-form" onSubmit={submit}>
        <FormGrid min={230}>
          <Field label="Team domain" hint="From Cloudflare Zero Trust.">
            <input style={inputStyle} value={sso.team_domain} autoFocus
                   onChange={(e) => setSso({ ...sso, team_domain: e.target.value })}
                   placeholder="yourteam.cloudflareaccess.com" />
          </Field>
          <Field label="Application AUD tag" hint="From the Access application.">
            <input style={{ ...inputStyle, fontFamily: MONO }} value={sso.aud}
                   onChange={(e) => setSso({ ...sso, aud: e.target.value })} />
          </Field>
        </FormGrid>
        <Field label="Allowed email domains"
               hint="Comma separated, matched exactly. Only these get an account on first sign-in; list subdomains separately.">
          <input style={inputStyle} value={sso.allowed_domains}
                 onChange={(e) => setSso({ ...sso, allowed_domains: e.target.value })}
                 placeholder="yourcompany.com, mail.yourcompany.com" />
        </Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
          <input type="checkbox" checked={sso.enabled}
                 onChange={(e) => setSso({ ...sso, enabled: e.target.checked })} />
          Offer single sign-on on the login screen
        </label>
      </form>
    </Modal>
  );
}
