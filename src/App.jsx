import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, input as inputStyle } from './theme.js';
import { Card, Field, Banner, button } from './components/Shell.jsx';
import RequestForm from './components/RequestForm.jsx';
import Queue from './components/Queue.jsx';
import History from './components/History.jsx';
import Config from './components/Config.jsx';
import Vendors from './components/Vendors.jsx';
import Locations from './components/Locations.jsx';
import { api, ApiError } from './api.js';

/**
 * Landing tab per role. The client admin owns the vendor rosters and gets
 * a read-only view of the queue; they do not raise requests, so 'new' is not
 * theirs to land on.
 */
const firstTab = (user) =>
  user.org === 'vendor'   ? 'queue'
  : user.role === 'admin' ? 'history'
  : 'new';

export default function App() {
  const [boot, setBoot]       = useState(null);   // { user, feeKobo, config }
  const [requests, setRequests] = useState([]);
  const [tab, setTab]         = useState(null);
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal]     = useState(null);

  const load = useCallback(async () => {
    const b = await api.bootstrap();
    setBoot(b);
    const { requests: rs } = await api.requests();
    setRequests(rs);
    return b;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const b = await load();
        setTab(firstTab(b.user));
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) setBoot(null);
        else setFatal(err?.message || 'Could not load.');
      } finally {
        setLoading(false);
      }
    })();
  }, [load]);

  const refresh = useCallback(async () => {
    try {
      const { requests: rs } = await api.requests();
      setRequests(rs);
    } catch { /* a transient failure should not blank the screen */ }
  }, []);

  if (loading) return <Centre>Loading…</Centre>;
  if (fatal)   return <Centre><span style={{ color: T.red }}>{fatal}</span></Centre>;
  if (!boot)   return <Login onDone={async () => {
    setLoading(true);
    const b = await load();
    setTab(firstTab(b.user));
    setLoading(false);
  }} />;

  const { user } = boot;
  const isVendor = user.org === 'vendor';
  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  const clientAdmin = user.org === 'client' && user.role === 'admin';

  const tabs = isVendor
    ? [
        ['queue',   pendingCount ? `Open queue (${pendingCount})` : 'Open queue'],
        ['history', 'Approved by us'],
        ...(user.role === 'admin' ? [['config', 'Settings']] : []),
      ]
    : clientAdmin
      ? [['history', 'Requests'], ['vendors', 'Vendors & users'], ['locations', 'Settings']]
      : [['new', 'New request'], ['history', 'My requests']];

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, font: `15px ${FONT}` }}>
      <header style={{
        borderBottom: `1px solid ${T.border}`, background: T.panel,
        padding: '12px 20px', display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap',
      }}>
        <strong style={{ fontSize: 15, letterSpacing: 0.2 }}>
          Vendor<span style={{ color: T.blue }}>Invoice</span>
          {boot.orgName && (
            <span style={{ color: T.textDim, fontWeight: 400 }}> · {boot.orgName}</span>
          )}
        </strong>

        <nav style={{ display: 'flex', gap: 6, marginLeft: 'auto', flexWrap: 'wrap' }}>
          {tabs.map(([key, text]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              style={{
                padding: '7px 13px', borderRadius: 8, cursor: 'pointer',
                font: `600 13px ${FONT}`,
                background: tab === key ? T.blue : 'transparent',
                color: tab === key ? '#04121d' : T.textDim,
                border: `1px solid ${tab === key ? T.blue : T.border}`,
              }}
            >{text}</button>
          ))}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: T.textDim }}>
          <span>
            {user.full_name}
            <span style={{
              marginLeft: 7, padding: '1px 7px', borderRadius: 999, fontSize: 11, fontWeight: 700,
              color: isVendor ? T.blue : T.green,
              border: `1px solid ${isVendor ? T.blue : T.green}`,
            }}>{isVendor ? (user.vendor_name || 'VENDOR')
                         : (boot.orgName || 'CLIENT')}</span>
          </span>
          <button
            onClick={async () => { await api.logout().catch(() => {}); location.reload(); }}
            style={{ background: 'none', border: 'none', color: T.textDim, cursor: 'pointer', font: `13px ${FONT}` }}
          >Sign out</button>
        </div>
      </header>

      <main style={{ maxWidth: 1160, margin: '0 auto', padding: '22px 20px 60px' }}>
        {tab === 'new' && (
          <RequestForm
            feeKobo={boot.feeKobo}
            reference={{ businessUnits: boot.businessUnits, sites: boot.sites, buSites: boot.buSites }}
            onCreated={refresh}
          />
        )}
        {tab === 'queue' && (
          <Queue requests={requests} me={user} onChanged={refresh} />
        )}
        {tab === 'history' && (
          <History requests={requests} me={user} onChanged={refresh} />
        )}
        {tab === 'vendors' && <Vendors />}
        {tab === 'locations' && (
          <Locations
            feeKobo={boot.feeKobo}
            orgName={boot.orgName}
            onSaved={(cfg) => setBoot({
              ...boot, feeKobo: cfg.default_fee_kobo, orgName: cfg.org_name,
            })}
          />
        )}
        {tab === 'config' && (
          <Config
            config={boot.config}
            onSaved={(cfg) => setBoot({ ...boot, config: cfg, feeKobo: cfg.fee_kobo })}
          />
        )}
      </main>
    </div>
  );
}

