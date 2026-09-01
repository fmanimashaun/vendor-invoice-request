import React, { useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Field, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { naira } from '../../shared/reference.js';

/**
 * A vendor admin edits only their own row. These values are COPIED onto each
 * invoice at issue,
 * so editing them here never changes a document that has already gone out.
 */
export default function Config({ config, onSaved }) {
  const [form, setForm] = useState({
    bank_account_name:   config?.bank_account_name   ?? '',
    bank_account_number: config?.bank_account_number ?? '',
    bank_name:           config?.bank_name           ?? '',
    fee_naira:           String((config?.fee_kobo ?? 10000) / 100),
    signatory_name:      config?.signatory_name      ?? '',
    signatory_title:     config?.signatory_title     ?? '',
    tin:                 config?.tin                  ?? '',
    vat_rate_pct:        config?.vat_rate_bps ? String(config.vat_rate_bps / 100) : '',
    wht_rate_pct:        config?.wht_rate_bps ? String(config.wht_rate_bps / 100) : '',
    vat_basis:           config?.vat_basis            ?? 'invoice',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [ok, setOk] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const bankChanging =
    config &&
    (form.bank_account_number.trim() !== config.bank_account_number ||
     form.bank_account_name.trim()   !== config.bank_account_name ||
     form.bank_name.trim()           !== config.bank_name);

  async function save(e) {
    e.preventDefault();
    setError(null); setOk(null);

    const fee = Number(form.fee_naira);
    if (!Number.isFinite(fee) || fee < 0) { setError('Processing fee must be a number.'); return; }

    if (bankChanging && !window.confirm(
      'You are changing the bank details.\n\n' +
      'Every request approved from now on will direct payment to the new account. ' +
      'Invoices already issued keep their original details.\n\nContinue?',
    )) return;

    setBusy(true);
    try {
      const { config: saved } = await api.saveConfig({
        bank_account_name:   form.bank_account_name.trim(),
        bank_account_number: form.bank_account_number.trim(),
        bank_name:           form.bank_name.trim(),
        fee_kobo:            Math.round(fee * 100),
        signatory_name:      form.signatory_name.trim(),
        signatory_title:     form.signatory_title.trim(),
        tin:                 form.tin.trim(),
        vat_rate_pct:        form.vat_rate_pct,
        wht_rate_pct:        form.wht_rate_pct,
        vat_basis:           form.vat_basis,
      });
      setOk('Saved. New approvals will use these details.');
      onSaved?.(saved);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Document settings">
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>

      <p style={{ margin: '0 0 16px', color: T.textDim, font: `14px ${FONT}`, lineHeight: 1.55 }}>
        These appear on the issued document. Each invoice keeps its own copy, so changing
        them here affects future approvals only — nothing already issued is altered.
      </p>

      <form onSubmit={save}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 14 }}>
          <Field label="Account name">
            <input style={inputStyle} value={form.bank_account_name} onChange={set('bank_account_name')} />
          </Field>
          <Field label="Account number">
            <input style={inputStyle} value={form.bank_account_number} onChange={set('bank_account_number')} inputMode="numeric" />
          </Field>
          <Field label="Bank">
            <input style={inputStyle} value={form.bank_name} onChange={set('bank_name')} />
          </Field>
          <Field label="Processing fee (₦)" hint="Added to every request total.">
            <input style={inputStyle} value={form.fee_naira} onChange={set('fee_naira')} inputMode="decimal" />
          </Field>
          <Field label="Signatory name">
            <input style={inputStyle} value={form.signatory_name} onChange={set('signatory_name')} />
          </Field>
          <Field label="Signatory title">
            <input style={inputStyle} value={form.signatory_title} onChange={set('signatory_title')} />
          </Field>

          <Field label="TIN" hint="Optional. Printed on your invoices.">
            <input style={inputStyle} value={form.tin} onChange={set('tin')} />
          </Field>
          <Field label="VAT %" hint="Added to the invoice total. Blank if not registered.">
            <input style={inputStyle} value={form.vat_rate_pct} onChange={set('vat_rate_pct')}
                   inputMode="decimal" placeholder="7.5" />
          </Field>
          <Field label="WHT %" hint="Withheld by the payer. Shown as a deduction, not added.">
            <input style={inputStyle} value={form.wht_rate_pct} onChange={set('wht_rate_pct')}
                   inputMode="decimal" placeholder="5" />
          </Field>
          <Field label="Tax applies to" hint="Fee only, where the bill is a pass-through at cost.">
            <select style={inputStyle} value={form.vat_basis} onChange={set('vat_basis')}>
              <option value="invoice">The whole invoice</option>
              <option value="fee">Your fee only</option>
            </select>
          </Field>
        </div>

        {bankChanging && (
          <Banner kind="warn">
            Bank details are being changed. Confirm the new account by a channel
            other than the one the change request arrived on.
          </Banner>
        )}

        <button type="submit" disabled={busy} style={button('primary', busy)}>
          {busy ? 'Saving…' : 'Save settings'}
        </button>
      </form>
    </Card>
  );
}
