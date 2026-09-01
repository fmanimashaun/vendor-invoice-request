import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Field, Table, Td, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { naira } from '../../shared/reference.js';

const BLANK_SITE = { code: '', name: '', bu_code: '' };
const BLANK_BU = { code: '', name: '', numbering_site: '' };

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
 */
export default function Locations({ feeKobo, orgName, onSaved }) {
  const [ref, setRef]       = useState(null);
  const [site, setSite]     = useState(BLANK_SITE);
  const [bu, setBu]         = useState(BLANK_BU);
  const [fee, setFee]       = useState(String((feeKobo ?? 0) / 100));
  const [org, setOrg]       = useState(orgName ?? '');
  const [fonts, setFonts]   = useState([]);
  const [ssoCfg, setSsoCfg] = useState(null);
  const [sso, setSso]       = useState({ team_domain: '', aud: '', allowed_domains: '', enabled: false });
  const [font, setFont]     = useState({ key: '', name: '', kind: 'sans', metric_of: '' });
  const [fontFiles, setFontFiles] = useState({ regular: null, bold: null });
  const [busy, setBusy]     = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError]   = useState(null);
  const [ok, setOk]         = useState(null);

  const load = useCallback(async () => {
    try {
      setRef(await api.reference());
      setFonts((await api.fonts()).fonts || []);
      const cfg = await api.ssoConfig();
      setSsoCfg(cfg);
      setSso({
        team_domain: cfg.teamDomain || '', aud: cfg.aud || '',
        allowed_domains: cfg.allowedDomains || '', enabled: !!cfg.enabled,
      });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load locations.');
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
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(false); setBusyId(null); }
  }

  const addSite = (e) => {
    e.preventDefault();
    run(async () => {
      const { site: made } = await api.createSite(site);
      setSite(BLANK_SITE);
      return `${made.name} added.`;
    });
  };

  const addBu = (e) => {
    e.preventDefault();
    run(async () => {
      const { business_unit: made } = await api.createBu(bu);
      setBu(BLANK_BU);
      return `${made.name} added.`;
    });
  };

  const saveFee = (e) => {
    e.preventDefault();
    run(async () => {
      const kobo = Math.round(Number(fee) * 100);
      const { config } = await api.savePlatformConfig({
        default_fee_kobo: kobo,
        org_name: org.trim() || undefined,
      });
      onSaved?.(config);
      return 'Saved.';
    });
  };

  const addFont = (e) => {
    e.preventDefault();
    run(async () => {
      const form = new FormData();
      form.set('key', font.key.trim().toLowerCase());
      form.set('name', font.name.trim());
      form.set('kind', font.kind);
      if (font.metric_of.trim()) form.set('metric_of', font.metric_of.trim());
      form.set('regular', fontFiles.regular);
      form.set('bold', fontFiles.bold);
      const { font: made } = await api.uploadFont(form);
      setFont({ key: '', name: '', kind: 'sans', metric_of: '' });
      setFontFiles({ regular: null, bold: null });
      return `${made.name} added and available to every vendor.`;
    });
  };

  const saveSso = (e) => {
    e.preventDefault();
    run(async () => {
      const cfg = await api.saveSsoConfig(sso);
      setSsoCfg(cfg);
      return cfg.enabled
        ? 'Single sign-on is on. Staff passwords keep working until someone signs in with it successfully.'
        : 'Single sign-on is off. Staff sign in with a password.';
    });
  };

  const sites = ref?.sites ?? [];
  const bus = ref?.businessUnits ?? [];
  const buSites = ref?.buSites ?? {};
  const busFor = (code) => bus.filter((b) => (buSites[b.code] || []).includes(code));

  return (
    <>
      <Card title="Locations">
        <Banner onClose={() => setError(null)}>{error}</Banner>
        <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Codes are permanent — they are written onto every request and invoice.
          Names can be changed freely. Deactivating a location hides it from the
          request form; requests already raised against it are untouched.
        </p>

        <Table head={['Code', 'Name', 'Billed by', 'Status', '']}
               empty={ref && sites.length === 0 ? 'No locations yet.' : null}>
          {sites.map((s) => {
            const off = s.status !== 'active';
            return (
              <tr key={s.code} style={{ opacity: off ? 0.5 : 1 }}>
                <Td mono>{s.code}</Td>
                <Td>
                  <input
                    style={{ ...inputStyle, padding: '5px 8px' }}
                    defaultValue={s.name}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name && name !== s.name) run(() => api.updateSite(s.code, { name }), s.code);
                    }}
                  />
                </Td>
                <Td dim>{busFor(s.code).map((b) => b.code).join(', ') || '—'}</Td>
                <Td dim>{off ? 'inactive' : 'active'}</Td>
                <Td right>
                  <button disabled={busyId === s.code}
                          onClick={() => run(() => api.updateSite(s.code,
                            { name: s.name, status: off ? 'active' : 'disabled' }), s.code)}
                          style={button('ghost', busyId === s.code)}>
                    {off ? 'Activate' : 'Deactivate'}
                  </button>
                </Td>
              </tr>
            );
          })}
        </Table>

        <form onSubmit={addSite} style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '0 16px' }}>
            <Field label="Code" hint="2–8 characters. Permanent.">
              <input style={inputStyle} value={site.code}
                     onChange={(e) => setSite({ ...site, code: e.target.value.toUpperCase() })}
                     placeholder="IKJ" />
            </Field>
            <Field label="Name">
              <input style={inputStyle} value={site.name}
                     onChange={(e) => setSite({ ...site, name: e.target.value })}
                     placeholder="Ikeja Clinic" />
            </Field>
            <Field label="Billed by" hint="You can attach more below.">
              <select style={inputStyle} value={site.bu_code}
                      onChange={(e) => setSite({ ...site, bu_code: e.target.value })}>
                <option value="">— none yet —</option>
                {bus.map((b) => <option key={b.code} value={b.code}>{b.code} — {b.name}</option>)}
              </select>
            </Field>
          </div>
          <button type="submit" disabled={busy || !site.code || !site.name}
                  style={button('primary', busy || !site.code || !site.name)}>
            Add location
          </button>
        </form>
      </Card>

      <Card title="Business units">
        <Table head={['Code', 'Name', 'Numbering site', 'Locations', 'Status', '']}
               empty={ref && bus.length === 0 ? 'No business units yet.' : null}>
          {bus.map((b) => {
            const off = b.status !== 'active';
            return (
              <tr key={b.code} style={{ opacity: off ? 0.5 : 1 }}>
                <Td mono>{b.code}</Td>
                <Td>
                  <input
                    style={{ ...inputStyle, padding: '5px 8px' }}
                    defaultValue={b.name}
                    onBlur={(e) => {
                      const name = e.target.value.trim();
                      if (name && name !== b.name) run(() => api.updateBu(b.code, { name }), b.code);
                    }}
                  />
                </Td>
                {/* BU-scope requests store site_code NULL and borrow this for
                    the invoice ref, so it must always point at a real site. */}
                <Td>
                  <select style={{ ...inputStyle, padding: '5px 8px' }} defaultValue={b.numbering_site}
                          onChange={(e) => run(() => api.updateBu(b.code,
                            { name: b.name, numbering_site: e.target.value }), b.code)}>
                    {sites.map((s) => <option key={s.code} value={s.code}>{s.code}</option>)}
                  </select>
                </Td>
                <Td dim>{(buSites[b.code] || []).join(', ') || '—'}</Td>
                <Td dim>{off ? 'inactive' : 'active'}</Td>
                <Td right>
                  <button disabled={busyId === b.code}
                          onClick={() => run(() => api.updateBu(b.code,
                            { name: b.name, status: off ? 'active' : 'disabled' }), b.code)}
                          style={button('ghost', busyId === b.code)}>
                    {off ? 'Activate' : 'Deactivate'}
                  </button>
                </Td>
              </tr>
            );
          })}
        </Table>

        <form onSubmit={addBu} style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 18 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '0 16px' }}>
            <Field label="Code" hint="Permanent.">
              <input style={inputStyle} value={bu.code}
                     onChange={(e) => setBu({ ...bu, code: e.target.value.toUpperCase() })} />
            </Field>
            <Field label="Name">
              <input style={inputStyle} value={bu.name}
                     onChange={(e) => setBu({ ...bu, name: e.target.value })} />
            </Field>
            <Field label="Numbering site" hint="Used in the ref for unit-wide requests.">
              <select style={inputStyle} value={bu.numbering_site}
                      onChange={(e) => setBu({ ...bu, numbering_site: e.target.value })}>
                <option value="">— pick one —</option>
                {sites.map((s) => <option key={s.code} value={s.code}>{s.code} — {s.name}</option>)}
              </select>
            </Field>
          </div>
          <button type="submit" disabled={busy || !bu.code || !bu.name || !bu.numbering_site}
                  style={button('primary', busy || !bu.code || !bu.name || !bu.numbering_site)}>
            Add business unit
          </button>
        </form>
      </Card>

      <Card title="Which locations each unit may bill for">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          A location can belong to more than one unit — Lekki is billed by both
          RFC and Retail.
        </p>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', font: `14px ${FONT}` }}>
            <thead>
              <tr>
                <th style={{ padding: '8px 10px', textAlign: 'left', color: T.textDim, fontSize: 11 }} />
                {bus.map((b) => (
                  <th key={b.code} style={{
                    padding: '8px 10px', color: T.textDim, fontSize: 11,
                    fontWeight: 700, letterSpacing: 0.5,
                  }}>{b.code}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.code}>
                  <Td>{s.name} <span style={{ color: T.textDim }}>({s.code})</span></Td>
                  {bus.map((b) => {
                    const on = (buSites[b.code] || []).includes(s.code);
                    return (
                      <td key={b.code} style={{ padding: '6px 10px', textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={busy}
                          onChange={() => run(() => api.linkBuSite(b.code, s.code, !on))}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="Staff single sign-on">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 6px', lineHeight: 1.5 }}>
          Optional. Until it is set up, your staff sign in with a password.
          Vendors always use a password — they are not in your directory — so
          this only ever affects your own people.
        </p>
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
          Switching it on does <strong style={{ color: T.text }}>not</strong> cut
          passwords off straight away. That happens automatically the first time
          somebody actually completes a sign-on, so a wrong setting cannot lock
          you out of your own admin.
        </p>

        {ssoCfg && (
          <div style={{
            border: `1px solid ${T.border}`, borderRadius: 8, padding: '10px 13px',
            marginBottom: 16, fontSize: 13, color: T.textDim, lineHeight: 1.6,
          }}>
            <div>Single sign-on: <strong style={{ color: ssoCfg.enabled ? T.green : T.textDim }}>
              {ssoCfg.enabled ? 'on' : 'off'}</strong></div>
            <div>Proven to work: <strong style={{ color: ssoCfg.verified ? T.green : T.amber }}>
              {ssoCfg.verified ? `yes, ${ssoCfg.verifiedAt}` : 'not yet'}</strong></div>
            <div>Staff password sign-in: <strong style={{ color: ssoCfg.clientPassword ? T.amber : T.green }}>
              {ssoCfg.clientPassword ? 'still available' : 'disabled'}</strong></div>
          </div>
        )}

        <form onSubmit={saveSso}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(230px,1fr))', gap: '0 16px' }}>
            <Field label="Team domain" hint="From Cloudflare Zero Trust.">
              <input style={inputStyle} value={sso.team_domain}
                     onChange={(e) => setSso({ ...sso, team_domain: e.target.value })}
                     placeholder="yourteam.cloudflareaccess.com" />
            </Field>
            <Field label="Application AUD tag" hint="From the Access application.">
              <input style={inputStyle} value={sso.aud}
                     onChange={(e) => setSso({ ...sso, aud: e.target.value })} />
            </Field>
            <Field label="Allowed email domains"
                   hint="Comma separated. Only these get an account on first sign-in.">
              <input style={inputStyle} value={sso.allowed_domains}
                     onChange={(e) => setSso({ ...sso, allowed_domains: e.target.value })}
                     placeholder="yourcompany.com" />
            </Field>
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '0 0 16px', fontSize: 14 }}>
            <input type="checkbox" checked={sso.enabled}
                   onChange={(e) => setSso({ ...sso, enabled: e.target.checked })} />
            Offer single sign-on on the login screen
          </label>
          <button type="submit" disabled={busy} style={button('primary', busy)}>
            Save sign-on settings
          </button>
        </form>
      </Card>

      <Card title="Fonts">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Assigned to a vendor during onboarding so their invoice matches their
          own stationery. Metric-compatible options have the same character
          widths as the face they stand in for, so line breaks land where the
          vendor's own document puts them. Everything here is self-hosted;
          nothing is fetched from a font service when an invoice is rendered.
        </p>
        <Table head={['Font', 'Stands in for', 'Kind', 'Source', '']}
               empty={fonts.length === 0 ? 'No fonts loaded.' : null}>
          {fonts.map((f) => (
            <tr key={f.key}>
              <Td>{f.name} <span style={{ color: T.textDim }}>({f.key})</span></Td>
              <Td dim>{f.metricOf || '—'}</Td>
              <Td dim>{f.kind}</Td>
              <Td dim>{f.builtin ? 'bundled' : 'uploaded'}</Td>
              <Td right>
                {!f.builtin && (
                  <button disabled={busyId === f.key}
                          onClick={() => run(async () => {
                            await api.deleteFont(f.key);
                            setFonts((await api.fonts()).fonts || []);
                            return `${f.name} removed.`;
                          }, f.key)}
                          style={button('ghost', busyId === f.key)}>Remove</button>
                )}
              </Td>
            </tr>
          ))}
        </Table>

        <form onSubmit={addFont} style={{ marginTop: 18, borderTop: `1px solid ${T.border}`, paddingTop: 18 }}>
          <h3 style={{ margin: '0 0 6px', font: `600 14px ${FONT}`, color: T.text }}>
            Upload a font
          </h3>
          <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
            For stationery the bundled list does not cover. Both weights are
            required, and each is checked for the characters an invoice needs —
            a font without the ₦ sign is rejected here, because at render time
            it would drop the symbol silently rather than fail.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '0 16px' }}>
            <Field label="Key" hint="Lowercase. Permanent.">
              <input style={inputStyle} value={font.key}
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
                     onChange={(e) => setFontFiles({ ...fontFiles, regular: e.target.files?.[0] || null })} />
            </Field>
            <Field label="Bold (.ttf)">
              <input style={inputStyle} type="file" accept=".ttf,.otf"
                     onChange={(e) => setFontFiles({ ...fontFiles, bold: e.target.files?.[0] || null })} />
            </Field>
          </div>
          <button type="submit"
                  disabled={busy || !font.key || !font.name || !fontFiles.regular || !fontFiles.bold}
                  style={button('primary', busy || !font.key || !font.name || !fontFiles.regular || !fontFiles.bold)}>
            Upload font
          </button>
        </form>
      </Card>

      <Card title="Organisation">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Your organisation's name, as shown in the header and printed as the
          salutation on every invoice issued from this deployment. Nothing about
          any particular company is built into the code — this is where it is set.
        </p>
        <Field label="Organisation name">
          <input style={{ ...inputStyle, maxWidth: 360 }} value={org}
                 onChange={(e) => setOrg(e.target.value)} placeholder="Example Group" />
        </Field>
      </Card>

      <Card title="Indicative processing fee">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Shown on the request form so the requester sees a total. It is a
          placeholder: the fee actually billed belongs to whichever vendor
          approves the request, and is set by that vendor.
        </p>
        <form onSubmit={saveFee}>
          <Field label="Fee (₦)" hint={`Currently ${naira(feeKobo ?? 0)}.`}>
            <input style={{ ...inputStyle, maxWidth: 200 }} type="number" min="0" step="0.01"
                   value={fee} onChange={(e) => setFee(e.target.value)} />
          </Field>
          <button type="submit" disabled={busy} style={button('primary', busy)}>Save settings</button>
        </form>
      </Card>
    </>
  );
}
