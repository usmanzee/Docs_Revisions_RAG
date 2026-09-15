import { useState } from 'react';
import { DocumentDetailPage } from '../documents/DocumentDetailPage.js';
import { adminApi } from '../../api/admin-client.js';

/**
 * A document with its revision lifecycle controls.
 *
 * The viewing half is the same component the employee application uses - there
 * is no value in two renderings of the same metadata drifting apart. What this
 * adds is the ability to change things: publish a revision, publish a
 * deliberately broken one, run ingestion, reprocess a failure.
 *
 * Those controls live here, in the lazily-loaded console bundle, rather than
 * behind a flag inside the shared component.
 */
export function AdminDocumentPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const act = async (key: string, action: () => Promise<{ tone: 'ok' | 'error'; text: string }>) => {
    setBusy(key);
    setNotice(null);
    try {
      setNotice(await action());
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {notice && (
        <div className="page-body" style={{ paddingBottom: 0 }}>
          <div className={`alert ${notice.tone === 'ok' ? 'ok' : 'error'}`}>{notice.text}</div>
        </div>
      )}

      <DocumentDetailPage
        backTo="/admin/documents"
        renderControls={({ documentId: id, reload }) => (
          <>
            <button
              disabled={busy !== null}
              onClick={() =>
                void act('revision', async () => {
                  const created = await adminApi.createRevision(id, { corrupt: false });
                  reload();
                  return {
                    tone: 'ok',
                    text: `Created revision ${created.revisionNumber}: ${created.changeSummary} Revision ${created.previousRevisionNumber} stays current until ingestion succeeds.`,
                  };
                })
              }
            >
              {busy === 'revision' ? <span className="spinner" /> : '+ Create revision'}
            </button>

            <button
              className="danger"
              disabled={busy !== null}
              onClick={() =>
                void act('corrupt', async () => {
                  const created = await adminApi.createRevision(id, { corrupt: true });
                  reload();
                  return {
                    tone: 'ok',
                    text: `Created revision ${created.revisionNumber} with a deliberately damaged file. Run ingestion: it must fail for this revision only, leaving revision ${created.previousRevisionNumber} current.`,
                  };
                })
              }
            >
              {busy === 'corrupt' ? <span className="spinner" /> : 'Create corrupt revision'}
            </button>

            <button
              className="primary"
              disabled={busy !== null}
              onClick={() =>
                void act('ingest', async () => {
                  const result = await adminApi.runIngestion();
                  reload();
                  return {
                    tone: result.failed > 0 ? 'error' : 'ok',
                    text: `Ingestion ${result.status}: ${result.processed} processed, ${result.skipped} skipped, ${result.failed} failed.`,
                  };
                })
              }
            >
              {busy === 'ingest' ? <span className="spinner" /> : 'Run ingestion'}
            </button>
          </>
        )}
        renderRevisionControls={({ revisionId, processingStatus, reload }) =>
          processingStatus === 'FAILED' ? (
            <button
              className="small"
              disabled={busy === revisionId}
              onClick={() =>
                void act(revisionId, async () => {
                  const result = await adminApi.reprocessRevision(revisionId);
                  reload();
                  return {
                    tone: result.failed > 0 ? 'error' : 'ok',
                    text: `Reprocessed: ${result.processed} succeeded, ${result.failed} failed.`,
                  };
                })
              }
            >
              {busy === revisionId ? <span className="spinner" /> : 'Reprocess'}
            </button>
          ) : null
        }
      />
    </>
  );
}
