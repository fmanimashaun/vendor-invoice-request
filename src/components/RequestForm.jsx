import React, { useMemo, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Field, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import {
  REQUEST_TYPES, typeFor, siteNameIn, buNameIn, naira, periodLabel,
} from '../../shared/reference.js';

const thisPeriod = () => new Date().toISOString().slice(0, 7);

/** '75,000.50' or '75000' -> kobo. Returns null if unparseable. */
function toKobo(text) {
  const cleaned = String(text).replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, frac = ''] = cleaned.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

/**
 * `reference` is the live business-unit and site data from /api/bootstrap, not a code
 * constant: the client admin edits locations from Settings, and the form has
 * to follow. Only active rows are sent, so a disabled site cannot be picked.
 */
export default function RequestForm({ feeKobo, reference, onCreated }) {
  const businessUnits = reference?.businessUnits ?? [];
  const sites = reference?.sites ?? [];
  const buSites = reference?.buSites ?? {};

  const [buCode, setBuCode]   = useState(() => businessUnits[0]?.code ?? '');
  const [siteCode, setSite]   = useState(() => (buSites[businessUnits[0]?.code] ?? [])[0] ?? '');
  const [typeCode, setType]   = useState('ELEC');
  const [period, setPeriod]   = useState(thisPeriod());
  const [amount, setAmount]   = useState('');
  const [assetKey, setAsset]  = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const [existing, setExisting] = useState(null);
  // Warnings the server raised on the last attempt. Holding them here is what
  // turns a refusal into a confirm step: the same submit re-runs with
  // `confirm: true` and the server records what was overridden.
  const [warnings, setWarnings] = useState([]);
  const [ok, setOk]           = useState(null);

  const type = typeFor(typeCode);
  const permitted = useMemo(
    () => (buSites[buCode] || []).map((c) => sites.find((s) => s.code === c)).filter(Boolean),
    [buCode, buSites, sites],
  );
  const siteLocked = permitted.length === 1;
  const needsSite = type?.scope === 'SITE';

  // Keep the site valid when the BU changes; single-site BUs snap to their one.
  function changeBu(next) {
    setBuCode(next);
    const allowed = buSites[next] || [];
    if (!allowed.includes(siteCode)) setSite(allowed[0] ?? '');
  }

  const amountKobo = toKobo(amount);
  const totalKobo = amountKobo == null ? null : amountKobo + feeKobo;

  // Suggested description; the user can override it.
  const suggested = needsSite
    ? `${type?.label ?? ''} For ${siteNameIn(reference, siteCode)}`
    : `${type?.label ?? ''} For ${buNameIn(reference, buCode)}`;

  async function submit(e, confirm = false) {
    e?.preventDefault();
    setError(null); setExisting(null); setOk(null);
    if (!confirm) setWarnings([]);

    if (amountKobo == null || amountKobo <= 0) {
      setError('Enter a valid amount, e.g. 75000 or 75,000.00');
      return;
    }

    setBusy(true);
    try {
      const { request } = await api.createRequest({
        bu_code: buCode,
        site_code: needsSite ? siteCode : null,
        type_code: typeCode,
        period,
        amount_kobo: amountKobo,
        asset_key: type?.extraField ? assetKey : null,
        subject: subject.trim() || type?.label,
        description: description.trim() || suggested,
        confirm,
      });
      setOk(`${request.request_ref} submitted. A vendor will review it.`);
      setAmount(''); setAsset(''); setDescription(''); setSubject('');
      setWarnings([]);
      onCreated?.();
    } catch (err) {
      if (err instanceof ApiError) {
        // A soft warning is not a dead end: show what the server objected to
        // and let the requester proceed on the record.
        if (err.code === 'confirm_required') setWarnings(err.body.warnings || []);
        else {
          setError(err.message);
          if (err.code === 'duplicate_period') setExisting(err.body.existing);
        }
      } else {
        setError('Network problem. Try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Raise a payment request">
      <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>

      {warnings.length > 0 && (
        <Banner kind="warn" onClose={() => setWarnings([])}>
          <strong>
            {warnings.length === 1 ? 'Check this before submitting'
              : `${warnings.length} things to check before submitting`}
          </strong>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18 }}>
            {warnings.map((w) => (
              <li key={w.key} style={{ marginBottom: 4 }}>{w.message}</li>
            ))}
          </ul>
          <div style={{ marginTop: 12, display: 'flex', gap: 10 }}>
            <button type="button" disabled={busy}
                    onClick={() => submit(null, true)}
                    style={button('primary', busy)}>
              {busy ? 'Submitting…' : 'Confirm and submit anyway'}
            </button>
            <button type="button" onClick={() => setWarnings([])} style={button('ghost')}>
              Go back and edit
            </button>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: T.textDim }}>
            Confirming is recorded against the request and shown to the reviewer.
          </div>
        </Banner>
      )}
      <Banner onClose={() => { setError(null); setExisting(null); }}>
        {error}
        {existing && (
          <div style={{ marginTop: 6, fontSize: 13, color: T.textDim }}>
            Existing: <strong style={{ color: T.text }}>{existing.request_ref}</strong>
            {' · '}{existing.status}
            {existing.invoice_no && <> · {existing.invoice_no}</>}
          </div>
        )}
      </Banner>

      <form onSubmit={submit}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
          <Field label="Business unit">
            <select style={inputStyle} value={buCode} onChange={(e) => changeBu(e.target.value)}>
              {businessUnits.map((b) => (
                <option key={b.code} value={b.code}>{b.code} — {b.name}</option>
              ))}
            </select>
          </Field>

          <Field label="Request type">
            <select style={inputStyle} value={typeCode} onChange={(e) => setType(e.target.value)}>
              {REQUEST_TYPES.map((t) => (
                <option key={t.code} value={t.code}>{t.label}</option>
              ))}
            </select>
          </Field>

          {needsSite ? (
            <Field
              label="Location"
              hint={siteLocked ? `${buNameIn(reference, buCode)} has one location.` : undefined}
            >
              <select
                style={{ ...inputStyle, opacity: siteLocked ? 0.7 : 1 }}
                value={siteCode}
                disabled={siteLocked}
                onChange={(e) => setSite(e.target.value)}
              >
                {permitted.map((s) => (
                  <option key={s.code} value={s.code}>{s.code} — {s.name}</option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Location" hint="Covers the whole business unit.">
              <div style={{ ...inputStyle, color: T.textDim }}>Not applicable</div>
            </Field>
          )}

          <Field label="Period">
            <input
              style={inputStyle}
              type="month"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </Field>

          {type?.extraField && (
            <Field label={type.extraField.label}>
              <input
                style={inputStyle}
                value={assetKey}
                placeholder={type.extraField.placeholder}
                onChange={(e) => setAsset(e.target.value)}
              />
            </Field>
          )}

          <Field label="Amount (₦)">
            <input
              style={inputStyle}
              value={amount}
              placeholder="75,000"
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
        </div>

        <Field
          label="Document title"
          hint={`Appears as "Request for Payment – …". Leave blank to use: ${type?.label}`}
        >
          <input
            style={inputStyle}
            value={subject}
            placeholder={type?.label}
            onChange={(e) => setSubject(e.target.value)}
          />
        </Field>

        <Field label="Description on the document" hint={`Leave blank to use: ${suggested}`}>
          <input
            style={inputStyle}
            value={description}
            placeholder={suggested}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        {/* Deliberately unbranded. Rendering a vendor letterhead here
            would let the client produce a letterheaded document without
            a vendor approving it. */}
        <div style={{
          background: T.bg, border: `1px dashed ${T.border}`, borderRadius: 8,
          padding: 14, marginBottom: 16, font: `14px ${FONT}`,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: T.textDim, textTransform: 'uppercase', marginBottom: 9 }}>
            Summary — the approving vendor issues the letterheaded document
          </div>
          <Row k="For" v={`${buNameIn(reference, buCode)}${needsSite ? ` · ${siteNameIn(reference, siteCode)}` : ''}`} />
          <Row k="Title" v={`Request for Payment – ${subject.trim() || type?.label}`} />
          <Row k="Type" v={`${type?.label} · ${periodLabel(period)}`} />
          {type?.extraField && <Row k={type.extraField.label} v={assetKey || '—'} />}
          <Row k="Bill amount" v={amountKobo == null ? '—' : naira(amountKobo)} />
          <Row k="Processing fee" v={naira(feeKobo)} />
          <Row k="Total to transfer" v={totalKobo == null ? '—' : naira(totalKobo)} strong />
        </div>

        <button type="submit" disabled={busy} style={button('primary', busy)}>
          {busy ? 'Submitting…' : 'Submit request'}
        </button>
      </form>
    </Card>
  );
}

const Row = ({ k, v, strong }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
    <span style={{ color: T.textDim }}>{k}</span>
    <span style={{ fontWeight: strong ? 700 : 400 }}>{v}</span>
  </div>
);
