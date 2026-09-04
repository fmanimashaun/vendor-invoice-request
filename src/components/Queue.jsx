import React, { useState } from 'react';
import { T, FONT, MONO, input as inputStyle } from '../theme.js';
import {
  Card, Table, Tr, Td, RowActions, Banner, Modal, Confirm, SuccessState, PageHeader, button,
} from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { shareInvoice, canShareFiles } from '../shareInvoice.js';
import { naira, downloadName } from '../../shared/reference.js';

/**
 * A vendor's main screen, in two halves.
 *
 * The OPEN QUEUE is every unclaimed request, shared with every other vendor.
 * Claiming one takes it out of everyone else's queue for good — it cannot be
 * handed back or picked up by anyone else, so from that point this vendor owes
 * a decision.
 *
 * YOURS TO DECIDE is what this vendor has claimed. Three ways out: approve,
 * which issues the invoice number and the letterheaded PDF and is the only
 * thing in the app that can; send back, which asks the requester to fix
 * something and keeps the request here; or decline, which ends it for
 * everybody.
 *
 * Deliberately no "release" button. A request that can bounce between vendors
 * has nobody accountable for it, and a requester chasing an approval needs one
 * name to chase. The escape hatch is the requester's own withdraw.
 */
const ACK_LABEL = {
  duplicate_period: 'confirmed duplicate period',
  amount_variance:  'confirmed unusual amount',
};

const ACK_TITLE = {
  duplicate_period:
    'Another active request already covered this period. The requester confirmed this one anyway.',
  amount_variance:
    'The amount differs sharply from the last approved one for this site. The requester confirmed it.',
};

