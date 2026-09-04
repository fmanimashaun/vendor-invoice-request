import React, { useCallback, useEffect, useState } from 'react';
import { T, FONT, GLOBAL_CSS, input as inputStyle } from './theme.js';
import { Card, Field, Banner, Confirm, PageHeader, button } from './components/Shell.jsx';
import NewRequestModal from './components/RequestForm.jsx';
import Queue from './components/Queue.jsx';
import History from './components/History.jsx';
import RequestTable from './components/RequestTable.jsx';
import Account from './components/Account.jsx';
import ReviseRequest from './components/ReviseRequest.jsx';
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

/**
 * Landing tab for a given context.
 *
 * A requester lands on their own list, not on a blank form: the list is where
 * the answer to "what happened to the one I raised" lives, and raising a new
 * one is a button on it. Opening straight into a form assumes the visit is
 * about creating something, and most visits are not.
 */
const firstTab = (user, context) =>
  user.org === 'vendor' ? 'queue'
  : context === 'admin' ? 'dashboard'
  : 'requests';

/** The few rules inline styles cannot carry, injected once. */
function GlobalStyles() {
  useEffect(() => {
    if (document.getElementById('vi-global')) return;
    const el = document.createElement('style');
    el.id = 'vi-global';
    el.textContent = GLOBAL_CSS;
    document.head.appendChild(el);
  }, []);
  return null;
}

