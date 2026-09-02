import React, { useState } from 'react';
import { T, input as inputStyle } from '../theme.js';
import { Card, Field, Banner, Status, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { PASSWORD_HINT, MIN_LENGTH } from '../../shared/password.js';

/**
 * Your own account.
 *
 * You can change your password and nothing else. Name and email are shown but
 * not editable, and there is no route that would change them either — the name
 * is printed in the signature block of every invoice this person approves, and
 * the email is the join key that identifies them. Letting someone edit their
 * own name would let a vendor approver quietly change who an issued invoice
 * appears to have been approved by. Issued documents keep their own copy, so
 * the past is safe regardless, but the live roster should still only be
 * changed by the admin who owns it.
 *
 * There is no "forgot password" here. Nothing in this deployment can send
 * email, so recovery is an admin setting a temporary password and handing it
 * over in person — which is exactly why doing so flags the account as needing
 * a change at next sign-in.
 */
export default function Account({ me, acting }) {
  const [current, setCurrent] = useState('');
  const [next, setNext]       = useState('');
  const [again, setAgain]     = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const [ok, setOk]           = useState(null);

  const mismatch = again.length > 0 && next !== again;
  const ready = current && next.length >= MIN_LENGTH && next === again && !busy;

  async function submit(e) {
    e.preventDefault();
    setError(null); setOk(null); setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent(''); setNext(''); setAgain('');
      setOk('Your password has been changed.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(false); }
  }

  const Row = ({ label, children }) => (
    <div style={{ display: 'flex', gap: 14, padding: '9px 0', borderBottom: `1px solid ${T.border}22` }}>
      <div style={{
        width: 130, flexShrink: 0, fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        color: T.textDim, textTransform: 'uppercase', paddingTop: 2,
      }}>{label}</div>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );

  return (
    <>
      <Card title="Your details">
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Your name and email are maintained by an administrator. Your name is
          printed on documents you approve, so it is not yours to edit — ask an
          administrator if either is wrong.
        </p>
        <Row label="Name">{me.full_name}</Row>
        <Row label="Email"><span style={{
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        }}>{me.email}</span></Row>
        {me.job_title && <Row label="Job title">{me.job_title}</Row>}
        {me.phone && <Row label="Phone">{me.phone}</Row>}
        <Row label="Organisation">
          {me.org === 'vendor' ? (me.vendor_name || 'Vendor') : 'Client'}
        </Row>
        <Row label="Roles">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {(me.roles || []).map((r) => <Status key={r} value={r} />)}
          </div>
          {(me.roles || []).length > 1 && (
            <div style={{ fontSize: 12, color: T.textDim, marginTop: 6 }}>
              Acting as {acting}. Switch in the header.
            </div>
          )}
        </Row>
      </Card>

      <Card title="Change your password">
        <Banner onClose={() => setError(null)}>{error}</Banner>
        <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
          You need your current password to set a new one. That is deliberate:
          it means an unattended session cannot be used to take the account
          over. If you have forgotten it, an administrator can set a temporary
          one — there is no email recovery.
        </p>
        <form onSubmit={submit} style={{ maxWidth: 420 }}>
          <Field label="Current password">
            <input style={inputStyle} type="password" autoComplete="current-password"
                   value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" hint={PASSWORD_HINT}>
            <input style={inputStyle} type="password" autoComplete="new-password"
                   value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Field label="New password again"
                 hint={mismatch ? 'These do not match.' : undefined}>
            <input style={{
              ...inputStyle,
              borderColor: mismatch ? T.red : inputStyle.border?.split(' ').pop(),
            }} type="password" autoComplete="new-password"
                   value={again} onChange={(e) => setAgain(e.target.value)} />
          </Field>
          <button type="submit" disabled={!ready} style={button('primary', !ready)}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </form>
      </Card>
    </>
  );
}
