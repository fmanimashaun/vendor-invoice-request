import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Table, Td, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';

/**
 * Who did what, and when.
 *
 * Append-only and read-only: there is no route that edits or deletes a row,
 * and there is no button here that pretends otherwise. A log the operator can
 * tidy answers no question an auditor is asking.
 *
 * This is the client's governance record, not the vendor's — it names client
 * staff and their decisions — so it lives behind the admin role and the
 * server checks that independently.
 */
const GROUPS = {
  BANK_DETAILS_CHANGED:   { label: 'Bank details changed', tone: 'alert' },
  PASSWORD_RESET_BY_ADMIN: { label: 'Password reset by admin', tone: 'alert' },
  SSO_CONFIG_CHANGED:     { label: 'Sign-on config changed', tone: 'alert' },
  INVOICE_ISSUED:         { label: 'Invoice issued', tone: 'good' },
  REQUEST_RAISED:         { label: 'Request raised' },
  REQUEST_REJECTED:       { label: 'Request rejected', tone: 'warn' },
  REQUEST_WITHDRAWN:      { label: 'Request withdrawn', tone: 'warn' },
  VENDOR_ONBOARDED:       { label: 'Vendor onboarded' },
  VENDOR_STATUS_CHANGED:  { label: 'Vendor suspended or restored', tone: 'warn' },
  VENDOR_ROSTER_CHANGED:  { label: 'Vendor roster changed' },
  VENDOR_TEMPLATE_CHANGED: { label: 'Invoice layout changed' },
  PASSWORD_CHANGED:       { label: 'Password changed' },
  USER_AUTOPROVISIONED:   { label: 'User provisioned by SSO' },
  FONT_UPLOADED:          { label: 'Font uploaded' },
  FONT_DELETED:           { label: 'Font deleted' },
};

const toneColor = (tone) => ({ alert: T.red, warn: T.amber, good: T.green }[tone] || T.textDim);
const nice = (a) => GROUPS[a]?.label ?? a.toLowerCase().replace(/_/g, ' ');

