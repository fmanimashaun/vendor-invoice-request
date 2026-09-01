// Palette lifted from the first letterhead onboarded, so the app and the document
// look related. Inline-style idiom, same as the CFM shell.

export const T = {
  bg:        '#0f1720',
  panel:     '#18232f',
  panelAlt:  '#1f2c3a',
  border:    '#2a3a4b',
  text:      '#e8eef4',
  textDim:   '#93a4b5',
  blue:      '#2b9ae5',   // letterhead blue
  blueDeep:  '#1c5f9e',
  red:       '#d5241f',   // letterhead red
  green:     '#2ea36b',
  amber:     '#d99a2b',
  radius:    10,
};

export const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export const STATUS_COLOR = {
  pending:   T.amber,
  approved:  T.green,
  rejected:  T.red,
  withdrawn: T.textDim,
};

export const input = {
  width: '100%',
  padding: '9px 11px',
  background: T.bg,
  color: T.text,
  border: `1px solid ${T.border}`,
  borderRadius: 8,
  font: `14px ${FONT}`,
  outline: 'none',
  boxSizing: 'border-box',
};

export const label = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: 0.3,
  color: T.textDim,
  marginBottom: 5,
  textTransform: 'uppercase',
};

export function button(kind = 'primary', disabled = false) {
  const base = {
    padding: '9px 16px',
    borderRadius: 8,
    border: '1px solid transparent',
    font: `600 14px ${FONT}`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
  if (kind === 'primary') return { ...base, background: T.blue, color: '#04121d' };
  if (kind === 'approve') return { ...base, background: T.green, color: '#04150c' };
  if (kind === 'danger')  return { ...base, background: 'transparent', color: T.red, borderColor: T.red };
  return { ...base, background: 'transparent', color: T.textDim, borderColor: T.border };
}
