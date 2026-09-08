import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getAdminKey, setAdminKey } from '../../api/client.js';
import { useAsync } from '../../hooks/useAsync.js';
import { JobStatusBadge } from '../../components/Badges.js';
import { formatBytes, formatDuration, formatNumber, formatRelative } from '../../components/Format.js';

/**
 * Development console.
 *
 * Exists to make the whole lifecycle drivable and observable from one screen:
 * generate a corpus, create a revision, run ingestion, watch a revision fail and
 * recover it. Everything here goes through the admin-guarded API.
 */
export function AdminPage() {
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState(getAdminKey());
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const stats = useAsync(() => api.adminStats(), []);
  const jobs = useAsync(() => api.listIngestionJobs(12), []);
  const scheduler = useAsync(() => api.schedulerStatus(), []);
  const jobDetail = useAsync(
    () => (selectedJobId ? api.getIngestionJob(selectedJobId) : Promise.resolve(null)),
    [selectedJobId],
  );

  const append = (line: string) =>
    setLog((current) => [...current, `${new Date().toLocaleTimeString()}  ${line}`].slice(-60));

  const refreshAll = () => {
    stats.reload();
    jobs.reload();
  };

  const run = async (name: string, action: () => Promise<string>) => {
    setBusy(name);
    try {
      append(await action());
    } catch (error) {
      append(`ERROR  ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setBusy(null);
      refreshAll();
    }
  };

  const generateCorpus = () =>
    run('corpus', async () => {
      const result = await api.generateCorpus({ profile: 'smoke', reset: true });
      return `Generated ${result.documentsWritten} documents (${result.revisionsWritten} revisions, ${result.evaluationQuestions} gold questions) in ${formatDuration(result.durationMs)}. All revisions are PENDING.`;
    });

  const runIngestion = () =>
    run('ingest', async () => {
      const result = await api.runIngestion();
      if (result.skippedReason) return `Run skipped: ${result.skippedReason}`;
      return `Ingestion ${result.status}: ${result.processed} processed, ${result.skipped} skipped, ${result.failed} failed, ${result.chunksCreated} chunks in ${formatDuration(result.durationMs)}.`;
    });

  const createRandomRevision = (corrupt: boolean) =>
    run(corrupt ? 'corrupt' : 'revise', async () => {
      // Pick a document that is safe to revise: synthetic, with a current revision.
      const documents = await api.listDocuments({ pageSize: 40, isActive: true });
      const candidate = documents.items.find((document) => document.currentRevisionNumber !== null);
      if (!candidate) return 'No document available to revise. Generate a corpus first.';

      const created = await api.createRevision(candidate.id, { corrupt });
      return corrupt
        ? `Created a damaged revision ${created.revisionNumber} of ${created.documentCode}. Run ingestion: it must fail for this revision only, leaving revision ${created.previousRevisionNumber} current and searchable.`
        : `Created revision ${created.revisionNumber} of ${created.documentCode}: ${created.changeSummary} Revision ${created.previousRevisionNumber} stays current until ingestion succeeds.`;
    });

  const reprocessFailed = () =>
    run('reprocess', async () => {
      const documents = await api.listDocuments({ pageSize: 40, processingStatus: 'FAILED' });
      const candidate = documents.items[0];
      if (!candidate) return 'No failed revisions to reprocess.';

      const detail = await api.getDocument(candidate.id);
      const failed = detail.revisions.find((revision) => revision.processingStatus === 'FAILED');
      if (!failed) return 'No failed revisions to reprocess.';

      const result = await api.reprocessRevision(failed.id);
      return `Reprocessed ${detail.documentCode} revision ${failed.revisionNumber}: ${result.processed} processed, ${result.failed} failed.`;
    });

  const data = stats.data;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Admin &amp; development</h1>
          <p className="page-subtitle">Drive the corpus, ingestion and revision lifecycle end to end.</p>
        </div>
        <div className="page-actions">
          <Link className="badge" style={{ padding: '7px 13px', textDecoration: 'none' }} to="/admin/retrieval">
            Retrieval debug →
          </Link>
          <button onClick={refreshAll}>Refresh</button>
        </div>
      </div>

      <div className="page-body">
        {stats.error && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-body stack">
              <div className="alert error">{stats.error.message}</div>
              <div>
                <div className="source-field-label">Admin API key</div>
                <div className="row">
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(event) => setKeyInput(event.target.value)}
                    placeholder="ADMIN_API_KEY"
                  />
                  <button
                    className="primary"
                    onClick={() => {
                      setAdminKey(keyInput);
                      refreshAll();
                    }}
                  >
                    Save
                  </button>
                </div>
                <div className="subtle" style={{ fontSize: 12, marginTop: 6 }}>
                  Must match ADMIN_API_KEY in the API environment. Held in this tab only.
                </div>
              </div>
            </div>
          </div>
        )}

        {data && (
          <>
            <div className="grid cols-4" style={{ marginBottom: 18 }}>
              <div className="stat">
                <div className="stat-label">Documents</div>
                <div className="stat-value">{formatNumber(data.documents.total)}</div>
                <div className="stat-hint">
                  {data.documents.active} active · {data.documents.inactive} inactive
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Revisions</div>
                <div className="stat-value">{formatNumber(data.revisions.total)}</div>
                <div className="stat-hint">{data.revisions.current} current</div>
              </div>
              <div className="stat">
                <div className="stat-label">Pending</div>
                <div className="stat-value" style={{ color: data.revisions.pending > 0 ? 'var(--warning)' : undefined }}>
                  {formatNumber(data.revisions.pending)}
                </div>
                <div className="stat-hint">awaiting ingestion</div>
              </div>
              <div className="stat">
                <div className="stat-label">Failed</div>
                <div className="stat-value" style={{ color: data.revisions.failed > 0 ? 'var(--danger)' : undefined }}>
                  {formatNumber(data.revisions.failed)}
                </div>
                <div className="stat-hint">previous revision still current</div>
              </div>

              <div className="stat">
                <div className="stat-label">Chunks</div>
                <div className="stat-value">{formatNumber(data.chunks.total)}</div>
                <div className="stat-hint">
                  {formatNumber(data.chunks.current)} current · {formatNumber(data.chunks.historical)} historical
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">OCR-derived</div>
                <div className="stat-value">{formatNumber(data.chunks.ocrDerived)}</div>
                <div className="stat-hint">chunks recovered from scans</div>
              </div>
              <div className="stat">
                <div className="stat-label">Embeddings</div>
                <div className="stat-value" style={{ fontSize: 15, paddingTop: 7 }}>
                  {data.embeddings.provider}
                </div>
                <div className="stat-hint">
                  {data.embeddings.model} · {data.embeddings.dimensions}d
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Database</div>
                <div className="stat-value" style={{ fontSize: 17, paddingTop: 5 }}>
                  {formatBytes(data.database.sizeBytes)}
                </div>
                <div className="stat-hint">
                  vector index {formatBytes(data.database.vectorIndexBytes)}
                </div>
              </div>
            </div>

            {data.embeddings.provider === 'mock' && (
              <div className="alert warn" style={{ marginBottom: 18 }}>
                <strong>Mock embeddings are in use.</strong> The pipeline runs end to end, but the vectors are
                deterministic hashes rather than semantic embeddings. Retrieval quality measured in this mode is
                not a real result — switch to <span className="mono">EMBEDDING_PROVIDER=openai</span> and
                re-ingest before drawing conclusions.
              </div>
            )}
          </>
        )}

        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-header">
            <h2 className="card-title">Lifecycle actions</h2>
            <span className="subtle" style={{ fontSize: 12 }}>
              {scheduler.data?.enabled
                ? `Scheduler on (${scheduler.data.cron})`
                : 'Scheduler disabled — run ingestion manually'}
            </span>
          </div>
          <div className="card-body">
            <div className="action-grid">
              <button className="action-card" disabled={busy !== null} onClick={() => void generateCorpus()}>
                <span className="action-title">
                  {busy === 'corpus' ? <span className="spinner" /> : '📚'} Generate mock documents
                </span>
                <span className="action-desc">
                  Replaces the corpus with a fresh deterministic smoke set. Every revision is written as PENDING.
                </span>
              </button>

              <button className="action-card" disabled={busy !== null} onClick={() => void createRandomRevision(false)}>
                <span className="action-title">
                  {busy === 'revise' ? <span className="spinner" /> : '📝'} Create a revision
                </span>
                <span className="action-desc">
                  Picks a document and publishes a new revision with one changed rule. The old revision stays
                  current until ingestion succeeds.
                </span>
              </button>

              <button className="action-card" disabled={busy !== null} onClick={() => void runIngestion()}>
                <span className="action-title">
                  {busy === 'ingest' ? <span className="spinner" /> : '⚙️'} Run ingestion
                </span>
                <span className="action-desc">
                  Discovers, parses, OCRs where needed, chunks, embeds and activates. Safe to run repeatedly.
                </span>
              </button>

              <button className="action-card" disabled={busy !== null} onClick={() => void createRandomRevision(true)}>
                <span className="action-title">
                  {busy === 'corrupt' ? <span className="spinner" /> : '💥'} Create a failing revision
                </span>
                <span className="action-desc">
                  Writes a damaged file. Ingestion must fail for that revision alone and leave the previous one
                  serving traffic.
                </span>
              </button>

              <button className="action-card" disabled={busy !== null} onClick={() => void reprocessFailed()}>
                <span className="action-title">
                  {busy === 'reprocess' ? <span className="spinner" /> : '🔁'} Reprocess a failed revision
                </span>
                <span className="action-desc">
                  Re-queues the first FAILED revision. It will fail again unless the underlying file was fixed.
                </span>
              </button>
            </div>

            {log.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="spread" style={{ marginBottom: 6 }}>
                  <div className="source-field-label">Activity</div>
                  <button className="ghost small" onClick={() => setLog([])}>
                    Clear
                  </button>
                </div>
                <div className="log-output">{log.join('\n')}</div>
              </div>
            )}
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Ingestion jobs</h2>
            {data?.ingestion.latestJob && (
              <span className="subtle" style={{ fontSize: 12 }}>
                last run {formatRelative(data.ingestion.latestJob.startedAt)}
              </span>
            )}
          </div>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th>Discovered</th>
                  <th>Processed</th>
                  <th>Skipped</th>
                  <th>Failed</th>
                  <th>Chunks</th>
                  <th>OCR</th>
                  <th>Duration</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {jobs.loading && (
                  <tr>
                    <td colSpan={11}>
                      <div className="row subtle">
                        <span className="spinner" /> Loading jobs…
                      </div>
                    </td>
                  </tr>
                )}

                {jobs.data?.length === 0 && (
                  <tr>
                    <td colSpan={11}>
                      <div className="empty">
                        <div className="empty-title">No ingestion runs yet</div>
                        <div className="empty-hint">Generate a corpus, then run ingestion.</div>
                      </div>
                    </td>
                  </tr>
                )}

                {jobs.data?.map((job) => (
                  <tr key={job.id}>
                    <td className="nowrap subtle">{formatRelative(job.startedAt)}</td>
                    <td className="nowrap">
                      <span className="badge">{job.trigger}</span>
                    </td>
                    <td className="nowrap">
                      <JobStatusBadge status={job.status} />
                    </td>
                    <td>{job.documentsDiscovered}</td>
                    <td>{job.documentsProcessed}</td>
                    <td>{job.documentsSkipped}</td>
                    <td style={{ color: job.documentsFailed > 0 ? 'var(--danger)' : undefined }}>
                      {job.documentsFailed}
                    </td>
                    <td>{formatNumber(job.chunksCreated)}</td>
                    <td>{job.ocrPages}</td>
                    <td className="nowrap">{formatDuration(job.durationMs)}</td>
                    <td>
                      <button
                        className="ghost small"
                        onClick={() => setSelectedJobId(selectedJobId === job.id ? null : job.id)}
                      >
                        {selectedJobId === job.id ? 'Hide' : 'Items'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {selectedJobId && jobDetail.data && (
            <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
              {jobDetail.data.errorSummary && (
                <div className="alert error" style={{ marginBottom: 12, whiteSpace: 'pre-wrap' }}>
                  {jobDetail.data.errorSummary}
                </div>
              )}
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Document</th>
                      <th>Rev</th>
                      <th>Outcome</th>
                      <th>Detail</th>
                      <th>Chunks</th>
                      <th>Pages</th>
                      <th>OCR</th>
                      <th>Duration</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobDetail.data.items.map((item) => (
                      <tr key={item.id}>
                        <td className="doc-code nowrap">{item.documentCode ?? '—'}</td>
                        <td>{item.revisionNumber ?? '—'}</td>
                        <td className="nowrap">
                          <span
                            className={`badge ${
                              item.outcome === 'PROCESSED'
                                ? 'success'
                                : item.outcome === 'FAILED'
                                  ? 'danger'
                                  : ''
                            }`}
                          >
                            {item.outcome}
                          </span>
                        </td>
                        <td style={{ maxWidth: 340 }}>
                          {item.errorMessage ? (
                            <span style={{ color: 'var(--danger)' }}>
                              [{item.errorStage}] {item.errorMessage}
                            </span>
                          ) : (
                            <span className="subtle">{item.skipReason ?? '—'}</span>
                          )}
                        </td>
                        <td>{item.chunksCreated}</td>
                        <td>{item.pages}</td>
                        <td>{item.ocrPages}</td>
                        <td className="nowrap">{formatDuration(item.durationMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
