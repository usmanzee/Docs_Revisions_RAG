import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Citation, ToolActivity } from '@docs-rag/shared';
import { ToolActivityView } from './ToolActivityView.js';

/**
 * A rendered assistant or user message.
 *
 * Citation markers written by the model - `[2]` - are turned into buttons that
 * open the source panel. The mapping is done against the citation list the API
 * returned, so a marker the model invented for a source that does not exist
 * renders as plain text rather than as a clickable, authoritative-looking link.
 */

export interface MessageViewProps {
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  toolActivity: ToolActivity[];
  streaming?: boolean;
  answerStatus?: string | null;
  timings?: { retrievalMs: number | null; llmMs: number | null } | null;
  onCitationClick(citation: Citation): void;
  onRetry?: () => void;
}

/** Split text on citation markers so they can be rendered as buttons. */
function renderWithCitations(
  text: string,
  citations: Citation[],
  onClick: (citation: Citation) => void,
): React.ReactNode[] {
  const byIndex = new Map(citations.map((citation) => [citation.index, citation]));
  const nodes: React.ReactNode[] = [];
  const pattern = /\[(\d{1,2})\]/g;

  let cursor = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    const citation = byIndex.get(Number.parseInt(match[1] as string, 10));
    if (!citation) continue; // unknown marker: leave it as literal text

    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));

    nodes.push(
      <button
        key={`citation-${key++}`}
        type="button"
        className="citation-ref"
        title={`${citation.documentCode} · ${citation.section ?? 'source'}`}
        onClick={() => onClick(citation)}
      >
        {citation.index}
      </button>,
    );

    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function MessageView(props: MessageViewProps) {
  const [copied, setCopied] = useState(false);

  // Markdown renderers are rebuilt only when the citation set changes.
  const components = useMemo(
    () => ({
      // Citation markers can appear anywhere text does, so the transform is
      // applied at the text level rather than per block element.
      p: ({ children }: { children?: React.ReactNode }) => (
        <p>{transformChildren(children, props.citations, props.onCitationClick)}</p>
      ),
      li: ({ children }: { children?: React.ReactNode }) => (
        <li>{transformChildren(children, props.citations, props.onCitationClick)}</li>
      ),
      td: ({ children }: { children?: React.ReactNode }) => (
        <td>{transformChildren(children, props.citations, props.onCitationClick)}</td>
      ),
    }),
    [props.citations, props.onCitationClick],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard access can be denied; failing quietly is fine for a copy button.
    }
  };

  return (
    <div className={`message ${props.role}`}>
      <div className="message-avatar">{props.role === 'user' ? 'You' : 'DA'}</div>
      <div className="message-content">
        <div className="message-role">{props.role === 'user' ? 'You' : 'Assistant'}</div>

        {/* Above the answer: what was done comes before what was said. */}
        <ToolActivityView activity={props.toolActivity} />

        <div className="message-body">
          {props.role === 'user' ? (
            <p style={{ whiteSpace: 'pre-wrap' }}>{props.content}</p>
          ) : props.content.length === 0 && props.streaming ? (
            <div className="row subtle">
              <span className="spinner" /> Searching the document corpus…
            </div>
          ) : (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
              {props.content}
            </ReactMarkdown>
          )}
        </div>

        {props.role === 'assistant' && props.answerStatus === 'INSUFFICIENT_CONTEXT' && (
          <div className="alert warn" style={{ marginTop: 10 }}>
            The assistant did not find enough supporting content in the current document revisions. It has
            said so rather than guessing.
          </div>
        )}

        {props.citations.length > 0 && (
          <div className="citations">
            <div className="citations-label">Sources</div>
            {props.citations.map((citation) => (
              <button
                key={citation.chunkId}
                type="button"
                className="citation-chip"
                onClick={() => props.onCitationClick(citation)}
              >
                <span className="citation-index">{citation.index}</span>
                <span className="citation-meta">
                  <span className="citation-doc">
                    {citation.documentCode} · {citation.documentTitle}
                  </span>
                  <span className="citation-detail">
                    Revision {citation.revision}
                    {citation.section ? ` · ${citation.section}` : ''}
                    {citation.page !== null ? ` · page ${citation.page}` : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}

        {props.role === 'assistant' && !props.streaming && props.content.length > 0 && (
          <div className="message-footer">
            <div className="message-actions">
              <button className="ghost small" onClick={() => void copy()}>
                {copied ? '✓ Copied' : 'Copy'}
              </button>
              {props.onRetry && (
                <button className="ghost small" onClick={props.onRetry}>
                  Retry
                </button>
              )}
            </div>
            {props.timings?.retrievalMs !== null && props.timings?.retrievalMs !== undefined && (
              <span className="subtle" style={{ fontSize: 11.5 }}>
                retrieval {props.timings.retrievalMs} ms
                {props.timings.llmMs !== null ? ` · generation ${props.timings.llmMs} ms` : ''}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Apply citation transformation to every string among a node's children. */
function transformChildren(
  children: React.ReactNode,
  citations: Citation[],
  onClick: (citation: Citation) => void,
): React.ReactNode {
  if (typeof children === 'string') return renderWithCitations(children, citations, onClick);

  if (Array.isArray(children)) {
    return children.map((child, index) =>
      typeof child === 'string' ? (
        <span key={index}>{renderWithCitations(child, citations, onClick)}</span>
      ) : (
        child
      ),
    );
  }

  return children;
}
