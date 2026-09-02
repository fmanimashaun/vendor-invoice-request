import React, { useState } from 'react';
import { T, input as inputStyle } from '../theme.js';
import { Field, Modal, button } from './Shell.jsx';
import { PASSWORD_HINT, MIN_LENGTH } from '../../shared/password.js';

/**
 * Setting someone else's password, as an administrator.
 *
 * A modal rather than a prompt() because there is a decision to make here and
 * a browser prompt cannot hold a checkbox.
 *
 * The box defaults to ON. An admin who typed the password knows it, so the
 * account is shared knowledge rather than secured until the owner replaces it
 * — and that is the state you least want to arrive at by accident. Turning it
 * off has to be a deliberate, visible act. Either way the choice is recorded
 * in the audit trail, and the server applies the same default if the field is
 * missing entirely.
 *
 * Used for both client staff and vendor representatives; one dialog rather
 * than two, so the default cannot end up different depending on which roster
 * you happened to open.
 */
export default function SetPassword({ user, onClose, onDone }) {
  const [pw, setPw] = useState('');
  const [mustChange, setMustChange] = useState(true);
  const ready = pw.length >= MIN_LENGTH;

  return (
    <Modal
      title={`Set a password for ${user.full_name}`}
      onClose={onClose}
      actions={
        <>
          <button onClick={onClose} style={button('ghost')}>Cancel</button>
          <button disabled={!ready} onClick={() => onDone(pw, mustChange)}
                  style={button('primary', !ready)}>Set password</button>
        </>
      }
    >
      <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
        There is no email delivery, so read this out to {user.full_name} rather
        than writing it down. You will know it until they change it.
      </p>
      <Field label="New password" hint={PASSWORD_HINT}>
        <input style={inputStyle} type="password" autoFocus value={pw}
               onChange={(e) => setPw(e.target.value)} />
      </Field>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
        <input type="checkbox" checked={mustChange}
               onChange={(e) => setMustChange(e.target.checked)} />
        Make them choose their own password at next sign-in
      </label>
      {!mustChange && (
        <div style={{ fontSize: 12, color: T.amber, marginTop: 8, lineHeight: 1.5 }}>
          They will keep the password you just typed, which you also know.
          Only leave this off if that is what you intend.
        </div>
      )}
    </Modal>
  );
}
