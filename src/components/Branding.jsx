import React, { useRef, useState } from 'react';
import { T, FONT } from '../theme.js';
import { Card, Field, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';

/**
 * The app's own logo and browser icon, set after deployment.
 *
 * NOT the invoice letterhead. That is per-vendor artwork in KV and belongs to
 * whoever issues the document — putting the payer's mark on the payee's
 * invoice would undo the one thing that makes the document worth anything as
 * evidence. This is the client's mark on the client's own tool.
 *
 * Held as a data: URI in `config` so a fresh deployment needs no bucket, no
 * CDN and no second origin configured before the app looks like itself. Fine
 * for an icon and a wordmark; it is not an asset pipeline, and the server caps
 * the size at 256 KB.
 */
const MAX_BYTES = 256 * 1024;
const ALLOWED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif',
                 'image/x-icon', 'image/vnd.microsoft.icon'];

const readAsDataUri = (file) => new Promise((res, rej) => {
  const fr = new FileReader();
  fr.onload = () => res(String(fr.result));
  fr.onerror = () => rej(new Error('Could not read that file.'));
  fr.readAsDataURL(file);
});

export default function Branding({ orgName, logo, favicon, onSaved }) {
  const [busy, setBusy]   = useState(null);
  const [error, setError] = useState(null);
  const [ok, setOk]       = useState(null);

  async function put(field, value) {
    setError(null); setOk(null); setBusy(field);
    try {
      const { config } = await api.savePlatformConfig({ [field]: value });
      onSaved?.(config);
      setOk(value ? 'Saved. Reload to see it in the browser tab.' : 'Removed.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusy(null); }
  }

  async function pick(field, file) {
    if (!file) return;
    // Checked here for a decent message, and again on the server because a
    // check in the browser is not a control.
    if (!ALLOWED.includes(file.type)) {
      setError(`${file.type || 'That file'} is not allowed. Use PNG, JPEG, WebP, `
        + 'GIF or ICO — SVG can carry script and this is rendered on every page.');
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`That file is ${Math.round(file.size / 1024)} KB. The limit is 256 KB — `
        + 'this is an icon, not a photograph.');
      return;
    }
    try {
      await put(field, await readAsDataUri(file));
    } catch (err) { setError(err.message); }
  }

  const Slot = ({ field, label, hint, value, box }) => {
    const input = useRef(null);
    return (
      <Field label={label} hint={hint}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{
            width: box, height: box, flexShrink: 0,
            border: `1px dashed ${T.border}`, borderRadius: 8, background: T.panelAlt,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden',
          }}>
            {value
              ? <img src={value} alt="" style={{ maxWidth: '100%', maxHeight: '100%' }} />
              : <span style={{ color: T.textDim, fontSize: 11 }}>none</span>}
          </div>
          <input ref={input} type="file" style={{ display: 'none' }}
                 accept={ALLOWED.join(',')}
                 onChange={(e) => { pick(field, e.target.files?.[0]); e.target.value = ''; }} />
          <button onClick={() => input.current?.click()} disabled={busy === field}
                  style={button('ghost', busy === field)}>
            {busy === field ? 'Saving…' : value ? 'Replace' : 'Choose a file'}
          </button>
          {value && (
            <button onClick={() => put(field, '')} disabled={busy === field}
                    style={button('ghost', busy === field)}>Remove</button>
          )}
        </div>
      </Field>
    );
  };

  return (
    <Card title="Appearance">
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Banner kind="ok" onClose={() => setOk(null)}>{ok}</Banner>
      <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 16px', lineHeight: 1.5 }}>
        Your own mark on your own tool. This has nothing to do with invoice
        letterheads — those belong to each vendor and are managed inside that
        vendor, because the document is theirs to issue.
      </p>

      <Slot
        field="logo_data_uri"
        label="Logo"
        hint="Shown in the header beside the name. A wide wordmark works best."
        value={logo}
        box={64}
      />
      <Slot
        field="favicon_data_uri"
        label="Browser icon"
        hint="Shown in the tab. A square PNG at 32×32 or 64×64, or an .ico."
        value={favicon}
        box={40}
      />

      <div style={{
        marginTop: 6, paddingTop: 14, borderTop: `1px solid ${T.border}`,
        color: T.textDim, fontSize: 12, lineHeight: 1.6,
      }}>
        PNG, JPEG, WebP, GIF or ICO, up to 256 KB. SVG is refused: it can carry
        script, and these are rendered on every page for every user.
        {orgName && (
          <> Until a logo is set, the header shows <strong
            style={{ color: T.text, font: `600 12px ${FONT}` }}>{orgName}</strong> as text.</>
        )}
      </div>
    </Card>
  );
}
