import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { RevisionSummary } from '@docs-rag/shared';
import { api } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { ExtractionBadge, ProcessingBadge } from '../../components/Badges.js';
import { formatBytes, formatDate, formatDateTime, formatNumber } from '../../components/Format.js';

/**
 * One document, its revision history, and the ability to inspect any revision -
 * including superseded ones, which is what makes the lifecycle legible rather
 * than something you have to take on trust.
 */
export function DocumentDetailPage() {
  const { documentId } = useParams();
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null);
  const [tab, setTab] = useState<'content' | 'chunks'>('content');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const document = useAsync(() => api.getDocument(documentId as string), [documentId]);

  const revisions = document.data?.revisions ?? [];
  const activeRevision: RevisionSummary | undefined =
    revisions.find((revision) => revision.id === selectedRevisionId) ??
    revisions.find((revision) => revision.isCurrent) ??
    revisions[0];

  const content = useAsync(
    () => (activeRevision && tab === 'content' ? api.getRevisionContent(activeRevision.id, 12) : Promise.resolve(null)),
    [activeRevision?.id, tab],
  );

  const chunks = useAsync(
    () => (activeRevision && tab === 'chunks' ? api.getRevisionChunks(activeRevision.id) : Promise.resolve(null)),
    [activeRevision?.id, tab],
  );

  const createRevision = async (corrupt: boolean) => {
    if (!document.data) return;
    setBusy(corrupt ? 'corrupt' : 'revision');
    setNotice(null);

    try {
      const created = await api.createRevision(document.data.id, { corrupt });
      setNotice({
        tone: 'ok',
        text: corrupt
          ? `Created revision ${created.revisionNumber} with a deliberately damaged file. Run ingestion: it must fail for this revision only, leaving revision ${created.previousRevisionNumber} current.`
          : `Created revision ${created.revisionNumber}: ${created.changeSummary} Revision ${created.previousRevisionNumber} stays current until ingestion succeeds.`,
      });
      document.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const runIngestion = async () => {
    setBusy('ingest');
    setNotice(null);
    try {
      const result = await api.runIngestion();
      setNotice({
        tone: result.failed > 0 ? 'error' : 'ok',
        text: `Ingestion ${result.status}: ${result.processed} processed, ${result.skipped} skipped, ${result.failed} failed.`,
      });
      document.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  const reprocess = async (revisionId: string) => {
    setBusy(revisionId);
    try {
      await api.reprocessRevision(revisionId);
      document.reload();
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  if (document.loading) {
    return (
      <div className="page-body">
        <div className="row subtle">
          <span className="spinner" /> Loading document…
        </div>
      </div>
    );
  }

  if (document.error || !document.data) {
    return (
      <div className="page-body">
        <div className="alert error">{document.error?.message ?? 'Document not found'}</div>
        <p style={{ marginTop: 12 }}>
          <Link to="/documents">← Back to documents</Link>
        </p>
      </div>
    );
  }

  const detail = document.data;

  return (
    <>
      <div className="page-header">
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 8 }}>
            <Link to="/documents" className="subtle">
              Documents
            </Link>
            <span className="subtle">/</span>
            <span className="doc-code">{detail.documentCode}</span>
          </div>
          <h1 className="page-title" style={{ marginTop: 3 }}>
            {detail.title}
          </h1>
          <p className="page-subtitle">
            {detail.department} · {detail.documentType.replace(/_/g, ' ')}
            {detail.category ? ` · ${detail.category}` : ''}
            {detail.owner ? ` · owned by ${detail.owner}` : ''}
          </p>
        </div>

        <div className="page-actions">
          <button disabled={busy !== null} onClick={() => void createRevision(false)}>
            {busy === 'revision' ? <span className="spinner" /> : '+ Create revision'}
          </button>
          <button className="danger" disabled={busy !== null} onClick={() => void createRevision(true)}>
            {busy === 'corrupt' ? <span className="spinner" /> : 'Create corrupt revision'}
          </button>
          <button className="primary" disabled={busy !== null} onClick={() => void runIngestion()}>
            {busy === 'ingest' ? <span className="spinner" /> : 'Run ingestion'}
          </button>
        </div>
      </div>

      <div className="page-body">
        {notice && (
          <div className={`alert ${notice.tone === 'ok' ? 'ok' : 'error'}`} style={{ marginBottom: 16 }}>
            {notice.text}
          </div>
        )}

        <div className="grid cols-4" style={{ marginBottom: 18 }}>
          <div className="stat">
            <div className="stat-label">Current revision</div>
            <div className="stat-value">{detail.currentRevisionNumber ?? '—'}</div>
            <div className="stat-hint">effective {formatDate(detail.currentEffectiveDate)}</div>
          </div>
          <div className="stat">
            <div className="stat-label">Revisions</div>
            <div className="stat-value">{detail.revisionCount}</div>
            <div className="stat-hint">
              {detail.pendingRevisionCount} pending · {detail.failedRevisionCount} failed
            </div>
          </div>
          <div className="stat">
            <div className="stat-label">Chunks</div>
            <div className="stat-value">{formatNumber(detail.chunkCount)}</div>
            <div className="stat-hint">in the current revision</div>
          </div>
          <div className="stat">
            <div className="stat-label">Status</div>
            <div className="stat-value" style={{ fontSize: 17, paddingTop: 5 }}>
              {detail.isActive ? 'Active' : 'Inactive'}
            </div>
            <div className="stat-hint">{detail.isActive ? 'included in retrieval' : 'excluded from retrieval'}</div>
          </div>
        </div>

        {detail.description && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-body">{detail.description}</div>
          </div>
        )}

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-header">
            <h2 className="card-title">Revision history</h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              Superseded revisions keep their chunks, so historical questions stay answerable.
            </span>
          </div>
          <div className="card-body">
            <div className="revision-timeline">
              {revisions.map((revision, index) => (
                <div className="revision-row" key={revision.id}>
                  <div className="revision-marker">
                    <div
                      className={`revision-dot ${
                        revision.isCurrent
                          ? 'current'
                          : revision.processingStatus === 'PENDING'
                            ? 'pending'
                            : revision.processingStatus === 'FAILED'
                              ? 'failed'
                              : ''
                      }`}
                    />
                    {index < revisions.length - 1 && <div className="revision-line" />}
                  </div>

                  <div className="revision-content">
                    <div className="spread" style={{ alignItems: 'flex-start' }}>
                      <div style={{ minWidth: 0 }}>
                        <div className="row wrap" style={{ gap: 7 }}>
                          <span className="revision-number">Revision {revision.revisionNumber}</span>
                          {revision.isCurrent && <span className="badge success">CURRENT</span>}
                          <ProcessingBadge status={revision.processingStatus} />
                          {!revision.isCurrent && revision.status === 'SUPERSEDED' && (
                            <span className="badge">SUPERSEDED</span>
                          )}
                        </div>

                        <div className="subtle" style={{ fontSize: 12.5, marginTop: 3 }}>
                          Effective {formatDate(revision.effectiveDate)} · {revision.chunkCount} chunks ·{' '}
                          {formatBytes(revision.fileSizeBytes)}
                          {revision.pageCount ? ` · ${revision.pageCount} pages` : ''}
                          {revision.ocrPageCount > 0 ? ` · ${revision.ocrPageCount} OCR pages` : ''}
                        </div>

                        {revision.changeSummary && (
                          <div style={{ fontSize: 13, marginTop: 5 }}>{revision.changeSummary}</div>
                        )}

                        {revision.processingError && (
                          <div className="alert error" style={{ marginTop: 8, fontSize: 12.5 }}>
                            {revision.processingError}
                          </div>
                        )}

                        <div className="subtle mono" style={{ fontSize: 11.5, marginTop: 5 }}>
                          {revision.filePath}
                        </div>
                      </div>

                      <div className="row" style={{ flex: 'none', gap: 6 }}>
                        <button
                          className="small"
                          onClick={() => {
                            setSelectedRevisionId(revision.id);
                            setTab('content');
                          }}
                        >
                          Inspect
                        </button>
                        <a className="badge" style={{ padding: '5px 10px' }} href={api.revisionFileUrl(revision.id)}>
                          File
                        </a>
                        {revision.processingStatus === 'FAILED' && (
                          <button
                            className="small"
                            disabled={busy === revision.id}
                            onClick={() => void reprocess(revision.id)}
                          >
                            {busy === revision.id ? <span className="spinner" /> : 'Reprocess'}
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {activeRevision && (
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                Revision {activeRevision.revisionNumber}
                {activeRevision.isCurrent ? ' (current)' : ''}
              </h2>
              <div className="row">
                <button
                  className={tab === 'content' ? 'primary small' : 'small'}
                  onClick={() => setTab('content')}
                >
                  Extracted text
                </button>
                <button className={tab === 'chunks' ? 'primary small' : 'small'} onClick={() => setTab('chunks')}>
                  Chunks
                </button>
              </div>
            </div>

            <div className="card-body">
              <div className="subtle" style={{ fontSize: 12, marginBottom: 12 }}>
                Processed {formatDateTime(activeRevision.processedAt)} · file hash{' '}
                <span className="mono">{activeRevision.fileHash.slice(0, 12)}</span>
                {activeRevision.contentHash && (
                  <>
                    {' '}· content hash <span className="mono">{activeRevision.contentHash.slice(0, 12)}</span>
                  </>
                )}
              </div>

              {tab === 'content' && (
                <>
                  {content.loading && (
                    <div className="row subtle">
                      <span className="spinner" /> Extracting text…
                    </div>
                  )}
                  {content.error && <div className="alert error">{content.error.message}</div>}
                  {content.data && (
                    <div className="stack">
                      {content.data.pages.map((page) => (
                        <div key={page.pageNumber}>
                          <div className="row" style={{ marginBottom: 6 }}>
                            <strong style={{ fontSize: 12.5 }}>Page {page.pageNumber}</strong>
                            <ExtractionBadge method={page.extractionMethod} />
                          </div>
                          <div className="page-preview">{page.text || '(no text on this page)'}</div>
                        </div>
                      ))}
                      {content.data.truncated && (
                        <div className="subtle">Only the first pages are shown.</div>
                      )}
                    </div>
                  )}
                </>
              )}

              {tab === 'chunks' && (
                <>
                  {chunks.loading && (
                    <div className="row subtle">
                      <span className="spinner" /> Loading chunks…
                    </div>
                  )}
                  {chunks.data && chunks.data.length === 0 && (
                    <div className="empty">
                      <div className="empty-title">No chunks</div>
                      <div className="empty-hint">
                        This revision has not been processed yet, or processing failed.
                      </div>
                    </div>
                  )}
                  {chunks.data && chunks.data.length > 0 && (
                    <div className="stack tight">
                      {chunks.data.map((chunk) => (
                        <div className="chunk-item" key={chunk.id}>
                          <div className="chunk-head">
                            <span className="badge">#{chunk.chunkIndex}</span>
                            {chunk.chunkType === 'PARENT' && <span className="badge accent">PARENT</span>}
                            <strong style={{ fontSize: 12.5 }}>{chunk.sectionTitle ?? 'Untitled section'}</strong>
                            {chunk.pageStart !== null && (
                              <span className="subtle" style={{ fontSize: 11.5 }}>
                                page {chunk.pageStart}
                              </span>
                            )}
                            <ExtractionBadge method={chunk.extractionMethod} />
                            <span className="subtle" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
                              {chunk.tokenCount} tokens
                              {chunk.hasEmbedding ? '' : ' · not embedded'}
                            </span>
                          </div>
                          <div className="chunk-text">{chunk.content.slice(0, 600)}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
