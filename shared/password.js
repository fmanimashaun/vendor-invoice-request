// Password policy, shared so the form and the server cannot disagree about
// what is acceptable.
//
// Length is the rule that matters. There are deliberately NO composition
// requirements — no "must contain an uppercase letter and a symbol". Those
// rules are counterproductive: they push people towards `Password1!`, which is
// short, predictable and in every cracking dictionary, and away from a long
// passphrase, which is neither. NIST 800-63B says the same, and dropped
// composition rules from its guidance for exactly this reason.
//
// What is checked instead: enough length to be expensive to guess, and a small
// blocklist of the shapes people actually pick when told "make one up".

export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;

/** Shown under every password field. Keep it short and non-hectoring. */
export const PASSWORD_HINT =
  `At least ${MIN_LENGTH} characters. A short phrase you will remember is `
  + 'stronger than a scramble you will write down.';

// Not a serious dictionary — a Worker cannot carry one — but it catches the
// handful of things people type when a form demands a password right now.
const OBVIOUS = [
  'password', 'passw0rd', 'letmein', 'welcome', 'qwerty', 'admin', 'iloveyou',
  'monkey', 'dragon', 'football', 'baseball', 'sunshine', 'princess',
  'trustno1', 'changeme', 'temporary', 'test1234', 'secret',
];

/**
 * Returns a list of problems; empty means acceptable.
 *
 * `context` lets the caller reject a password that merely restates something
 * already known about the account, which is a common pattern for an admin
 * setting a temporary one.
 */
export function checkPassword(password, context = {}) {
  const pw = String(password ?? '');
  const errs = [];

  if (pw.length < MIN_LENGTH) {
    errs.push(`Use at least ${MIN_LENGTH} characters.`);
  }
  if (pw.length > MAX_LENGTH) {
    errs.push(`Keep it under ${MAX_LENGTH} characters.`);
  }
  if (pw && pw.trim() !== pw) {
    errs.push('Leading or trailing spaces are too easy to lose; trim them.');
  }

  const lower = pw.toLowerCase();

  // 'aaaaaaaaaaaa' and 'abababababab' clear a length check and nothing else.
  if (pw.length >= MIN_LENGTH && new Set(pw).size <= 3) {
    errs.push('Too repetitive — use more variety than a couple of characters.');
  }
  if (/^(01234|12345|abcde|qwert)/i.test(pw)) {
    errs.push('Do not start with a keyboard or counting sequence.');
  }
  // Matched against the whole password, not as a substring. Rejecting anything
  // *containing* "password" would throw out `a-long-enough-password`, which is
  // a perfectly good passphrase, while `Password1!` is the actual problem. So
  // strip the decoration people add and compare what is left: this catches
  // `letmein123` and `P@ssw0rd!` and leaves real phrases alone.
  const core = lower.replace(/[^a-z0-9]/g, '').replace(/[0-9]{1,4}$/, '');
  const deleeted = core
    .replace(/0/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/4/g, 'a')
    .replace(/5/g, 's').replace(/7/g, 't').replace(/@/g, 'a');
  if (OBVIOUS.includes(core) || OBVIOUS.includes(deleeted)) {
    errs.push('That is one of the first passwords anyone guesses.');
  }

  // A password that is essentially the email or the person's name is no secret
  // from anyone who can see the roster.
  //
  // The test is whether the identity is doing the WORK, not whether it appears
  // at all: remove it and see what is left. `samantha@client.example` as a
  // password fails; `a brand new passphrase here` for someone whose address
  // starts "phrase" does not, and rejecting it would be baffling.
  for (const [label, value] of Object.entries(context)) {
    const v = String(value ?? '').toLowerCase().trim();
    const needles = [v, v.includes('@') ? v.split('@')[0] : null]
      .filter((x) => x && x.length >= 4);
    for (const needle of needles) {
      if (!lower.includes(needle)) continue;
      const remainder = lower.split(needle).join('').replace(/[^a-z0-9]/g, '');
      if (remainder.length < MIN_LENGTH) {
        errs.push(`Do not build it out of your ${label}.`);
        break;
      }
    }
  }

  return errs;
}

/** Rough strength for a meter. Deliberately about length, like the policy. */
export function passwordStrength(password) {
  const pw = String(password ?? '');
  if (!pw) return { score: 0, label: '' };
  if (checkPassword(pw).length) return { score: 1, label: 'Not accepted yet' };
  if (pw.length >= 20) return { score: 4, label: 'Strong' };
  if (pw.length >= 16) return { score: 3, label: 'Good' };
  return { score: 2, label: 'Acceptable' };
}
