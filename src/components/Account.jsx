import React, { useState } from 'react';
import { T, MONO, input as inputStyle } from '../theme.js';
import {
  Card, Field, Banner, Status, Modal, SuccessState, Details, PageHeader, button,
} from './Shell.jsx';
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
  const [changing, setChanging] = useState(false);

  return (
    <>
      <PageHeader
        title="Account"
        description="Your name and email are maintained by an administrator. Your name is printed on documents you approve, so it is not yours to edit — ask an administrator if either is wrong."
      />

      <Card title="Your details">
        <Details rows={[
          ['Name', me.full_name],
          ['Email', <span style={{ fontFamily: MONO, fontSize: 13 }}>{me.email}</span>],
          me.job_title && ['Job title', me.job_title],
          me.phone && ['Phone', me.phone],
          ['Organisation', me.org === 'vendor' ? (me.vendor_name || 'Vendor') : 'Client'],
          ['Roles', (
            <span>
              <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
                {(me.roles || []).map((r) => <Status key={r} value={r} color={r === 'admin' ? T.blue : T.textDim} />)}
              </span>
              {(me.roles || []).length > 1 && (
                <div style={{ fontSize: 12, color: T.textDim, marginTop: 6 }}>
                  Acting as {acting}. Switch in the header.
                </div>
              )}
            </span>
          )],
        ]} />
      </Card>

      <Card
        title="Password"
        subtitle="You need your current password to set a new one, so an unattended session cannot be used to take the account over. If you have forgotten it, an administrator can set a temporary one — there is no email recovery."
        right={<button onClick={() => setChanging(true)} style={button('ghost', false, 'sm')}>Change password</button>}
      />

      {changing && <ChangePasswordModal onClose={() => setChanging(false)} />}
    </>
  );
}

function ChangePasswordModal({ onClose }) {
  const [current, setCurrent] = useState('');
  const [next, setNext]       = useState('');
  const [again, setAgain]     = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState(null);
  const [done, setDone]       = useState(false);

  const mismatch = again.length > 0 && next !== again;
  const ready = current && next.length >= MIN_LENGTH && next === again && !busy;

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api.changePassword(current, next);
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(false); }
  }

  if (done) {
    return (
      <Modal title="Password changed" onClose={onClose} size="sm"
        actions={<button onClick={onClose} style={button('primary')}>Done</button>}>
        <SuccessState title="Your password has been changed">
          Use the new one next time you sign in. Nobody else knows it.
        </SuccessState>
      </Modal>
    );
  }

  return (
    <Modal
      title="Change your password"
      onClose={onClose}
      size="sm"
      locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="change-password" disabled={!ready} style={button('primary', !ready)}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </>
      }
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="change-password" onSubmit={submit}>
        <Field label="Current password">
          <input style={inputStyle} type="password" autoComplete="current-password" autoFocus
                 value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" hint={PASSWORD_HINT}>
          <input style={inputStyle} type="password" autoComplete="new-password"
                 value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Field label="New password again" error={mismatch ? 'These do not match.' : undefined} style={{ marginBottom: 0 }}>
          <input style={{ ...inputStyle, borderColor: mismatch ? T.red : undefined }}
                 type="password" autoComplete="new-password"
                 value={again} onChange={(e) => setAgain(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
