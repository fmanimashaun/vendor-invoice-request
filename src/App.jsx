import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, input as inputStyle } from './theme.js';
import { Card, Field, Banner, button } from './components/Shell.jsx';
import RequestForm from './components/RequestForm.jsx';
import Queue from './components/Queue.jsx';
import History from './components/History.jsx';
import Vendors from './components/Vendors.jsx';
import Users from './components/Users.jsx';
import Dashboard from './components/Dashboard.jsx';
import Locations from './components/Locations.jsx';
import { api, ApiError } from './api.js';

/**
 * Which role context the app opens in.
 *
 * A person can hold more than one role — an admin who also raises requests is
 * ordinary — so the app shows one context at a time and lets them switch. The
 * last choice is remembered per user; failing that their default_role; failing
 * that whatever they hold.
 *
 * The context is NOT presentation. It lives in the signed session cookie and
 * the server authorises against it, so acting as a member genuinely cannot
 * reach an admin route even though the account holds admin — a deliberate
 * switch is required first. localStorage only remembers which context to ask
 * for at next sign-in; tampering with it changes nothing, because the switch
 * itself is a server call that checks the roles actually held.
 */
const CONTEXT_KEY = (user) => `role-context:${user.id}`;

function readContext(user) {
  try {
    const saved = localStorage.getItem(CONTEXT_KEY(user));
    if (saved && user.roles.includes(saved)) return saved;
  } catch { /* private window, or storage disabled */ }
  if (user.default_role && user.roles.includes(user.default_role)) return user.default_role;
  return user.roles[0] ?? null;
}

function writeContext(user, role) {
  try { localStorage.setItem(CONTEXT_KEY(user), role); }
  catch { /* remembering it is a nicety, not a requirement */ }
}

/** Landing tab for a given context. */
const firstTab = (user, context) =>
  user.org === 'vendor' ? 'queue'
  : context === 'admin' ? 'dashboard'
  : 'new';

export default function App() {
  const [boot, setBoot]       = useState(null);   // { user, feeKobo, config }
  const [requests, setRequests] = useState([]);
  const [tab, setTab]         = useState(null);
  const [context, setContext] = useState(null);   // active role context
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
        // The server decides what we are acting as; the stored preference is
        // only consulted when it differs and the role is genuinely held.
        let ctx = b.user.context;
        const preferred = readContext(b.user);
        if (preferred && preferred !== ctx && b.user.roles.includes(preferred)) {
          await api.switchContext(preferred).catch(() => {});
          ctx = preferred;
        }
        setContext(ctx);
        setTab(firstTab(b.user, ctx));
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
  // An admin has just set this password, so the admin knows it. Nothing else
  // is reachable until the owner replaces it — the server enforces that too.
  if (boot?.mustChangePassword) {
    return <ChangePassword hint={boot.passwordHint} onDone={async () => {
      setLoading(true);
      const b = await load();
      const ctx = b.user.context;
      setContext(ctx);
      setTab(firstTab(b.user, ctx));
      setLoading(false);
    }} />;
  }

  if (!boot)   return <Login onDone={async () => {
    setLoading(true);
    const b = await load();
    const ctx = b.user.context;
    setContext(ctx);
    setTab(firstTab(b.user, ctx));
    setLoading(false);
  }} />;

  const { user } = boot;
  const isVendor = user.org === 'vendor';
  const pendingCount = requests.filter((r) => r.status === 'pending').length;

  const acting = context ?? user.roles[0];
  const clientAdmin = user.org === 'client' && acting === 'admin';

  function switchContext(next) {
    setContext(next);
    writeContext(user, next);
    setTab(firstTab(user, next));
  }

  const tabs = isVendor
    ? [
        ['queue',   pendingCount ? `Open queue (${pendingCount})` : 'Open queue'],
        ['history', 'Approved by us'],
      ]
    : clientAdmin
      ? [
          ['dashboard', 'Dashboard'],
          ['history',   'Requests'],
          ['vendors',   'Vendors'],
          ['users',     'Staff'],
          ['locations', 'Settings'],
        ]
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
          {/* Only worth showing to someone who actually holds more than one. */}
          {user.roles.length > 1 && (
            <select
              value={acting}
              onChange={(e) => switchContext(e.target.value)}
              title="Switch role context"
              style={{
                background: T.panelAlt, color: T.text, border: `1px solid ${T.border}`,
                borderRadius: 8, padding: '5px 9px', font: `600 12px ${FONT}`, cursor: 'pointer',
              }}
            >
              {user.roles.map((r) => (
                <option key={r} value={r}>
                  {r === 'admin' ? 'Administration' : r === 'member' ? 'Requests'
                    : r === 'approver' ? 'Approvals' : r}
                </option>
              ))}
            </select>
          )}
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
          <History requests={requests} me={user} acting={acting} onChanged={refresh} />
        )}
        {tab === 'dashboard' && <Dashboard />}
        {tab === 'vendors' && <Vendors />}
        {tab === 'users' && <Users />}
        {tab === 'locations' && (
          <Locations
            feeKobo={boot.feeKobo}
            orgName={boot.orgName}
            onSaved={(cfg) => setBoot({
              ...boot, feeKobo: cfg.default_fee_kobo, orgName: cfg.org_name,
            })}
          />
        )}
      </main>
    </div>
  );
}

function ChangePassword({ hint, onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit(e) {
    e.preventDefault();
    setError(null); setBusy(true);
    try {
      await api.changePassword(current, next);
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
      <div style={{ width: '100%', maxWidth: 420 }}>
        <h1 style={{ font: `700 20px ${FONT}`, margin: '0 0 6px' }}>Choose a password</h1>
        <p style={{ color: T.textDim, fontSize: 14, margin: '0 0 22px', lineHeight: 1.5 }}>
          An administrator set your current password, so they know it. Pick your
          own before carrying on.
        </p>
        <Card>
          <Banner onClose={() => setError(null)}>{error}</Banner>
          <form onSubmit={submit}>
            <Field label="Current password">
              <input style={inputStyle} type="password" autoFocus value={current}
                     onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password" hint={hint}>
              <input style={inputStyle} type="password" value={next}
                     onChange={(e) => setNext(e.target.value)} />
            </Field>
            <button type="submit" disabled={busy || !current || !next}
                    style={{ ...button('primary', busy || !current || !next), width: '100%' }}>
              {busy ? 'Saving…' : 'Save and continue'}
            </button>
          </form>
        </Card>
      </div>
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
          Sign in
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
            {methods.clientPassword === false ? 'Staff sign in here' : 'Staff'}
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
