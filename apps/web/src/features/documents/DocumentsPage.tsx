import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DOCUMENT_TYPES } from '@docs-rag/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { formatNumber, formatRelative } from '../../components/Format.js';

/** Browse the document register with its per-document revision state. */
export function DocumentsPage() {
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState('');
  const [documentType, setDocumentType] = useState('');
  const [processingStatus, setProcessingStatus] = useState('');
  const [page, setPage] = useState(1);

  const facets = useAsync(() => api.documentFacets(), []);

  const documents = useAsync(
    () =>
      api.listDocuments({
        page,
        pageSize: 25,
        ...(search ? { search } : {}),
        ...(department ? { department } : {}),
        ...(documentType ? { documentType } : {}),
        ...(processingStatus ? { processingStatus } : {}),
      }),
    [page, search, department, documentType, processingStatus],
  );

  const resetTo = (apply: () => void) => {
    apply();
    setPage(1);
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Documents</h1>
          <p className="page-subtitle">
            {documents.data ? `${formatNumber(documents.data.total)} documents in the register` : 'Loading…'}
          </p>
        </div>
      </div>

      <div className="page-body">
        <div className="filters-bar">
          <input
            type="search"
            placeholder="Search code, title or description…"
            value={search}
            onChange={(event) => resetTo(() => setSearch(event.target.value))}
          />

          <select value={department} onChange={(event) => resetTo(() => setDepartment(event.target.value))}>
            <option value="">All departments</option>
            {(facets.data?.departments ?? []).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>

          <select value={documentType} onChange={(event) => resetTo(() => setDocumentType(event.target.value))}>
            <option value="">All types</option>
            {DOCUMENT_TYPES.map((value) => (
              <option key={value} value={value}>
                {value.replace(/_/g, ' ')}
              </option>
            ))}
          </select>

          <select
            value={processingStatus}
            onChange={(event) => resetTo(() => setProcessingStatus(event.target.value))}
          >
            <option value="">Any processing state</option>
            <option value="PENDING">Has pending revision</option>
            <option value="FAILED">Has failed revision</option>
            <option value="READY">Has ready revision</option>
          </select>

          {(search || department || documentType || processingStatus) && (
            <button
              className="ghost"
              onClick={() =>
                resetTo(() => {
                  setSearch('');
                  setDepartment('');
                  setDocumentType('');
                  setProcessingStatus('');
                })
              }
            >
              Clear
            </button>
          )}
        </div>

        {documents.error && <div className="alert error">{documents.error.message}</div>}

        <div className="card">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Title</th>
                  <th>Department</th>
                  <th>Type</th>
                  <th>Current rev</th>
                  <th>Revisions</th>
                  <th>Chunks</th>
                  <th>State</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {documents.loading && (
                  <tr>
                    <td colSpan={9}>
                      <div className="row subtle">
                        <span className="spinner" /> Loading documents…
                      </div>
                    </td>
                  </tr>
                )}

                {!documents.loading && documents.data?.items.length === 0 && (
                  <tr>
                    <td colSpan={9}>
                      <div className="empty">
                        <div className="empty-title">No documents match</div>
                        <div className="empty-hint">
                          Adjust the filters, or generate a corpus from the Admin page.
                        </div>
                      </div>
                    </td>
                  </tr>
                )}

                {documents.data?.items.map((document) => (
                  <tr key={document.id}>
                    <td className="nowrap">
                      <Link to={`/documents/${document.id}`} className="doc-code">
                        {document.documentCode}
                      </Link>
                    </td>
                    <td>
                      <Link to={`/documents/${document.id}`}>{document.title}</Link>
                    </td>
                    <td className="nowrap">{document.department}</td>
                    <td className="nowrap">
                      <span className="badge">{document.documentType.replace(/_/g, ' ')}</span>
                    </td>
                    <td className="nowrap">
                      {document.currentRevisionNumber ? `rev ${document.currentRevisionNumber}` : '—'}
                    </td>
                    <td>{document.revisionCount}</td>
                    <td>{formatNumber(document.chunkCount)}</td>
                    <td className="nowrap">
                      <div className="row" style={{ gap: 5 }}>
                        {!document.isActive && <span className="badge">INACTIVE</span>}
                        {document.pendingRevisionCount > 0 && (
                          <span className="badge warning">{document.pendingRevisionCount} PENDING</span>
                        )}
                        {document.failedRevisionCount > 0 && (
                          <span className="badge danger">{document.failedRevisionCount} FAILED</span>
                        )}
                        {document.isActive &&
                          document.pendingRevisionCount === 0 &&
                          document.failedRevisionCount === 0 && <span className="badge success">READY</span>}
                      </div>
                    </td>
                    <td className="nowrap subtle">{formatRelative(document.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {documents.data && documents.data.totalPages > 1 && (
            <div className="card-header" style={{ borderTop: '1px solid var(--border)', borderBottom: 'none' }}>
              <span className="subtle">
                Page {documents.data.page} of {documents.data.totalPages}
              </span>
              <div className="row">
                <button className="small" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                  Previous
                </button>
                <button
                  className="small"
                  disabled={page >= documents.data.totalPages}
                  onClick={() => setPage((value) => value + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
