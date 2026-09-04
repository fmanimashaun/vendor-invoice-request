import React, { useEffect, useId, useRef } from 'react';
import { T, FONT, MONO, STATUS_COLOR, button } from '../theme.js';

/**
 * The page-level heading: what this screen is, one line on what it is for,
 * and the primary thing you can do here on the right. Every page opens with
 * one so the eye lands in the same place on every tab.
 */
export function PageHeader({ title, description, actions, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 16, flexWrap: 'wrap', marginBottom: 20,
    }}>
      <div style={{ minWidth: 0 }}>
        <h1 style={{ margin: 0, font: `700 22px ${FONT}`, letterSpacing: -0.2, color: T.text }}>{title}</h1>
        {description && (
          <p style={{ margin: '6px 0 0', color: T.textDim, fontSize: 14, lineHeight: 1.5, maxWidth: 680 }}>
            {description}
          </p>
        )}
        {children}
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{actions}</div>
      )}
    </div>
  );
}

export function Card({ title, subtitle, right, children, style, padding = 20 }) {
  return (
    <section style={{
      background: T.panel,
      border: `1px solid ${T.border}`,
      borderRadius: T.radius,
      padding,
      marginBottom: 16,
      ...style,
    }}>
      {(title || right) && (
        <header style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 12, marginBottom: 14, flexWrap: 'wrap',
        }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <h2 style={{ margin: 0, font: `600 15px ${FONT}`, color: T.text }}>{title}</h2>
            {subtitle && (
              <p style={{ margin: '4px 0 0', color: T.textDim, fontSize: 13, lineHeight: 1.5 }}>{subtitle}</p>
            )}
          </div>
          {right && <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{right}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const CONTROLS = new Set(['input', 'select', 'textarea']);

export function Field({ label: text, hint, error, children, style }) {
  // Link the label to a bare control child so clicking the label focuses it
  // and assistive tech reads the pair together. A child that already carries
  // an id, or is not a plain control, is left alone.
  const generated = useId();
  const linkable = React.isValidElement(children) && CONTROLS.has(children.type) && !children.props.id;
  const id = linkable ? generated : children?.props?.id;
  const control = linkable ? React.cloneElement(children, { id }) : children;
  return (
    <div style={{ marginBottom: 14, ...style }}>
      {text && (
        <label htmlFor={id} style={{
          display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
          color: T.textDim, marginBottom: 6, textTransform: 'uppercase',
        }}>{text}</label>
      )}
      {control}
      {error
        ? <div style={{ marginTop: 5, fontSize: 12, color: T.red }}>{error}</div>
        : hint && <div style={{ marginTop: 5, fontSize: 12, color: T.textDim, lineHeight: 1.45 }}>{hint}</div>}
    </div>
  );
}

/** Two-up form grid that collapses on narrow screens. */
export const FormGrid = ({ children, min = 200 }) => (
  <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`, gap: '0 16px' }}>
    {children}
  </div>
);

export function Status({ value, color: override }) {
  const color = override || STATUS_COLOR[value] || T.textDim;
  return (
    <span style={{
      display: 'inline-block', padding: '3px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
      color, border: `1px solid ${color}55`, background: `${color}1a`, whiteSpace: 'nowrap',
    }}>{value}</span>
  );
}

export function Banner({ kind = 'error', children, onClose, style }) {
  // `{error}{existing && ...}` is an array of nulls, and an array is truthy —
  // so count the real children rather than testing the prop.
  if (React.Children.toArray(children).filter((c) => c !== null && c !== false && c !== '').length === 0) return null;
  const color = kind === 'error' ? T.red : kind === 'ok' ? T.green : kind === 'info' ? T.blue : T.amber;
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} style={{
      display: 'flex', gap: 12, alignItems: 'flex-start',
      background: `${color}14`, border: `1px solid ${color}66`, color: T.text,
      borderRadius: T.radiusSm, padding: '11px 13px', marginBottom: 14, fontSize: 14, lineHeight: 1.45,
      ...style,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      {onClose && (
        <button onClick={onClose} aria-label="Dismiss" style={{
          background: 'none', border: 'none', color: T.textDim, cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 0,
        }}>×</button>
      )}
    </div>
  );
}

/**
 * What to show where rows would be.
 *
 * "Nothing here" and "we do not know yet" are different statements, and
 * showing the first while the second is true is a lie the user acts on — the
 * dashboard breakdowns announced "Nothing issued in this range" before the
 * request for that range had come back. Every table distinguishes them.
 *
 * `empty` takes a string, or { title, hint, action } when there is something
 * useful to say or do about the emptiness.
 */
export function EmptyState({ title, hint, action, loading }) {
  return (
    <div style={{
      padding: '36px 18px', textAlign: 'center',
      border: `1px dashed ${T.border}`, borderRadius: T.radius,
      margin: '10px 0 2px', background: `${T.panelAlt}55`,
    }}>
      <div style={{
        font: `${loading ? 400 : 600} 14px ${FONT}`,
        color: loading ? T.textDim : T.text,
      }}>
        {loading ? 'Loading…' : title}
      </div>
      {!loading && hint && (
        <div style={{ color: T.textDim, fontSize: 13, marginTop: 6, lineHeight: 1.5, maxWidth: 460, margin: '6px auto 0' }}>{hint}</div>
      )}
      {!loading && action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}

export function Table({ head, children, empty, loading = false }) {
  // The table decides whether it is empty by counting its own rows, so a
  // caller cannot forget the check or get the condition backwards.
  const rows = React.Children.count(children);
  const state = typeof empty === 'string' ? { title: empty } : empty;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', font: `14px ${FONT}` }}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} style={{
                textAlign: h.right ? 'right' : 'left', padding: '8px 12px',
                borderBottom: `1px solid ${T.border}`, color: T.textDim,
                fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
                whiteSpace: 'nowrap',
              }}>{h.label ?? h}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
      {rows === 0 && (loading
        ? <EmptyState loading />
        : (state && (React.isValidElement(state) ? state : <EmptyState {...state} />)))}
    </div>
  );
}

/** A table row with the hover treatment; pass onClick to make it a link. */
export const Tr = ({ children, onClick, dimmed, style }) => (
  <tr onClick={onClick} className={`vi-row${onClick ? ' vi-clickable' : ''}`}
      style={{ opacity: dimmed ? 0.55 : 1, transition: 'opacity .15s', ...style }}>
    {children}
  </tr>
);

export const Td = ({ children, right, mono, dim, style }) => (
  <td style={{
    padding: '11px 12px', borderBottom: `1px solid ${T.borderSoft}`,
    textAlign: right ? 'right' : 'left',
    fontFamily: mono ? MONO : undefined,
    fontSize: mono ? 13 : undefined,
    color: dim ? T.textDim : T.text,
    whiteSpace: mono ? 'nowrap' : undefined,
    verticalAlign: 'top',
    ...style,
  }}>{children}</td>
);

/** Actions at the end of a row, right-aligned and evenly spaced. */
export const RowActions = ({ children }) => (
  <Td right>
    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center', flexWrap: 'wrap' }}>
      {children}
    </div>
  </Td>
);

const MODAL_WIDTH = { sm: 440, md: 560, lg: 760, xl: 980 };

/**
 * Every create, edit and confirm in the app happens in one of these.
 *
 * The page underneath stays where it was, so the list you were reading is
 * still there when the dialog closes. Escape and the backdrop close it unless
 * `locked` (a save in flight, or a success screen with a decision on it).
 * The body scrolls on its own so a long form never pushes the actions off
 * the screen.
 */
export function Modal({ title, subtitle, children, onClose, actions, size = 'md', locked = false }) {
  const panel = useRef(null);
  // Read through a ref so the effects below run once per mount. `onClose` is
  // almost always an inline arrow, and an effect keyed on it would re-run on
  // every render — refocusing the first field while someone is typing in the
  // third.
  const latest = useRef({ onClose, locked });
  latest.current = { onClose, locked };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !latest.current.locked) latest.current.onClose?.();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Put focus inside so keyboard users are not left on the button behind,
    // unless a field has already claimed it with autoFocus.
    if (!panel.current?.contains(document.activeElement)) {
      panel.current?.querySelector('input, select, textarea, button')?.focus?.();
    }
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, []);

  return (
    <div
      className="vi-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !locked) onClose?.(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(3, 8, 14, .72)', zIndex: 50,
        backdropFilter: 'blur(3px)', WebkitBackdropFilter: 'blur(3px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div
        ref={panel}
        role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}
        className="vi-modal"
        style={{
          background: T.panel, border: `1px solid ${T.border}`, borderRadius: T.radius,
          width: '100%', maxWidth: MODAL_WIDTH[size] ?? size, maxHeight: 'calc(100vh - 40px)',
          display: 'flex', flexDirection: 'column', boxShadow: T.shadow,
        }}
      >
        <header style={{
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12,
          padding: '18px 22px 14px', borderBottom: `1px solid ${T.borderSoft}`,
        }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, font: `600 17px ${FONT}`, color: T.text }}>{title}</h3>
            {subtitle && (
              <p style={{ margin: '4px 0 0', color: T.textDim, fontSize: 13, lineHeight: 1.5 }}>{subtitle}</p>
            )}
          </div>
          {onClose && !locked && (
            <button onClick={onClose} aria-label="Close" style={{
              background: 'none', border: 'none', color: T.textDim, cursor: 'pointer',
              fontSize: 22, lineHeight: 1, padding: '0 2px', marginTop: -2,
            }}>×</button>
          )}
        </header>
        <div style={{ padding: '18px 22px', overflowY: 'auto', flex: 1 }}>{children}</div>
        {actions && (
          <footer style={{
            display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap',
            padding: '14px 22px 18px', borderTop: `1px solid ${T.borderSoft}`,
          }}>
            {actions}
          </footer>
        )}
      </div>
    </div>
  );
}

/**
 * A yes-or-no with the consequence spelled out. Replaces window.confirm(),
 * which cannot be styled, cannot hold two sentences legibly, and on some
 * browsers is suppressed after the second one.
 */
export function Confirm({ title, children, confirmLabel = 'Confirm', kind = 'primary', busy = false, onConfirm, onClose }) {
  return (
    <Modal title={title} onClose={onClose} size="sm" locked={busy}
      actions={
        <>
          <button onClick={onClose} disabled={busy} style={button('ghost', busy)}>Cancel</button>
          <button onClick={onConfirm} disabled={busy} style={button(kind, busy)}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </>
      }>
      <div style={{ color: T.textDim, fontSize: 14, lineHeight: 1.55 }}>{children}</div>
    </Modal>
  );
}

/**
 * The "it worked" face of a modal. The dialog stays open and swaps its body
 * for this, so the person sees the outcome where they were looking and can
 * decide what to do next without hunting for a banner behind the overlay.
 */
export function SuccessState({ title, children, icon = '✓' }) {
  return (
    <div style={{ textAlign: 'center', padding: '10px 0 4px' }}>
      <div style={{
        width: 56, height: 56, borderRadius: '50%', margin: '0 auto 16px',
        background: `${T.green}1f`, border: `1px solid ${T.green}66`, color: T.green,
        display: 'flex', alignItems: 'center', justifyContent: 'center', font: `700 26px ${FONT}`,
      }}>{icon}</div>
      <div style={{ font: `600 17px ${FONT}`, color: T.text, marginBottom: 8 }}>{title}</div>
      <div style={{ color: T.textDim, fontSize: 14, lineHeight: 1.55, maxWidth: 420, margin: '0 auto' }}>{children}</div>
    </div>
  );
}

/** Label/value pairs, for read-only summaries that an Edit button sits above. */
export function Details({ rows, columns = 2 }) {
  return (
    <dl style={{
      display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${columns === 1 ? 320 : 220}px, 1fr))`,
      gap: '14px 24px', margin: 0,
    }}>
      {rows.filter(Boolean).map(([k, v, mono]) => (
        <div key={k} style={{ minWidth: 0 }}>
          <dt style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: T.textDim, marginBottom: 4 }}>{k}</dt>
          <dd style={{ margin: 0, color: v == null || v === '' ? T.textDim : T.text, fontSize: 14, fontFamily: mono ? MONO : undefined, wordBreak: 'break-word' }}>
            {v == null || v === '' ? '—' : v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export { button };

/**
 * Grouping within a page. Settings is eight unrelated panels — locations,
 * numbering, fonts, sign-on — and a single scroll makes finding one a hunt.
 */
export function SubTabs({ tabs, active, onChange }) {
  return (
    <div style={{
      display: 'flex', gap: 2, flexWrap: 'wrap', marginBottom: 18,
      borderBottom: `1px solid ${T.border}`,
    }}>
      {tabs.map(([key, label]) => {
        const on = key === active;
        return (
          <button key={key} onClick={() => onChange(key)} className="vi-tab" style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '10px 14px', font: `${on ? 600 : 500} 14px ${FONT}`,
            color: on ? T.text : T.textDim,
            borderBottom: `2px solid ${on ? T.blue : 'transparent'}`,
            marginBottom: -1, transition: 'color .15s',
          }}>{label}</button>
        );
      })}
    </div>
  );
}
