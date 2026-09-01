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
  const [busy, setBusy]     = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError]   = useState(null);
  const [ok, setOk]         = useState(null);

  const load = useCallback(async () => {
    try {
      setRef(await api.reference());
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