/** How long a vendor has been sitting on something. */
function ageOf(at) {
  if (!at) return null;
  const hours = Math.floor((Date.now() - new Date(`${at.replace(' ', 'T')}Z`).getTime()) / 3600000);
  if (!Number.isFinite(hours) || hours < 0) return null;
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * One table of requests, with whatever actions the caller allows.
 *
 * The open queue and a vendor's claimed work show identical information — the
 * request does not change when it is claimed, only what can be done with it —
 * so this renders both rather than two tables drifting apart.
 */
function RequestRows({ title, subtitle, count, rows, actions, empty, showAge = false }) {
  return (
    <Card
      title={title}
      subtitle={subtitle}
      right={count != null && <span style={{ color: T.textDim, fontSize: 13 }}>{count}</span>}
    >
      <Table
        head={['Request', 'For', 'Type', 'Period', 'Detail',
               { label: 'Total', right: true }, 'Raised by', '']}
        empty={empty}
      >
        {rows.map((r) => {
          const age = showAge ? ageOf(r.claimed_at) : null;
          return (
            <Tr key={r.id}>
              <Td mono>
                {r.request_ref}
                {/* What the requester was warned about and confirmed past. This
                    is attribution, not a decision prompt: duplicates never
                    reach this queue, so the reviewer's job stays correctness. */}
                {(r.ack_flags || []).map((f) => (
                  <div key={f} title={ACK_TITLE[f] || f} style={{
                    marginTop: 4, fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
                    color: T.amber, whiteSpace: 'nowrap', fontFamily: FONT,
                  }}>⚠ {ACK_LABEL[f] || f}</div>
                ))}
                {/* Held for a while is worth seeing: nobody else can take this,
                    so a forgotten claim blocks the requester indefinitely. */}
                {age && (
                  <div style={{ marginTop: 4, fontSize: 11, color: T.textDim, fontFamily: FONT }}>
                    held {age}
                  </div>
                )}
              </Td>
              <Td>
                {r.bu_code}
                {r.site_label && <span style={{ color: T.textDim }}> · {r.site_label}</span>}
              </Td>
              <Td>{r.type_label}</Td>
              <Td dim>{r.period_label}</Td>
              <Td>
                <div>{r.description}</div>
                {r.asset_key && (
                  <div style={{ fontSize: 12, color: T.textDim, fontFamily: MONO }}>
                    {r.asset_key}
                  </div>
                )}
              </Td>
              <Td right mono>
                <div style={{ fontWeight: 700 }}>{naira(r.total_kobo)}</div>
                <div style={{ fontSize: 11, color: T.textDim }}>
                  {naira(r.amount_kobo)} + {naira(r.fee_kobo)}
                </div>
              </Td>
              <Td dim>
                <div>{r.created_by_name}</div>
                <div style={{ fontSize: 12 }}>{r.created_by_email}</div>
              </Td>
              <RowActions>{actions(r)}</RowActions>
            </Tr>
          );
        })}
      </Table>
    </Card>
  );
}

export default function Queue({ requests, me, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError]   = useState(null);
  const [issued, setIssued] = useState(null);      // { invoice_no, request }
  const [sharing, setSharing] = useState(false);
  const [approving, setApproving] = useState(null); // request awaiting the approve confirm
  // { request, kind: 'return' | 'decline' }
  const [asking, setAsking] = useState(null);
  const [reason, setReason] = useState('');
  const [askError, setAskError] = useState(null);

  const open = requests.filter((r) => r.status === 'pending');
  const mine = requests.filter((r) => r.status === 'claimed');
  const waiting = requests.filter((r) => r.status === 'returned');

  async function act(r, fn) {
    setError(null); setBusyId(r.id);
    try {
      await fn();
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally { setBusyId(null); }
  }

  const claim = (r) => act(r, () => api.claim(r.id));

  async function confirmApprove() {
    const r = approving;
    setError(null); setBusyId(r.id);
    try {
      const { invoice_no } = await api.approve(r.id);
      setApproving(null);
      setIssued({ invoice_no, request: r });
      onChanged?.();
    } catch (err) {
      setApproving(null);
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmAsk() {
    const { request: r, kind } = asking;
    setAskError(null); setBusyId(r.id);
    try {
      await (kind === 'decline' ? api.decline(r.id, reason) : api.returnRequest(r.id, reason));
      setAsking(null); setReason('');
      onChanged?.();
    } catch (err) {
      setAskError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function share(invoiceNo) {
    setError(null); setSharing(true);
    try {
      // Deliberately not awaiting anything before this call beyond the fetch
      // it needs: the share sheet must open inside the click gesture.
      await shareInvoice(invoiceNo);
    } catch (err) {
      setError(err?.message || 'Could not share the invoice.');
    } finally {
      setSharing(false);
    }
  }

  const ask = (r, kind) => { setAsking({ request: r, kind }); setReason(''); setAskError(null); };

  return (
    <>
      <PageHeader
        title="Queue"
        description="Every vendor sees the same open queue. Claim a request to take it off everyone else's list; approving issues the invoice number and the PDF on your letterhead."
      />

      <Banner onClose={() => setError(null)}>{error}</Banner>

      {/* Two tables, one row renderer. The request looks the same either
          side of a claim; only what you can do with it changes. */}
      <RequestRows
        title="Open queue"
        subtitle="Shared with every vendor. Claiming one takes it out of everyone else's queue for good — it cannot be handed back, so you will owe a decision on it."
        count={`${open.length} waiting`}
        rows={open}
        empty={{
          title: 'Nothing waiting',
          hint: 'New requests appear here the moment they are raised, for every vendor at once.',
        }}
        actions={(r) => (
          <button disabled={busyId === r.id} onClick={() => claim(r)}
                  style={button('primary', busyId === r.id, 'sm')}>
            {busyId === r.id ? '…' : 'Claim'}
          </button>
        )}
      />

      <RequestRows
        title="Yours to decide"
        subtitle="You claimed these. Each one needs an approval, a send-back or a decline."
        count={`${mine.length} claimed`}
        rows={mine}
        showAge
        empty={{
          title: 'Nothing claimed',
          hint: 'Claim something from the open queue above to work on it.',
        }}
        actions={(r) => (
          <>
            <button disabled={busyId === r.id} onClick={() => setApproving(r)}
                    style={button('approve', busyId === r.id, 'sm')}>
              {busyId === r.id ? '…' : 'Approve'}
            </button>
            <button disabled={busyId === r.id} onClick={() => ask(r, 'return')}
                    style={button('ghost', busyId === r.id, 'sm')}>
              Send back
            </button>
            <button disabled={busyId === r.id} onClick={() => ask(r, 'decline')}
                    style={button('danger', busyId === r.id, 'sm')}>
              Decline
            </button>
          </>
        )}
      />

      {waiting.length > 0 && (
        <RequestRows
          title="With the requester"
          subtitle="You sent these back to be fixed. They stay yours — nobody else can take them — and return here once corrected."
          count={`${waiting.length} awaiting a fix`}
          rows={waiting}
          actions={(r) => (
            <>
              <span style={{ color: T.textDim, fontSize: 12, maxWidth: 200, textAlign: 'right' }}>
                {r.return_reason}
              </span>
              <button disabled={busyId === r.id} onClick={() => ask(r, 'decline')}
                      style={button('danger', busyId === r.id, 'sm')}>
                Decline
              </button>
            </>
          )}
        />
      )}

      {approving && (
        <Confirm
          title={`Approve ${approving.request_ref}?`}
          confirmLabel="Approve and issue invoice"
          kind="approve"
          busy={busyId === approving.id}
          onConfirm={confirmApprove}
          onClose={() => setApproving(null)}
        >
          This reserves the next invoice number and renders the PDF on your
          letterhead, naming <strong style={{ color: T.text }}>{me.full_name}</strong> as
          the approver. It cannot be undone — a wrong approval is a declined
          resubmission and a gap in the sequence.
          <div style={{
            marginTop: 14, padding: '10px 12px', borderRadius: T.radiusSm,
            background: T.bg, border: `1px solid ${T.border}`, fontSize: 13,
          }}>
            <Line k="For" v={`${approving.bu_code}${approving.site_label ? ` · ${approving.site_label}` : ''}`} />
            <Line k="Type" v={`${approving.type_label} · ${approving.period_label}`} />
            <Line k="Bill" v={naira(approving.amount_kobo)} />
            <Line k="Fee" v={naira(approving.fee_kobo)} />
            <Line k="Total" v={naira(approving.total_kobo)} strong />
          </div>
        </Confirm>
      )}

      {issued && (
        <Modal title="Invoice issued" onClose={() => setIssued(null)} size="sm"
          actions={
            <>
              <button onClick={() => setIssued(null)} style={button('ghost')}>Close</button>
              <a href={api.pdfUrl(issued.invoice_no)} download={downloadName(issued.invoice_no)}
                 style={{ ...button('ghost'), textDecoration: 'none' }}>
                Download PDF
              </a>
              {/* Share hands the PDF straight to the OS share sheet, so the
                  reviewer picks the WhatsApp group without downloading first. */}
              {canShareFiles() && (
                <button onClick={() => share(issued.invoice_no)} disabled={sharing} style={button('primary', sharing)}>
                  {sharing ? 'Preparing…' : 'Share to WhatsApp'}
                </button>
              )}
            </>
          }>
          <SuccessState title={issued.invoice_no}>
            {issued.request.request_ref} is approved and the invoice is rendered
            on your letterhead. Share it with the requester — the document is the
            audit evidence for this payment. You can download it again any time
            from <strong style={{ color: T.text }}>Approved by us</strong>.
          </SuccessState>
        </Modal>
      )}

      {asking && (
        <Modal
          title={asking.kind === 'decline'
            ? `Decline ${asking.request.request_ref}`
            : `Send ${asking.request.request_ref} back`}
          onClose={() => setAsking(null)}
          size="sm"
          locked={busyId === asking.request.id}
          actions={
            <>
              <button onClick={() => setAsking(null)} style={button('ghost')}>Cancel</button>
              <button
                onClick={confirmAsk}
                disabled={reason.trim().length < 3 || busyId === asking.request.id}
                style={button(asking.kind === 'decline' ? 'danger' : 'primary',
                  reason.trim().length < 3 || busyId === asking.request.id)}
              >
                {busyId === asking.request.id ? 'Working…' : asking.kind === 'decline' ? 'Decline request' : 'Send back'}
              </button>
            </>
          }
        >
          <Banner onClose={() => setAskError(null)}>{askError}</Banner>
          <p style={{ margin: '0 0 14px', color: T.textDim, font: `14px ${FONT}`, lineHeight: 1.55 }}>
            {asking.kind === 'decline'
              ? 'This ends the request for good. No other vendor sees it, and the '
                + 'requester has to raise a fresh one — declining frees the period so a '
                + 'replacement is not blocked as a duplicate.'
              : 'The requester fixes it and it comes straight back to you, not to the '
                + 'shared queue. Nothing is issued and no invoice number is taken.'}
          </p>
          <input
            style={inputStyle}
            autoFocus
            value={reason}
            placeholder={asking.kind === 'decline'
              ? 'e.g. We do not serve this location'
              : 'e.g. Amount does not match the utility bill'}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && reason.trim().length >= 3) confirmAsk(); }}
          />
          <div style={{ marginTop: 6, fontSize: 12, color: T.textDim }}>The requester sees this note.</div>
        </Modal>
      )}
    </>
  );
}

const Line = ({ k, v, strong }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '2px 0' }}>
    <span style={{ color: T.textDim }}>{k}</span>
    <span style={{ color: T.text, fontWeight: strong ? 700 : 500, fontFamily: MONO }}>{v}</span>
  </div>
);
