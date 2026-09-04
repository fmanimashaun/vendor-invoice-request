import React, { useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Field, Banner, Modal, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { naira } from '../../shared/reference.js';

/**
 * Fixing a request a vendor sent back.
 *
 * Only the fields a vendor plausibly sent it back over: the money, the meter or
 * router it is against, and the description. Not the unit, site, period or
 * type — those decide the invoice reference and the duplicate guard, so
 * changing them would let one request quietly become a different one while
 * keeping its number and its history. If those are wrong it is a new request,
 * and the server refuses them too.
 *
 * It goes back to the vendor that returned it, never to the shared queue. They
 * already know the history.
 */
export default function ReviseRequest({ request: r, onClose, onDone }) {
  const [amount, setAmount] = useState(String((r.amount_kobo ?? 0) / 100));
  const [assetKey, setAssetKey] = useState(r.asset_key ?? '');
  const [description, setDescription] = useState(r.description ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const kobo = Math.round(Number(amount) * 100);
  const valid = Number.isInteger(kobo) && kobo > 0 && description.trim()
    && (r.asset_key === null || r.asset_key === undefined || assetKey.trim());

  async function submit() {
    setError(null); setBusy(true);
    try {
      await api.revise(r.id, {
        amount_kobo: kobo,
        asset_key: assetKey.trim() || undefined,
        description: description.trim(),
      });
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Fix ${r.request_ref}`}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} style={button('ghost')}>Cancel</button>
          <button onClick={submit} disabled={!valid || busy}
                  style={button('primary', !valid || busy)}>
            {busy ? 'Sending…' : 'Send back to the vendor'}
          </button>
        </>
      }
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>

      {r.return_reason && (
        <Banner kind="warn">
          <strong>{r.decided_vendor_name || 'The vendor'} asked for a change:</strong>
          <div style={{ marginTop: 4 }}>{r.return_reason}</div>
        </Banner>
      )}

      <p style={{ margin: '0 0 14px', color: T.textDim, font: `13px ${FONT}`, lineHeight: 1.5 }}>
        {r.bu_code}{r.site_label ? ` · ${r.site_label}` : ''} · {r.type_label} · {r.period_label}
        <br />
        Those cannot be changed here — they set the invoice reference. If one of
        them is wrong, withdraw this and raise a new request.
      </p>

      <Field label="Amount (₦)" hint={`Currently ${naira(r.amount_kobo)}, plus ${naira(r.fee_kobo)} fee.`}>
        <input style={inputStyle} type="number" min="0" step="0.01" autoFocus
               value={amount} onChange={(e) => setAmount(e.target.value)} />
      </Field>

      {(r.asset_key !== null && r.asset_key !== undefined) && (
        <Field label="Meter or line number">
          <input style={inputStyle} value={assetKey}
                 onChange={(e) => setAssetKey(e.target.value)} />
        </Field>
      )}

      <Field label="Description">
        <input style={inputStyle} value={description}
               onChange={(e) => setDescription(e.target.value)} />
      </Field>
    </Modal>
  );
}
