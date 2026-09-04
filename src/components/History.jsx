import React, { useState } from 'react';
import { T, FONT } from '../theme.js';
import { Card, Table, Tr, Td, RowActions, Status, Banner, PageHeader, button } from './Shell.jsx';
import { api } from '../api.js';
import { shareInvoice, canShareFiles } from '../shareInvoice.js';
import { naira, downloadName } from '../../shared/reference.js';

/**
 * What this vendor has decided. Read-only apart from the document itself:
 * any user of the issuing vendor may re-download an issued invoice and gets
 * a byte-identical document naming the person who actually approved it.
 */
export default function History({ requests, me }) {
  const [error, setError] = useState(null);

  const rows = requests.filter((r) => r.status !== 'pending' && r.status !== 'claimed');
  const issued = rows.filter((r) => r.invoice_no);

  return (
    <>
      <PageHeader
        title="Approved by us"
        description="Every request this vendor has decided. Issued invoices can be downloaded or shared again at any time; the document names whoever approved it."
      />
      <Banner onClose={() => setError(null)}>{error}</Banner>
      <Card
        right={<span style={{ color: T.textDim, fontSize: 13 }}>{issued.length} invoice{issued.length === 1 ? '' : 's'} issued</span>}
        title="Decided requests"
      >
        <Table
          head={['Request', 'Invoice', 'For', 'Type', 'Period', { label: 'Total', right: true }, 'Status', '']}
          empty={{
            title: 'Nothing decided yet',
            hint: 'Requests you approve, send back or decline appear here. Approved ones carry their invoice.',
          }}
        >
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td mono>{r.request_ref}</Td>
              <Td mono>
                {/* Only the issuing vendor may pull the letterhead PDF; this
                    screen is only ever the issuing vendor's. */}
                {r.invoice_no
                  ? <a href={api.pdfUrl(r.invoice_no)} download={downloadName(r.invoice_no)}
                       style={{ color: T.blue, fontWeight: 600, textDecoration: 'none' }}>{r.invoice_no}</a>
                  : <span style={{ color: T.textDim }}>—</span>}
              </Td>
              <Td>
                {r.bu_code}
                {r.site_label && <span style={{ color: T.textDim }}> · {r.site_label}</span>}
              </Td>
              <Td>{r.type_label}</Td>
              <Td dim>{r.period_label}</Td>
              <Td right mono>{naira(r.issued_total_kobo ?? r.total_kobo)}</Td>
              <Td>
                <Status value={r.status} />
                {(r.decline_reason || r.return_reason) && (
                  <div style={{ fontSize: 12, color: T.textDim, marginTop: 4, maxWidth: 220, fontFamily: FONT }}>
                    {r.decline_reason || r.return_reason}
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
              <RowActions>
                {r.invoice_no && (
                  <>
                    <a href={api.pdfUrl(r.invoice_no)} download={downloadName(r.invoice_no)}
                       style={{ ...button('ghost', false, 'sm'), textDecoration: 'none' }}>Download</a>
                    {canShareFiles() && (
                      <button
                        onClick={() => shareInvoice(r.invoice_no).catch(
                          (err) => setError(err?.message || 'Could not share the invoice.'))}
                        style={button('ghost', false, 'sm')}
                      >Share</button>
                    )}
                  </>
                )}
              </RowActions>
            </Tr>
          ))}
        </Table>
      </Card>
    </>
  );
}
