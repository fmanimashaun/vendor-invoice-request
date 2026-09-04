// Palette lifted from the first letterhead onboarded, so the app and the document
// look related. Inline-style idiom, same as the CFM shell.
//
// Inline styles cannot express :hover, :focus or an animation, so the handful
// of rules that need those live in GLOBAL_CSS below and are injected once by
// App. Everything else stays inline.

export const T = {
  bg:        '#0b1118',
  panel:     '#131c26',
  panelAlt:  '#1a2532',
  border:    '#243343',
  borderSoft:'#1c2937',
  text:      '#e8eef4',
  textDim:   '#8fa1b3',
  blue:      '#2b9ae5',   // letterhead blue
  blueDeep:  '#1c5f9e',
  red:       '#e0433d',   // letterhead red, lifted slightly for dark ground
  green:     '#2fb374',
  amber:     '#e0a132',
  radius:    12,
  radiusSm:  8,
  shadow:    '0 24px 60px -20px rgba(0,0,0,.7), 0 0 0 1px rgba(255,255,255,.04)',
};

export const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

export const STATUS_COLOR = {
  pending:   T.amber,      // in the shared queue, unclaimed
  claimed:   T.blue,       // one vendor has it and owes a decision
  returned:  T.amber,      // back with the requester to fix
  approved:  T.green,
  declined:  T.red,        // terminal
  withdrawn: T.textDim,
};

/** What each status means, for anywhere a badge alone is not enough. */
export const STATUS_HELP = {
  pending:   'Waiting for a vendor to claim it.',
  claimed:   'A vendor has taken it and owes a decision.',
  returned:  'Sent back to the requester to fix something.',
  approved:  'Invoice issued.',
  declined:  'A vendor said no. Raise a fresh request if the spend is still needed.',
  withdrawn: 'The requester pulled it.',
};

export const input = {
  width: '100%',
  padding: '10px 12px',
  background: T.bg,
  color: T.text,
  border: `1px solid ${T.border}`,
  borderRadius: T.radiusSm,
  font: `14px ${FONT}`,
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color .15s, box-shadow .15s',
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

export function button(kind = 'primary', disabled = false, size = 'md') {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: size === 'sm' ? '6px 11px' : '9px 16px',
    borderRadius: T.radiusSm,
    border: '1px solid transparent',
    font: `600 ${size === 'sm' ? 13 : 14}px ${FONT}`,
    lineHeight: 1.2,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    whiteSpace: 'nowrap',
    transition: 'background .15s, border-color .15s, color .15s, filter .15s',
  };
  if (kind === 'primary') return { ...base, background: T.blue, color: '#04121d' };
  if (kind === 'approve') return { ...base, background: T.green, color: '#04150c' };
  if (kind === 'danger')  return { ...base, background: 'transparent', color: T.red, borderColor: `${T.red}88` };
  if (kind === 'subtle')  return { ...base, background: 'transparent', color: T.textDim, borderColor: 'transparent' };
  return { ...base, background: T.panelAlt, color: T.text, borderColor: T.border };
}

/**
 * The few rules inline styles cannot carry. Injected once by App into a
 * <style> tag; nothing here is a framework, and nothing here sets layout.
 */
export const GLOBAL_CSS = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body, #root { height: 100%; }
  body { margin: 0; background: ${T.bg}; color: ${T.text}; -webkit-font-smoothing: antialiased; }
  select, input, button, textarea { font-family: inherit; }
  input:focus, select:focus, textarea:focus {
    border-color: ${T.blue} !important;
    box-shadow: 0 0 0 3px ${T.blue}2e;
  }
  input::placeholder, textarea::placeholder { color: ${T.textDim}99; }
  button:not(:disabled):hover { filter: brightness(1.1); }
  button:not(:disabled):active { filter: brightness(.95); }
  a { color: ${T.blue}; }
  .vi-row:hover > td { background: ${T.panelAlt}66; }
  .vi-clickable { cursor: pointer; }
  .vi-tab:hover { color: ${T.text} !important; }
  @keyframes vi-fade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes vi-rise { from { opacity: 0; transform: translateY(14px) scale(.985) } to { opacity: 1; transform: none } }
  .vi-backdrop { animation: vi-fade .16s ease-out; }
  .vi-modal { animation: vi-rise .2s cubic-bezier(.2,.8,.2,1); }
  @media (prefers-reduced-motion: reduce) { .vi-backdrop, .vi-modal { animation: none; } }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
`;
