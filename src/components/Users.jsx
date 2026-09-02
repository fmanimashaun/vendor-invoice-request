import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Field, Table, Td, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { PASSWORD_HINT, MIN_LENGTH } from '../../shared/password.js';

const BLANK = { full_name: '', email: '', roles: ['member'], password: '' };

/**
 * Your own staff. Vendor representatives are managed inside each vendor, not
 * here — the two populations are separate and answer to different people.
 *
 * There is one administrator role in the system and it is on this page. An
 * admin onboards vendors, adds their representatives, and maintains their
 * details. They cannot approve a request or download an invoice: those are the
 * vendor's own acts, and the whole document is worth nothing as audit evidence
 * if the payer can produce it themselves.
 */
export default function Users() {
  const [users, setUsers] = useState(null);
  const [form, setForm]   = useState(BLANK);
  const [busy, setBusy]   = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [ok, setOk]       = useState(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api.clientUsers()).users || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load staff.');
      setUsers([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const complete = form.full_name && form.email && form.roles.length
    && form.password.length >= MIN_LENGTH;

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

  const add = (e) => {
    e.preventDefault();
    run(async () => {
      const { user } = await api.createUser({ ...form, org: 'client' });
      setForm(BLANK);
      return `${user.full_name} can now sign in.`;
    });
  };

  const toggle = (u) => {
    const next = u.status === 'active' ? 'disabled' : 'active';
    if (next === 'disabled' && !confirm(`Remove ${u.full_name}?`)) return;
    run(() => api.setUserStatus(u.id, next), u.id);
  };

  const reset = (u) => {
    const pw = prompt(`New password for ${u.full_name}.\n\n${PASSWORD_HINT}\n\n`
      + 'They must change it at next sign-in, so read it out rather than writing it down.');
    if (!pw) return;
    run(async () => {
      await api.resetPassword(u.id, pw);
      return `Password set for ${u.full_name}. They must change it at next sign-in.`;
    }, u.id);
  };

  return (
    <>
      <Card title="Staff">
        <Banner onClose={() => setError(null)}>{error}</Banner>
        <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>
        <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
          Members raise payment requests. Admins onboard vendors and manage this
          page. Holding both is normal — one person switches context in the
          header rather than needing two accounts.
        </p>

        <Table head={['Name', 'Email', 'Roles', 'Status', '']}
               loading={users === null}
               empty={{
                 title: 'No staff yet',
                 hint: 'Add someone below. Members raise requests; admins onboard '
                   + 'vendors and manage this page.',
               }}>
          {(users || []).map((u) => {
            const off = u.status !== 'active';
            return (
              <tr key={u.id} style={{ opacity: off ? 0.5 : 1 }}>
                <Td>{u.full_name}</Td>
                <Td mono>{u.email}</Td>
                <Td dim>{(u.roles || []).join(', ')}</Td>
                <Td dim>{off ? 'removed' : 'active'}</Td>
                <Td right>
                  <button disabled={busyId === u.id} onClick={() => reset(u)}
                          style={{ ...button('ghost', busyId === u.id), marginRight: 6 }}>
                    Reset password
                  </button>
                  <button disabled={busyId === u.id} onClick={() => toggle(u)}
                          style={button('ghost', busyId === u.id)}>
                    {off ? 'Restore' : 'Remove'}
                  </button>
                </Td>
              </tr>
            );
          })}
        </Table>

      </Card>

      <Card title="Add a member of staff">
        <form onSubmit={add}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: '0 16px' }}>
            <Field label="Full name">
              <input style={inputStyle} value={form.full_name} onChange={set('full_name')} />
            </Field>
            <Field label="Email">
              <input style={inputStyle} type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label="Roles" hint="Both is normal.">
              <div style={{ display: 'flex', gap: 14, alignItems: 'center', minHeight: 38 }}>
                {[['member', 'Member'], ['admin', 'Admin']].map(([r, label]) => (
                  <label key={r} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="checkbox" checked={form.roles.includes(r)}
                           onChange={(e) => setForm({
                             ...form,
                             roles: e.target.checked
                               ? [...form.roles, r]
                               : form.roles.filter((x) => x !== r),
                           })} />
                    {label}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Password" hint={PASSWORD_HINT}>
              <input style={inputStyle} type="password" value={form.password} onChange={set('password')} />
            </Field>
          </div>
          <button type="submit" disabled={busy || !complete} style={button('primary', busy || !complete)}>
            Add staff
          </button>
        </form>
      </Card>
    </>
  );
}
