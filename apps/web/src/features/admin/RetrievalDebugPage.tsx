import { useState } from 'react';
import type { RetrievalDebugResponse } from '@docs-rag/shared';
import { api } from '../../api/client.js';

/**
 * Retrieval inspector.
 *
 * Shows each candidate list separately alongside the fused ranking, because the
 * useful question when an answer is wrong is almost never "was retrieval bad?"
 * but "which stage went wrong" - a lexical match on a stale chunk, a dense
 * neighbour that outranked the right passage, or fusion weighting them badly.
 */
export function RetrievalDebugPage() {
  const [query, setQuery] = useState('What expenses require Finance Director approval?');
  const [result, setResult] = useState<RetrievalDebugResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    if (query.trim().length === 0) return;
    setLoading(true);
    setError(null);
    try {
      setResult(await api.debugRetrieval({ query: query.trim() }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const maxRrf = result ? Math.max(...result.fused.map((item) => item.rrfScore), 0.0001) : 1;

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Retrieval debug</h1>
          <p className="page-subtitle">
            Every stage of the pipeline for one query, exactly as the chat endpoint would run it.
          </p>
        </div>
      </div>

      <div className="page-body">
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-body">
            <div className="row">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void search();
                }}
                placeholder="Enter a query to trace…"
              />
              <button className="primary" disabled={loading} onClick={() => void search()}>
                {loading ? <span className="spinner" /> : 'Trace'}
              </button>
            </div>
            {error && (
              <div className="alert error" style={{ marginTop: 12 }}>
                {error}
              </div>
            )}
          </div>
        </div>

        {result && (
          <div className="stack">
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Query and configuration</h2>
              </div>
              <div className="card-body">
                <div className="grid cols-2">
                  <div>
                    <div className="source-field">
                      <div className="source-field-label">Original query</div>
                      <div className="source-field-value">{result.query}</div>
                    </div>
                    <div className="source-field">
                      <div className="source-field-label">Standalone query used for retrieval</div>
                      <div className="source-field-value">
                        {result.standaloneQuery}
                        {result.standaloneQuery === result.query && (
                          <span className="subtle"> (unchanged — not a follow-up)</span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="grid cols-3">
                      <div className="stat" style={{ padding: '9px 11px' }}>
                        <div className="stat-label">Vector</div>
                        <div className="stat-value" style={{ fontSize: 19 }}>
                          {result.vectorCandidates.length}
                        </div>
                        <div className="stat-hint">{result.timings.vectorMs} ms</div>
                      </div>
                      <div className="stat" style={{ padding: '9px 11px' }}>
                        <div className="stat-label">Lexical</div>
                        <div className="stat-value" style={{ fontSize: 19 }}>
                          {result.lexicalCandidates.length}
                        </div>
                        <div className="stat-hint">{result.timings.lexicalMs} ms</div>
                      </div>
                      <div className="stat" style={{ padding: '9px 11px' }}>
                        <div className="stat-label">Selected</div>
                        <div className="stat-value" style={{ fontSize: 19 }}>
                          {result.selected.length}
                        </div>
                        <div className="stat-hint">{result.contextTokens} ctx tokens</div>
                      </div>
                    </div>

                    <div className="subtle" style={{ fontSize: 12, marginTop: 10 }}>
                      RRF k={result.config.rrfK} · vector top-k={result.config.vectorTopK} · lexical top-k=
                      {result.config.lexicalTopK} · reranker={result.config.reranker} · embeddings=
                      {result.config.embeddingProvider}/{result.config.embeddingModel} · total{' '}
                      {result.timings.totalMs} ms
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Fused ranking</h2>
                <span className="subtle" style={{ fontSize: 12 }}>
                  Highlighted rows were sent to the model
                </span>
              </div>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Document</th>
                      <th>Section</th>
                      <th>Rev</th>
                      <th>Vector rank</th>
                      <th>Lexical rank</th>
                      <th>RRF</th>
                      <th>Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.fused.map((item, index) => {
                      const selected = result.selected.some((entry) => entry.chunkId === item.chunkId);
                      return (
                        <tr
                          key={item.chunkId}
                          style={selected ? { background: 'var(--accent-soft)' } : undefined}
                        >
                          <td>{index + 1}</td>
                          <td className="nowrap doc-code">{item.documentCode}</td>
                          <td style={{ maxWidth: 200 }}>{item.section ?? '—'}</td>
                          <td>{item.revision}</td>
                          <td>{item.vectorRank ?? <span className="subtle">—</span>}</td>
                          <td>{item.lexicalRank ?? <span className="subtle">—</span>}</td>
                          <td className="nowrap">
                            <div className="row" style={{ gap: 7 }}>
                              <div className="score-bar" style={{ flex: 1 }}>
                                <div
                                  className="score-fill"
                                  style={{ width: `${Math.round((item.rrfScore / maxRrf) * 100)}%` }}
                                />
                              </div>
                              <span className="mono" style={{ fontSize: 11.5 }}>
                                {item.rrfScore.toFixed(4)}
                              </span>
                            </div>
                          </td>
                          <td className="subtle" style={{ maxWidth: 320, fontSize: 12 }}>
                            {item.preview}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="grid cols-2">
              <CandidateTable
                title="Vector candidates"
                subtitle="cosine similarity"
                items={result.vectorCandidates}
              />
              <CandidateTable
                title="Lexical candidates"
                subtitle="ts_rank_cd"
                items={result.lexicalCandidates}
              />
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function CandidateTable({
  title,
  subtitle,
  items,
}: {
  title: string;
  subtitle: string;
  items: RetrievalDebugResponse['vectorCandidates'];
}) {
  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">{title}</h2>
        <span className="subtle" style={{ fontSize: 12 }}>
          {subtitle}
        </span>
      </div>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Document</th>
              <th>Section</th>
              <th>Score</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="subtle">
                  No candidates from this source.
                </td>
              </tr>
            )}
            {items.slice(0, 15).map((item) => (
              <tr key={item.chunkId}>
                <td>{item.rank}</td>
                <td className="nowrap doc-code">{item.documentCode}</td>
                <td style={{ maxWidth: 180 }}>{item.section ?? '—'}</td>
                <td className="mono nowrap">{item.score.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
