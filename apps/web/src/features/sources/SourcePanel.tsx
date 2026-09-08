import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ChunkDetail, Citation } from '@docs-rag/shared';
import { api } from '../../api/client.js';
import { ExtractionBadge } from '../../components/Badges.js';
import { formatDate } from '../../components/Format.js';

/**
 * Source inspector.
 *
 * Everything shown here comes from the citation the API produced, which was
 * itself built from the retrieved chunk row. The full chunk is fetched lazily so
 * a reader can see the whole passage the excerpt was cut from - the excerpt
 * alone is not enough to judge whether an answer was fair to its source.
 */
export function SourcePanel({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const [chunk, setChunk] = useState<ChunkDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let active = true;
    setChunk(null);
    setLoading(true);

    api
      .getChunk(citation.chunkId)
      .then((result) => {
        if (active) setChunk(result);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [citation.chunkId]);

  return (
    <aside className="source-panel">
      <div className="source-panel-header">
        <div className="row">
          <span className="citation-index">{citation.index}</span>
          <strong style={{ fontSize: 13.5 }}>Source</strong>
        </div>
        <button className="ghost small" onClick={onClose} aria-label="Close source panel">
          ✕
        </button>
      </div>

      <div className="source-panel-body">
        <div className="source-field">
          <div className="source-field-label">Document</div>
          <div className="source-field-value">
            <span className="doc-code">{citation.documentCode}</span>{' '}
            <Link to={`/documents/${citation.documentId}`}>{citation.documentTitle}</Link>
          </div>
        </div>

        <div className="row wrap" style={{ marginBottom: 14 }}>
          <span className="badge accent">Revision {citation.revision}</span>
          {citation.page !== null && <span className="badge">Page {citation.page}</span>}
          <ExtractionBadge method={citation.extractionMethod} />
        </div>

        {citation.section && (
          <div className="source-field">
            <div className="source-field-label">Section</div>
            <div className="source-field-value">
              {citation.section}
              {citation.subsection ? ` › ${citation.subsection}` : ''}
            </div>
          </div>
        )}

        <div className="source-field">
          <div className="source-field-label">Effective date</div>
          <div className="source-field-value">{formatDate(citation.effectiveDate)}</div>
        </div>

        <div className="source-field">
          <div className="source-field-label">Excerpt shown in the answer</div>
          <div className="source-excerpt">{citation.excerpt}</div>
        </div>

        <div className="source-field">
          <div className="source-field-label">Full retrieved passage</div>
          {loading ? (
            <div className="row subtle">
              <span className="spinner" /> Loading passage…
            </div>
          ) : chunk ? (
            <div className="source-excerpt" style={{ borderLeftColor: 'var(--border-strong)' }}>
              {chunk.content}
            </div>
          ) : (
            <div className="subtle">This passage is no longer available.</div>
          )}
        </div>

        {chunk && (
          <div className="subtle" style={{ fontSize: 12 }}>
            Chunk {chunk.chunkIndex} · {chunk.tokenCount} tokens ·{' '}
            {chunk.isCurrent ? 'current revision' : 'superseded revision'}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
          <a
            className="badge accent"
            style={{ padding: '7px 13px', textDecoration: 'none' }}
            href={api.revisionFileUrl(citation.revisionId)}
          >
            ⬇ Open original file
          </a>
          <Link
            className="badge"
            style={{ padding: '7px 13px', textDecoration: 'none' }}
            to={`/documents/${citation.documentId}`}
          >
            View document
          </Link>
        </div>
      </div>
    </aside>
  );
}