export default function App() {
  const [boot, setBoot]       = useState(null);   // { user, feeKobo, config }
  const [requests, setRequests] = useState([]);
  const [tab, setTab]         = useState(null);
  const [context, setContext] = useState(null);   // active role context
  const [loading, setLoading] = useState(true);
  const [fatal, setFatal]     = useState(null);
  const [notice, setNotice]   = useState(null);   // shown on the login screen
  const [revising, setRevising] = useState(null); // a returned request being fixed
  const [raising, setRaising] = useState(false);  // the new-request dialog
  const [withdrawing, setWithdrawing] = useState(null); // request awaiting a withdraw confirm
  const [withdrawBusy, setWithdrawBusy] = useState(false);
  const [withdrawError, setWithdrawError] = useState(null);

  // Bootstrap first, and STOP THERE if the account is locked on a password
  // change. /api/requests is not one of the routes open while locked, so
  // fetching it here 403s, the throw lands in the caller's catch as a fatal
  // error, and the password form — the only thing that can clear the lock —
  // never renders. The screen reads "Set a new password before continuing"
  // over a Try again button that reloads into the same dead end.
  //
  // Nothing on the locked screen needs the request list. Anything added to
  // this function must either be open while locked or sit below this return.
  const load = useCallback(async () => {
    const b = await api.bootstrap();
    setBoot(b);
    if (b.mustChangePassword) return b;
    const { requests: rs } = await api.requests();
    setRequests(rs);
    return b;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const b = await load();
        // Nothing else runs while the account is locked: switching context is
        // itself a closed route, and the only screen it could affect is one
        // the user cannot reach yet.
        if (b.mustChangePassword) return;
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

  // Entering the app after signing in or changing a password.
  //
  // Both callers used to run `setLoading(true); await load(); setLoading(false)`
  // bare. A throw skipped the last line, and the screen sat on "Loading…"
  // forever — the Login component whose catch would have shown the error had
  // already been unmounted by the loading flip, so nothing surfaced and there
  // was no way back. Anything that sets loading must clear it in a finally.
  const enter = useCallback(async () => {
    setLoading(true); setFatal(null); setNotice(null);
    try {
      const b = await load();
      const ctx = b.user.context;
      setContext(ctx);
      setTab(firstTab(b.user, ctx));
    } catch (err) {
      // 401 straight after a successful sign-in means the session did not
      // stick rather than that the password was wrong. Put them back on the
      // form with an explanation instead of stranding them.
      if (err instanceof ApiError && err.status === 401) {
        setBoot(null);
        setNotice('Signed in, but the session did not carry over. Check that '
          + 'cookies are allowed for this site, then try again.');
      } else {
        setFatal(err?.message || 'Could not load.');
      }
    } finally {
      setLoading(false);
    }
  }, [load]);

  // The favicon lives in configuration, not in the build, so there is no file
  // to swap — the tag is written when we learn what it should be. Without
  // this, /favicon.ico 404s and the tab shows the browser's blank page icon.
  useEffect(() => {
    if (!boot?.favicon) return;
    const link = document.querySelector("link[rel='icon']")
      || document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'icon' }));
    link.href = boot.favicon;
  }, [boot?.favicon]);

  useEffect(() => {
    if (boot?.orgName) document.title = `${boot.orgName} · Invoice requests`;
  }, [boot?.orgName]);

  const refresh = useCallback(async () => {
    try {
      const { requests: rs } = await api.requests();
      setRequests(rs);
    } catch { /* a transient failure should not blank the screen */ }
  }, []);

  if (loading) return <><GlobalStyles /><Centre>Loading…</Centre></>;
  // An admin has just set this password, so the admin knows it. Nothing else
  // is reachable until the owner replaces it — the server enforces that too.
  //
  // Ahead of `fatal` deliberately: once bootstrap has told us the account is
  // locked, the form that clears the lock is the right screen even if some
  // other boot call then hit the 403 that locking produces. Ordered the other
  // way round, one such call strands the user with no route out.
  if (boot?.mustChangePassword) {
    return <><GlobalStyles /><ChangePassword hint={boot.passwordHint} onDone={enter} /></>;
  }
  if (fatal) return (
    <>
      <GlobalStyles />
      <Centre>
        <div style={{ textAlign: 'center' }}>
          <div style={{ color: T.red, marginBottom: 14 }}>{fatal}</div>
          <button onClick={() => window.location.reload()} style={button('ghost')}>
            Try again
          </button>
        </div>
      </Centre>
    </>
  );

  if (!boot)   return <><GlobalStyles /><Login onDone={enter} notice={notice} /></>;

  const { user } = boot;
  const isVendor = user.org === 'vendor';
  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const returnedCount = requests.filter((r) => r.status === 'returned').length;

  const acting = context ?? user.roles[0];
  const clientAdmin = user.org === 'client' && acting === 'admin';
  const requester = user.org === 'client' && !clientAdmin;

  function switchContext(next) {
    setContext(next);
    writeContext(user, next);
    setTab(firstTab(user, next));
  }

  async function confirmWithdraw() {
    if (!withdrawing) return;
    setWithdrawBusy(true); setWithdrawError(null);
    try {
      await api.withdraw(withdrawing.id);
      setWithdrawing(null);
      await refresh();
    } catch (err) {
      setWithdrawError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally {
      setWithdrawBusy(false);
    }
  }

  /**
   * What the person who raised a request can do about it.
   *
   * Withdraw works right up to a decision, including while a vendor is holding
   * it. A claim cannot be handed to another vendor, so without this a vendor
   * that claims something and goes quiet would freeze the request with nobody
   * able to act.
   */
  const requesterActions = (r) => {
    const canFix = r.status === 'returned';
    const canWithdraw = ['pending', 'claimed', 'returned'].includes(r.status);
    if (!canFix && !canWithdraw) return null;
    return (
      <>
        {canFix && (
          <button onClick={() => setRevising(r)} style={button('primary', false, 'sm')}>Fix</button>
        )}
        {canWithdraw && (
          <button onClick={() => { setWithdrawError(null); setWithdrawing(r); }} style={button('ghost', false, 'sm')}>
            Withdraw
          </button>
        )}
      </>
    );
  };

  const tabs = [
    ...(isVendor
      ? [
          ['queue',   'Queue', pendingCount],
          ['history', 'Approved by us'],
        ]
      : clientAdmin
        ? [
            ['dashboard', 'Dashboard'],
            ['requests',  'Requests'],
            ['vendors',   'Vendors'],
            ['users',     'Staff'],
            ['settings',  'Settings'],
          ]
        : [['requests', 'My requests', returnedCount]]),
    ['account', 'Account'],
  ];

  const initials = (user.full_name || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

  return (
    <div style={{ minHeight: '100vh', background: T.bg, color: T.text, font: `15px ${FONT}` }}>
      <GlobalStyles />
      <header style={{
        position: 'sticky', top: 0, zIndex: 20,
        borderBottom: `1px solid ${T.border}`, background: `${T.panel}f2`,
        backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
      }}>
        <div style={{
          maxWidth: 1200, margin: '0 auto', padding: '0 24px',
          display: 'flex', alignItems: 'center', gap: 22, minHeight: 58, flexWrap: 'wrap',
        }}>
          <strong style={{ fontSize: 15, letterSpacing: 0.2, display: 'flex', alignItems: 'center', gap: 10 }}>
            <span>Vendor<span style={{ color: T.blue }}>Invoice</span></span>
            {boot.logo
              ? <img src={boot.logo} alt={boot.orgName || ''} style={{ height: 22 }} />
              : boot.orgName && (
                <span style={{ color: T.textDim, fontWeight: 400, borderLeft: `1px solid ${T.border}`, paddingLeft: 10 }}>
                  {boot.orgName}
                </span>
              )}
          </strong>

          <nav style={{ display: 'flex', gap: 2, alignSelf: 'stretch', alignItems: 'stretch', flexWrap: 'wrap' }}>
            {tabs.map(([key, text, count]) => {
              const on = tab === key;
              return (
                <button
                  key={key}
                  onClick={() => setTab(key)}
                  className="vi-tab"
                  style={{
                    padding: '0 12px', cursor: 'pointer', background: 'none', border: 'none',
                    font: `${on ? 600 : 500} 14px ${FONT}`,
                    color: on ? T.text : T.textDim,
                    borderBottom: `2px solid ${on ? T.blue : 'transparent'}`,
                    display: 'inline-flex', alignItems: 'center', gap: 7, transition: 'color .15s',
                  }}
                >
                  {text}
                  {count > 0 && (
                    <span style={{
                      minWidth: 18, height: 18, padding: '0 5px', borderRadius: 999,
                      background: on ? T.blue : T.panelAlt, color: on ? '#04121d' : T.text,
                      font: `700 11px ${FONT}`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}>{count}</span>
                  )}
                </button>
              );
            })}
          </nav>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: T.textDim, marginLeft: 'auto' }}>
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
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
              <span style={{
                width: 28, height: 28, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                background: isVendor ? `${T.blue}26` : `${T.green}26`, color: isVendor ? T.blue : T.green,
                font: `700 11px ${FONT}`, letterSpacing: 0.5,
              }}>{initials}</span>
              <span style={{ display: 'flex', flexDirection: 'column', lineHeight: 1.2 }}>
                <span style={{ color: T.text, fontWeight: 600 }}>{user.full_name}</span>
                <span style={{ fontSize: 11 }}>{isVendor ? (user.vendor_name || 'Vendor') : (boot.orgName || 'Client')}</span>
              </span>
            </span>
            <button
              onClick={async () => { await api.logout().catch(() => {}); location.reload(); }}
              style={button('subtle', false, 'sm')}
            >Sign out</button>
          </div>
        </div>
      </header>

      <main style={{ maxWidth: 1200, margin: '0 auto', padding: '26px 24px 72px' }}>
        {tab === 'queue' && (
          <Queue requests={requests} me={user} onChanged={refresh} />
        )}
        {tab === 'history' && (
          <History requests={requests} me={user} acting={acting} onChanged={refresh} />
        )}
        {tab === 'requests' && (
          <>
            <PageHeader
              title={clientAdmin ? 'All requests' : 'My requests'}
              description={clientAdmin
                ? 'Everything raised across the organisation, with the invoice number once a vendor has issued one.'
                : 'Everything you have raised, and where each one is. Raise a new one from here.'}
              actions={requester && (
                <button onClick={() => setRaising(true)} style={button('primary')}>
                  <span style={{ fontSize: 18, lineHeight: 0.8 }}>+</span> New request
                </button>
              )}
            />
            {requester && returnedCount > 0 && (
              <Banner kind="warn">
                <strong>{returnedCount === 1 ? 'One request needs' : `${returnedCount} requests need`} your attention.</strong>{' '}
                A vendor sent {returnedCount === 1 ? 'it' : 'them'} back with a note. Use <strong>Fix</strong> on the row to update and resend.
              </Banner>
            )}
            <RequestTable
              requests={requests}
              showVendorFilter={clientAdmin}
              // An admin's view is read-only: they cannot raise or withdraw a
              // request, so offering the buttons would only produce a 403.
              actions={clientAdmin ? undefined : requesterActions}
              onNew={requester ? () => setRaising(true) : undefined}
            />
          </>
        )}
        {tab === 'dashboard' && <Dashboard requests={requests} onSeeAll={() => setTab('requests')} />}
        {tab === 'account' && <Account me={user} acting={acting} />}
        {tab === 'vendors' && <Vendors />}
        {tab === 'users' && <Users />}
        {tab === 'settings' && (
          <Locations
            feeKobo={boot.feeKobo}
            orgName={boot.orgName}
            logo={boot.logo}
            favicon={boot.favicon}
            onSaved={(cfg) => setBoot({
              ...boot, feeKobo: cfg.default_fee_kobo, orgName: cfg.org_name,
              logo: cfg.logo_data_uri || null, favicon: cfg.favicon_data_uri || null,
            })}
          />
        )}

        {raising && (
          <NewRequestModal
            feeKobo={boot.feeKobo}
            reference={{ businessUnits: boot.businessUnits, sites: boot.sites, buSites: boot.buSites }}
            onCreated={refresh}
            onClose={() => setRaising(false)}
          />
        )}
        {revising && (
          <ReviseRequest
            request={revising}
            onClose={() => setRevising(null)}
            onDone={async () => { setRevising(null); await refresh(); }}
          />
        )}
        {withdrawing && (
          <Confirm
            title={`Withdraw ${withdrawing.request_ref}?`}
            confirmLabel="Withdraw request"
            kind="danger"
            busy={withdrawBusy}
            onConfirm={confirmWithdraw}
            onClose={() => setWithdrawing(null)}
          >
            <Banner onClose={() => setWithdrawError(null)}>{withdrawError}</Banner>
            This ends the request. No vendor will see it again and no invoice
            will be issued for it. If the spend is still needed, raise a fresh
            request afterwards — withdrawing frees the period, so it will not be
            blocked as a duplicate.
            {withdrawing.status === 'claimed' && (
              <div style={{ marginTop: 10 }}>
                <strong style={{ color: T.text }}>{withdrawing.decided_vendor_name || 'A vendor'}</strong> currently
                holds it. Withdrawing takes it off their desk.
              </div>
            )}
          </Confirm>
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
        <h1 style={{ font: `700 22px ${FONT}`, margin: '0 0 6px', letterSpacing: -0.2 }}>Choose a password</h1>
        <p style={{ color: T.textDim, fontSize: 14, margin: '0 0 22px', lineHeight: 1.5 }}>
          An administrator set your current password, so they know it. Pick your
          own before carrying on.
        </p>
        <Card>
          <Banner onClose={() => setError(null)}>{error}</Banner>
          <form onSubmit={submit}>
            <Field label="Current password">
              <input style={inputStyle} type="password" autoFocus value={current}
                     autoComplete="current-password"
                     onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label="New password" hint={hint}>
              <input style={inputStyle} type="password" value={next}
                     autoComplete="new-password"
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
function Login({ onDone, notice }) {
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
        <h1 style={{ font: `700 24px ${FONT}`, margin: '0 0 6px', letterSpacing: -0.3 }}>
          Vendor<span style={{ color: T.blue }}>Invoice</span>
        </h1>
        <p style={{ color: T.textDim, fontSize: 14, margin: '0 0 22px' }}>
          Sign in to continue
        </p>

        {methods?.password && (
        <Card>
          <Banner onClose={() => setError(null)}>{error || notice}</Banner>
          <form onSubmit={submit}>
            <Field label="Email">
              <input style={inputStyle} type="email" autoFocus value={email}
                     autoComplete="username"
                     onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <input style={inputStyle} type="password" value={password}
                     autoComplete="current-password"
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
