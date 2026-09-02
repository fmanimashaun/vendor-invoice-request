import React from 'react';
import { T, FONT, STATUS_COLOR, button } from '../theme.js';

export function Card({ title, right, children, style }) {
  return (
    <section style={{
      background: T.panel,
      border: `1px solid ${T.border}`,
      borderRadius: T.radius,
      padding: 18,
      marginBottom: 16,
      ...style,
    }}>
      {(title || right) && (
        <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h2 style={{ margin: 0, font: `600 15px ${FONT}`, color: T.text }}>{title}</h2>
          {right}
        </header>
      )}
      {children}
    </section>
  );
}

export function Field({ label: text, hint, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{
        display: 'block', fontSize: 11, fontWeight: 700, letterSpacing: 0.5,
        color: T.textDim, marginBottom: 5, textTransform: 'uppercase',
      }}>{text}</label>
      {children}
      {hint && <div style={{ marginTop: 4, fontSize: 12, color: T.textDim }}>{hint}</div>}
    </div>
  );
}

export function Status({ value }) {
  const color = STATUS_COLOR[value] || T.textDim;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 9px', borderRadius: 999,
      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
      color, border: `1px solid ${color}`, background: `${color}18`,
    }}>{value}</span>
  );
}

export function Banner({ kind = 'error', children, onClose }) {
  if (!children) return null;
  const color = kind === 'error' ? T.red : kind === 'ok' ? T.green : T.amber;
  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'flex-start',
      background: `${color}14`, border: `1px solid ${color}`, color: T.text,
      borderRadius: 8, padding: '11px 13px', marginBottom: 14, fontSize: 14, lineHeight: 1.45,
    }}>
      <div style={{ flex: 1 }}>{children}</div>
      {onClose && (
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: T.textDim, cursor: 'pointer', fontSize: 16, lineHeight: 1,
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
      padding: '30px 18px', textAlign: 'center',
      border: `1px dashed ${T.border}`, borderRadius: T.radius,
      margin: '10px 0 2px', background: T.panelAlt,
    }}>
      <div style={{
        font: `${loading ? 400 : 600} 14px ${FONT}`,
        color: loading ? T.textDim : T.text,
      }}>
        {loading ? 'Loading…' : title}
      </div>
      {!loading && hint && (
        <div style={{ color: T.textDim, fontSize: 13, marginTop: 6, lineHeight: 1.5 }}>{hint}</div>
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
                textAlign: h.right ? 'right' : 'left', padding: '8px 10px',
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

export const Td = ({ children, right, mono, dim, style }) => (
  <td style={{
    padding: '10px', borderBottom: `1px solid ${T.border}22`,
    textAlign: right ? 'right' : 'left',
    fontFamily: mono ? 'ui-monospace, SFMono-Regular, Menlo, monospace' : undefined,
    color: dim ? T.textDim : T.text,
    whiteSpace: mono ? 'nowrap' : undefined,
    ...style,
  }}>{children}</td>
);

export function Modal({ title, children, onClose, actions }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: '#000000aa', zIndex: 50,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.panel, border: `1px solid ${T.border}`, borderRadius: T.radius,
        padding: 20, width: '100%', maxWidth: 480,
      }}>
        <h3 style={{ margin: '0 0 14px', font: `600 16px ${FONT}`, color: T.text }}>{title}</h3>
        {children}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 18 }}>
          {actions}
        </div>
      </div>
    </div>
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
      display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 16,
      borderBottom: `1px solid ${T.border}`, paddingBottom: 2,
    }}>
      {tabs.map(([key, label]) => {
        const on = key === active;
        return (
          <button key={key} onClick={() => onChange(key)} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '9px 14px', font: `${on ? 700 : 500} 14px ${FONT}`,
            color: on ? T.blue : T.textDim,
            borderBottom: `2px solid ${on ? T.blue : 'transparent'}`,
            marginBottom: -3,
          }}>{label}</button>
        );
      })}
    </div>
  );
}