const Centre = ({ children }) => (
  <div style={{
    minHeight: '100vh', background: T.bg, color: T.textDim, font: `15px ${FONT}`,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }}>{children}</div>
);

/**
 * Only vendor staff see this. client staff arrive already authenticated by
 * Cloudflare Access, so bootstrap succeeds and this never renders for them.
 */
function Login({ onDone }) {
  // Which methods this deployment offers. Until it loads, show nothing rather
  // than flashing a button that may not apply.
  const [methods, setMethods] = useState(null);
  useEffect(() => {
    api.authMethods()
      .then(setMethods)
      .catch(() => setMethods({ sso: false, password: true, ssoLabel: '' }));
  }, []);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api.login(email.trim(), password);
      await onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
      setBusy(false);
    }
  }

  return (
    <div style={{
      minHeight: '100vh', background: T.bg, color: T.text, font: `15px ${FONT}`,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
    }}>
      <div style={{ width: '100%', maxWidth: 380 }}>
        <h1 style={{ font: `700 22px ${FONT}`, margin: '0 0 6px' }}>
          Vendor<span style={{ color: T.blue }}>Invoice</span>
        </h1>
        <p style={{ color: T.textDim, fontSize: 14, margin: '0 0 22px' }}>
          Vendor sign-in
        </p>

        {methods?.password && (
        <Card>
          <Banner onClose={() => setError(null)}>{error}</Banner>
          <form onSubmit={submit}>
            <Field label="Email">
              <input style={inputStyle} type="email" autoFocus value={email}
                     onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <input style={inputStyle} type="password" value={password}
                     onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <button type="submit" disabled={busy || !email || !password}
                    style={{ ...button('primary', busy || !email || !password), width: '100%' }}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        </Card>
        )}

        {methods?.sso && (
        <div style={{ textAlign: 'center', marginTop: 4 }}>
          <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 10px' }}>
            Staff sign-in
          </p>
          {/* Full page navigation, not fetch: Cloudflare Access needs to
              redirect the browser to the identity provider and back. Which
              provider — one, or a chooser — is decided by the IdPs attached to
              the Access application, not here. */}
          <a
            href="/api/auth/sso"
            style={{
              display: 'inline-block', padding: '9px 18px', borderRadius: 8,
              border: `1px solid ${T.border}`, color: T.text, textDecoration: 'none',
              font: `600 14px ${FONT}`,
            }}
          >
            {methods.ssoLabel}
          </a>
        </div>
        )}
      </div>
    </div>
  );
}
