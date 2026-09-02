import React, { useState } from 'react';
import { T } from '../theme.js';
import { Card, Table, Td, Status, Banner, button } from './Shell.jsx';
import { api, ApiError } from '../api.js';
import { shareInvoice, canShareFiles } from '../shareInvoice.js';
import { naira, downloadName } from '../../shared/reference.js';

/** Decided and in-flight requests. The client sees its own; a vendor sees what it decided. */
export default function History({ requests, me, acting, onChanged }) {
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  const rows = me.org === 'vendor'
    ? requests.filter((r) => r.status !== 'pending')
    : requests;

  async function withdraw(r) {
    setError(null); setBusyId(r.id);
    try {
      await api.withdraw(r.id);
      onChanged?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Network problem. Try again.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card title={me.org === 'vendor' ? 'Approved by us'
                 : acting === 'admin' ? 'All requests' : 'My requests'}>
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Table
        head={['Request', 'Invoice', 'For', 'Type', 'Period', { label: 'Total', right: true }, 'Status', '']}
        empty={{
          title: 'Nothing here yet',
          hint: 'Requests you approve or reject appear here, with a link to the invoice.',
        }}
      >
        {rows.map((r) => (
          <tr key={r.id}>
            <Td mono>{r.request_ref}</Td>
            <Td mono>
              {/* Only the issuing vendor may pull the letterhead PDF. The client sees the
                  number so they can quote it, but not the document. */}
              {r.invoice_no
                ? (me.org === 'vendor'
                    ? <>
                        <a href={api.pdfUrl(r.invoice_no)} download={downloadName(r.invoice_no)}
                           style={{ color: T.blue, fontWeight: 600 }}>{r.invoice_no}</a>
                        {canShareFiles() && (
                          <button
                            onClick={() => shareInvoice(r.invoice_no).catch(
                              (err) => setError(err?.message || 'Could not share the invoice.'))}
                            style={{ ...button('ghost'), padding: '3px 8px', marginLeft: 8, fontSize: 12 }}
                          >Share</button>
                        )}
                      </>
                    : <span>{r.invoice_no}</span>)
                : <span style={{ color: T.textDim }}>—</span>}
            </Td>
            <Td>
              {r.bu_code}
              {r.site_label && <span style={{ color: T.textDim }}> · {r.site_label}</span>}
            </Td>
            <Td>{r.type_label}</Td>
            <Td dim>{r.period_label}</Td>
            <Td right mono>{naira(r.total_kobo)}</Td>
            <Td>
              <Status value={r.status} />
              {r.status === 'rejected' && r.reject_reason && (
                <div style={{ fontSize: 12, color: T.textDim, marginTop: 4, maxWidth: 220 }}>
                  {r.reject_reason}
                </div>
              )}
              {r.status === 'approved' && (r.approver_name || r.decided_by_name) && (
                <div style={{ fontSize: 12, color: T.textDim, marginTop: 4 }}>
                  {/* The name copied onto the invoice, not the current row for
                      that user — this is what the PDF actually says. */}
                  by {r.approver_name || r.decided_by_name}
                  {r.approver_title && <> · {r.approver_title}</>}
                </div>
              )}
            </Td>
            <Td right>
              {r.status === 'pending' && me.org === 'client' && r.created_by === me.id && (
                <button disabled={busyId === r.id} onClick={() => withdraw(r)} style={button('ghost', busyId === r.id)}>
                  Withdraw
                </button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
