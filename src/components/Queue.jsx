import React, { useState } from 'react';
import { T, FONT, input as inputStyle } from '../theme.js';
import { Card, Table, Td, Status, Banner, Modal, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { shareInvoice, canShareFiles } from '../shareInvoice.js';
import { naira, downloadName } from '../../shared/reference.js';

/**
 * A vendor's main screen. Approving here is what creates the invoice number
 * and makes the letterheaded PDF available — nothing else in the app can.
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

export default function Queue({ requests, me, onChanged }) {
  const [busyId, setBusyId] = useState(null);
  const [error, setError]   = useState(null);
  const [issued, setIssued] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState('');

  const pending = requests.filter((r) => r.status === 'pending');

  async function approve(r) {
    setError(null); setBusyId(r.id);
    try {
      const { invoice_no } = await api.approve(r.id);
      setIssued(invoice_no);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  async function confirmReject() {
    setError(null); setBusyId(rejecting.id);
    try {
      await api.reject(rejecting.id, reason);
      setRejecting(null); setReason('');
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
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

  return (
    <Card
      title="Pending requests"
      right={<span style={{ color: T.textDim, fontSize: 13 }}>{pending.length} awaiting review</span>}
    >
      <Banner onClose={() => setError(null)}>{error}</Banner>

      {issued && (
        <Banner kind="ok" onClose={() => setIssued(null)}>
          Issued <strong>{issued}</strong>.{' '}
          {/* Share hands the PDF straight to the OS share sheet, so the
              reviewer picks the WhatsApp group without downloading first.
              Falls back to a plain download where files cannot be shared. */}
          <button
            onClick={() => share(issued)}
            disabled={sharing}
            style={{ ...button('primary', sharing), padding: '5px 11px' }}
          >
            {sharing ? 'Preparing…' : canShareFiles() ? 'Share to WhatsApp' : 'Download PDF'}
          </button>{' '}
          <a
            href={api.pdfUrl(issued)}
            style={{ color: T.blue, fontWeight: 600 }}
            download={downloadName(issued)}
          >
            or download
          </a>
        </Banner>
      )}

      <Table
        head={['Request', 'For', 'Type', 'Period', 'Detail', { label: 'Total', right: true }, 'Raised by', '']}
        empty={pending.length === 0 ? 'Nothing pending. All caught up.' : null}
      >
        {pending.map((r) => (
          <tr key={r.id}>
            <Td mono>
              {r.request_ref}
              {/* What the requester was warned about and confirmed past. This
                  is attribution, not a decision prompt: duplicates never reach
                  this queue, so the reviewer's job stays correctness. */}
              {(r.ack_flags || []).map((f) => (
                <div key={f} title={ACK_TITLE[f] || f} style={{
                  marginTop: 4, fontSize: 11, fontWeight: 700, letterSpacing: 0.3,
                  color: T.amber, whiteSpace: 'nowrap',
                }}>⚠ {ACK_LABEL[f] || f}</div>
              ))}
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
                <div style={{ fontSize: 12, color: T.textDim, fontFamily: 'ui-monospace, monospace' }}>
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
            <Td>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  disabled={busyId === r.id}
                  onClick={() => approve(r)}
                  style={button('approve', busyId === r.id)}
                >
                  {busyId === r.id ? '…' : 'Approve'}
                </button>
                <button
                  disabled={busyId === r.id}
                  onClick={() => { setRejecting(r); setReason(''); }}
                  style={button('danger', busyId === r.id)}
                >
                  Reject
                </button>
              </div>
            </Td>
          </tr>
        ))}
      </Table>

      {rejecting && (
        <Modal
          title={`Reject ${rejecting.request_ref}`}
          onClose={() => setRejecting(null)}
          actions={
            <>
              <button onClick={() => setRejecting(null)} style={button('ghost')}>Cancel</button>
              <button
                onClick={confirmReject}
                disabled={reason.trim().length < 3 || busyId === rejecting.id}
                style={button('danger', reason.trim().length < 3 || busyId === rejecting.id)}
              >
                Reject request
              </button>
            </>
          }
        >
          <p style={{ margin: '0 0 12px', color: T.textDim, font: `14px ${FONT}`, lineHeight: 1.5 }}>
            The reason is shown to the requester. They can raise a corrected request afterwards —
            rejecting frees up the period so a replacement is not blocked as a duplicate.
          </p>
          <input
            style={inputStyle}
            autoFocus
            value={reason}
            placeholder="e.g. Amount does not match the utility bill"
            onChange={(e) => setReason(e.target.value)}
          />
        </Modal>
      )}
    </Card>
  );
}
