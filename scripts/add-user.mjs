// Create a user, hashing the password for vendor accounts.
//
// Vendor accounts are the ones created by hand. They carry the job title,
// email and phone that appear in the signature block of every invoice the
// person approves, so all four are required:
//
//   node scripts/add-user.mjs vendor <vendor-code> someone@example.com "Their Name" \
//        approver "Business Development Manager" "+234 801 234 5678" 'a-long-password'
//
// client accounts are normally created by SSO on first sign-in. This is only
// for seeding the first admin, who owns the vendor list and every roster:
//
//   node scripts/add-user.mjs client someone@example.com "Someone" admin
//
// Prints SQL. Pipe it into wrangler:
//   node scripts/add-user.mjs ... > u.sql
//   npx wrangler d1 execute vendor-invoice-request --local --file=u.sql

import { hashPassword } from '../worker/auth.js';

const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const usage = () => {
  console.error(
    'usage:\n' +
    '  add-user.mjs vendor <vendor-code> <email> <"Full Name"> <requester|approver|admin> <"Job Title"> <phone> <password>\n' +
    '  add-user.mjs client <email> <"Full Name"> <requester|approver|admin>',
  );
  process.exit(1);
};

const [org, ...rest] = process.argv.slice(2);
if (!['client', 'vendor'].includes(org)) usage();

const cols = ['email', 'full_name', 'org', 'role', 'created_by'];
let vals;

if (org === 'vendor') {
  const [code, email, fullName, role, jobTitle, phone, password] = rest;
  if (!code || !email || !fullName || !role || !jobTitle || !phone || !password) usage();
  if (!['requester', 'approver', 'admin'].includes(role)) { console.error('bad role'); process.exit(1); }
  if (password.length < 12) {
    console.error('Vendor users need a password of at least 12 characters.');
    process.exit(1);
  }
  const { hash, salt, iterations } = await hashPassword(password);
  vals = [q(email.toLowerCase()), q(fullName), q('vendor'), q(role), q('script')];
  // Resolved in SQL so the caller never has to look up the surrogate key.
  cols.push('vendor_id', 'job_title', 'phone', 'pw_hash', 'pw_salt', 'pw_iterations');
  vals.push(`(SELECT id FROM vendors WHERE code = ${q(code)})`,
            q(jobTitle), q(phone), q(hash), q(salt), String(iterations));
} else {
  const [email, fullName, role] = rest;
  if (!email || !fullName || !role) usage();
  if (!['requester', 'approver', 'admin'].includes(role)) { console.error('bad role'); process.exit(1); }
  vals = [q(email.toLowerCase()), q(fullName), q('client'), q(role), q('script')];
}

console.log(`INSERT INTO users (${cols.join(', ')})\nVALUES (${vals.join(', ')});`);