/** Only the fields that changed, rendered so the change is the thing you see. */
function Changes({ before, after }) {
  if (!before && !after) return null;
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  if (!keys.length) return null;
  return (
    <table style={{ marginTop: 8, font: `12px ${FONT}`, borderCollapse: 'collapse' }}>
      <tbody>
        {keys.map((k) => (
          <tr key={k}>
            <td style={{ color: T.textDim, padding: '2px 12px 2px 0', whiteSpace: 'nowrap' }}>
              {k.replace(/_/g, ' ')}
            </td>
            <td style={{ padding: '2px 8px 2px 0', color: T.textDim, textDecoration: 'line-through' }}>
              {before?.[k] === undefined || before?.[k] === null ? '—' : String(before[k])}
            </td>
            <td style={{ padding: '2px 0', color: T.text }}>
              → {after?.[k] === undefined || after?.[k] === null ? '—' : String(after[k])}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Says plainly whether the record can be trusted, and refuses to say yes on
 * thin evidence. A verifier that cannot reach its anchor reports "cannot
 * confirm" — a green tick nobody checked is worse than no tick.
 */
function Integrity({ proof }) {
  if (!proof) {
    return (
      <Banner kind="warn">
        Could not verify the record just now. The entries below are shown
        as stored, but nothing here confirms they are unaltered.
      </Banner>
    );
  }
  if (proof.ok) {
    return (
      <Banner kind="ok">
        <strong>Verified.</strong> All {proof.entries} entries are chained and
        intact, and the head matches an anchor held in separate storage — so
        neither an edit nor a removal has happened, including from outside the
        application.
        {proof.head && (
          <div style={{ fontSize: 12, color: T.textDim, marginTop: 6,
                        fontFamily: 'ui-monospace, Menlo, monospace', wordBreak: 'break-all' }}>
            head {proof.head}
          </div>
        )}
      </Banner>
    );
  }
  const anchorNote = {
    mismatch: 'The head does not match the anchor held in separate storage, '
      + 'which is what a wholesale rewrite looks like.',
    behind: 'The anchor is behind the table: entries exist that were never anchored.',
    missing: 'There is no anchor to compare against.',
    unavailable: 'The anchor could not be read, so this could not be cross-checked.',
  }[proof.anchorState];
  return (
    <Banner>
      <strong>This record has been altered.</strong>
      {proof.problems?.length > 0 && (
        <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
          {proof.problems.slice(0, 5).map((x) => (
            <li key={`${x.id}-${x.kind}`} style={{ marginBottom: 4 }}>
              Entry {x.id} ({(x.at || '').slice(0, 19)}) — {x.detail}
            </li>
          ))}
        </ul>
      )}
      {anchorNote && <div style={{ marginTop: 8 }}>{anchorNote}</div>}
    </Banner>
  );
}

export default function Audit() {
  const [data, setData]   = useState(null);
  const [proof, setProof] = useState(null);
  const [error, setError] = useState(null);
  const [action, setAction] = useState('');
  const [actor, setActor]   = useState('');
  const [q, setQ]           = useState('');
  const [from, setFrom]     = useState('');
  const [to, setTo]         = useState('');
  const [open, setOpen]     = useState(null);
  const [page, setPage]     = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [entries, verified] = await Promise.all([
        api.audit(),
        // Never block the list on the check. A verifier that fails to answer
        // must read as "cannot confirm", not as a clean bill of health.
        api.auditVerify().catch(() => null),
      ]);
      setData(entries);
      setProof(verified);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the audit trail.');
      setData({ entries: [], total: 0, actions: [] });
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const entries = data?.entries ?? [];
  const actors = useMemo(
    () => [...new Set(entries.map((e) => e.actor_email))].sort(), [entries],
  );

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries.filter((e) => {
      if (action && e.action !== action) return false;
      if (actor && e.actor_email !== actor) return false;
      if (from && (e.at || '') < from) return false;
      if (to && (e.at || '') > `${to} 23:59:59`) return false;
      if (!needle) return true;
      return [e.summary, e.actor_name, e.actor_email, e.entity, e.entity_label,
        e.before_json, e.after_json, nice(e.action)]
        .some((v) => String(v ?? '').toLowerCase().includes(needle));
    });
  }, [entries, action, actor, q, from, to]);

  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => { if (page > pages) setPage(1); }, [page, pages]);
  const shown = rows.slice((page - 1) * pageSize, page * pageSize);

  const anyFilter = q || action || actor || from || to;
  const clear = () => { setQ(''); setAction(''); setActor(''); setFrom(''); setTo(''); setPage(1); };
  const ctl = { ...inputStyle, padding: '6px 9px', fontSize: 13 };
  const touch = (fn) => (e) => { fn(e.target.value); setPage(1); };

  return (
    <Card
      title="Audit trail"
      right={
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <span style={{ color: T.textDim, fontSize: 13 }}>
            {rows.length === entries.length ? entries.length : `${rows.length} of ${entries.length}`}
          </span>
          <button onClick={load} style={button('ghost')}>Refresh</button>
        </div>
      }
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Integrity proof={proof} />
      <p style={{ color: T.textDim, fontSize: 13, margin: '0 0 14px', lineHeight: 1.5 }}>
        Append-only, and the database enforces it: an UPDATE or DELETE against
        this table is refused even from outside the application. Every entry is
        also chained to the one before it, so an edit made by removing that
        guard still shows up here. Passwords are never recorded; a bank account
        number appears only in the one event whose subject is that it changed.
      </p>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
        <input style={{ ...ctl, width: 210 }} value={q} placeholder="Search…"
               onChange={touch(setQ)} />
        <select style={{ ...ctl, width: 215 }} value={action} onChange={touch(setAction)}>
          <option value="">Any event</option>
          {(data?.actions ?? []).map((a) => <option key={a} value={a}>{nice(a)}</option>)}
        </select>
        {actors.length > 1 && (
          <select style={{ ...ctl, width: 210 }} value={actor} onChange={touch(setActor)}>
            <option value="">Anyone</option>
            {actors.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        )}
        <input style={{ ...ctl, width: 145 }} type="date" title="From" value={from}
               onChange={touch(setFrom)} />
        <input style={{ ...ctl, width: 145 }} type="date" title="To" value={to}
               onChange={touch(setTo)} />
        {anyFilter && <button onClick={clear} style={button('ghost')}>Clear</button>}
      </div>

      {data?.truncated && (
        <Banner kind="warn">
          Showing the most recent {entries.length} of {data.total} entries. Narrow
          the date range to reach older ones.
        </Banner>
      )}

      <Table
        head={['When', 'Event', 'Who', 'What', '']}
        loading={data === null}
        empty={entries.length
          ? {
              title: 'Nothing matches those filters',
              hint: 'Try a wider date range, or clear the filters.',
              action: <button onClick={clear} style={button('ghost')}>Clear filters</button>,
            }
          : {
              title: 'Nothing recorded yet',
              hint: 'Approvals, invoices, bank changes, password resets and roster '
                + 'changes are written here as they happen.',
            }}
      >
        {shown.map((e) => {
          const tone = toneColor(GROUPS[e.action]?.tone);
          const detail = e.before || e.after;
          return (
            <React.Fragment key={e.id}>
              <tr>
                <Td dim mono style={{ whiteSpace: 'nowrap' }}>{(e.at || '').replace('T', ' ')}</Td>
                <Td>
                  <span style={{
                    display: 'inline-block', padding: '2px 9px', borderRadius: 999,
                    fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
                    color: tone, border: `1px solid ${tone}`, whiteSpace: 'nowrap',
                  }}>{nice(e.action)}</span>
                </Td>
                <Td>
                  {e.actor_name}
                  <div style={{ fontSize: 12, color: T.textDim }}>
                    {e.actor_email}
                    {e.actor_context ? ` · as ${e.actor_context}` : ''}
                  </div>
                </Td>
                <Td>{e.summary || e.entity_label || e.entity || '—'}</Td>
                <Td right>
                  {detail && (
                    <button onClick={() => setOpen(open === e.id ? null : e.id)}
                            style={button('ghost')}>
                      {open === e.id ? 'Hide' : 'Detail'}
                    </button>
                  )}
                </Td>
              </tr>
              {open === e.id && detail && (
                <tr>
                  <td colSpan={5} style={{
                    padding: '4px 10px 14px', background: T.panelAlt,
                    borderBottom: `1px solid ${T.border}22`,
                  }}>
                    <Changes before={e.before} after={e.after} />
                    <div style={{ marginTop: 8, fontSize: 12, color: T.textDim }}>
                      {e.entity ? `${e.entity}` : ''}
                    </div>
                  </td>
                </tr>
              )}
            </React.Fragment>
          );
        })}
      </Table>

      {rows.length > 0 && (
        <div style={{
          display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
          marginTop: 14, color: T.textDim, fontSize: 13,
        }}>
          <span>
            {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, rows.length)} of {rows.length}
          </span>
          <div style={{ display: 'flex', gap: 6 }}>
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}
                    style={button('ghost', page <= 1)}>Previous</button>
            <button disabled={page >= pages} onClick={() => setPage(page + 1)}
                    style={button('ghost', page >= pages)}>Next</button>
          </div>
          <span>Page {page} of {pages}</span>
          <select style={{ ...ctl, width: 108, marginLeft: 'auto' }} value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}>
            {[25, 50, 100, 200].map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
        </div>
      )}
    </Card>
  );
}
