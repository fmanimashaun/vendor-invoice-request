import React, { useCallback, useEffect, useState } from 'react';
import { T, input as inputStyle } from '../theme.js';
import {
  Card, Field, FormGrid, Table, Tr, Td, RowActions, Banner, Modal, Confirm,
  SuccessState, PageHeader, Status, button,
} from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { PASSWORD_HINT, MIN_LENGTH } from '../../shared/password.js';
import SetPassword from './SetPassword.jsx';

const BLANK = {
  full_name: '', email: '', roles: ['member'], password: '',
  must_change_password: true,
};

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
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [ok, setOk]       = useState(null);
  const [adding, setAdding] = useState(false);
  const [resetting, setResetting] = useState(null);
  const [toggling, setToggling] = useState(null);

  const load = useCallback(async () => {
    try {
      setUsers((await api.clientUsers()).users || []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load staff.');
      setUsers([]);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function run(fn, id) {
    setError(null); setOk(null); setBusyId(id ?? null);
    try {
      const msg = await fn();
      if (msg) setOk(msg);
      await load();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
      return false;
    } finally { setBusyId(null); }
  }

  async function confirmToggle() {
    const u = toggling;
    const next = u.status === 'active' ? 'disabled' : 'active';
    const done = await run(() => api.setUserStatus(u.id, next).then(() =>
      next === 'disabled' ? `${u.full_name} can no longer sign in.` : `${u.full_name} restored.`), u.id);
    if (done) setToggling(null);
  }

  const active = (users || []).filter((u) => u.status === 'active').length;

  return (
    <>
      <PageHeader
        title="Staff"
        description="Members raise payment requests. Admins onboard vendors and manage this page. Holding both is normal — one person switches context in the header rather than needing two accounts."
        actions={
          <button onClick={() => setAdding(true)} style={button('primary')}>
            <span style={{ fontSize: 18, lineHeight: 0.8 }}>+</span> Add staff
          </button>
        }
      />

      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>

      <Card
        title="Everyone with an account"
        right={users && <span style={{ color: T.textDim, fontSize: 13 }}>{active} active · {users.length} total</span>}
      >
        <Table head={['Name', 'Email', 'Roles', 'Status', '']}
               loading={users === null}
               empty={{
                 title: 'No staff yet',
                 hint: 'Members raise requests; admins onboard vendors and manage this page.',
                 action: <button onClick={() => setAdding(true)} style={button('primary')}>Add the first person</button>,
               }}>
          {(users || []).map((u) => {
            const off = u.status !== 'active';
            return (
              <Tr key={u.id} dimmed={off}>
                <Td><strong style={{ fontWeight: 600 }}>{u.full_name}</strong></Td>
                <Td mono dim>{u.email}</Td>
                <Td>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {(u.roles || []).map((r) => <Status key={r} value={r} color={r === 'admin' ? T.blue : T.textDim} />)}
                  </div>
                </Td>
                <Td><Status value={off ? 'removed' : 'active'} color={off ? T.textDim : T.green} /></Td>
                <RowActions>
                  <button disabled={busyId === u.id} onClick={() => setResetting(u)}
                          style={button('ghost', busyId === u.id, 'sm')}>
                    Reset password
                  </button>
                  <button disabled={busyId === u.id} onClick={() => setToggling(u)}
                          style={button(off ? 'ghost' : 'danger', busyId === u.id, 'sm')}>
                    {off ? 'Restore' : 'Remove'}
                  </button>
                </RowActions>
              </Tr>
            );
          })}
        </Table>
      </Card>

      {adding && (
        <AddStaffModal
          onClose={() => setAdding(false)}
          onCreated={load}
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
          confirmLabel={toggling.status === 'active' ? 'Remove access' : 'Restore access'}
          kind={toggling.status === 'active' ? 'danger' : 'primary'}
          busy={busyId === toggling.id}
          onConfirm={confirmToggle}
          onClose={() => setToggling(null)}
        >
          {toggling.status === 'active'
            ? <>They will not be able to sign in. Requests they raised keep their name, and nothing is deleted — you can restore them later.</>
            : <>They will be able to sign in again with the password they had. Reset it if you are not sure they still know it.</>}
        </Confirm>
      )}
    </>
  );
}

/**
 * Creating an account. Once the server has it, the dialog turns into a
 * confirmation and offers to add another — onboarding usually comes in
 * batches, and a fresh blank form is one click rather than a hunt for the
 * button behind the overlay.
 */
function AddStaffModal({ onClose, onCreated }) {
  const [form, setForm] = useState(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [made, setMade] = useState(null);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const complete = form.full_name.trim() && form.email.trim() && form.roles.length
    && form.password.length >= MIN_LENGTH;

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      const { user } = await api.createUser({ ...form, org: 'client' });
      setMade({ ...user, mustChange: form.must_change_password });
      onCreated?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(false); }
  }

  if (made) {
    return (
      <Modal title="Account created" onClose={onClose} size="sm"
        actions={
          <>
            <button onClick={onClose} style={button('ghost')}>Done</button>
            <button onClick={() => { setMade(null); setForm(BLANK); }} style={button('primary')}>Add another</button>
          </>
        }>
        <SuccessState title={`${made.full_name} can now sign in`}>
          Tell them their email and the password you set, in person.{' '}
          {made.mustChange
            ? 'They will be asked to choose their own password the first time they sign in.'
            : <span style={{ color: T.amber }}>They will keep the password you typed — you know it too.</span>}
        </SuccessState>
      </Modal>
    );
  }

  return (
    <Modal
      title="Add a member of staff"
      subtitle="There is no email delivery. You will hand them the password yourself."
      onClose={onClose}
      locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button type="submit" form="add-staff" disabled={busy || !complete} style={button('primary', busy || !complete)}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </>
      }
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <form id="add-staff" onSubmit={submit}>
        <FormGrid>
          <Field label="Full name">
            <input style={inputStyle} value={form.full_name} onChange={set('full_name')} autoFocus />
          </Field>
          <Field label="Email">
            <input style={inputStyle} type="email" value={form.email} onChange={set('email')} />
          </Field>
        </FormGrid>
        <Field label="Roles" hint="Both is normal.">
          <div style={{ display: 'flex', gap: 18, alignItems: 'center', minHeight: 38 }}>
            {[['member', 'Member — raises requests'], ['admin', 'Admin — manages the platform']].map(([r, label]) => (
              <label key={r} style={{ display: 'flex', gap: 7, alignItems: 'center', fontSize: 14 }}>
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
        <Field label="Temporary password" hint={PASSWORD_HINT}>
          <input style={inputStyle} type="password" value={form.password} onChange={set('password')} autoComplete="new-password" />
        </Field>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, lineHeight: 1.45 }}>
          <input type="checkbox" checked={form.must_change_password} style={{ marginTop: 3 }}
                 onChange={(e) => setForm({ ...form, must_change_password: e.target.checked })} />
          <span>
            Make them choose their own password when they first sign in
            <div style={{ fontSize: 12, color: form.must_change_password ? T.textDim : T.amber, marginTop: 3 }}>
              {form.must_change_password
                ? 'Leave this on unless you mean for them to keep the password you just typed.'
                : 'They will keep the password you typed, which you also know.'}
            </div>
          </span>
        </label>
      </form>
    </Modal>
  );
}
