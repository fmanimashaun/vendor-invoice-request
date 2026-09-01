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

export function Table({ head, children, empty }) {
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
      {empty && <p style={{ color: T.textDim, fontSize: 14, padding: '14px 10px', margin: 0 }}>{empty}</p>}
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
