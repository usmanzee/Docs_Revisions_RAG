import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Citation, DocumentType, RetrievalFilters, ToolActivity } from '@docs-rag/shared';
import { DOCUMENT_TYPES } from '@docs-rag/shared';
import { api } from '../../api/client.js';
import { streamChat } from '../../api/chat-stream.js';
import { CONVERSATIONS_CHANGED } from '../../components/Sidebar.js';
import { SourcePanel } from '../sources/SourcePanel.js';
import { MessageView } from './MessageView.js';

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations: Citation[];
  toolActivity: ToolActivity[];
  answerStatus?: string | null;
  timings?: { retrievalMs: number | null; llmMs: number | null } | null;
}

const SUGGESTIONS = [
  {
    question: 'How many annual leave days do I have left?',
    hint: 'Reads your live balance from the HCM system.',
  },
  {
    question: 'Can I take the week of 16 November off?',
    hint: 'Checks the request against your balance and the notice rules before booking anything.',
  },
  {
    question: 'What leave have I got booked?',
    hint: 'Lists your requests and their approval status.',
  },
  {
    question: 'What expenses require Finance Director approval?',
    hint: 'Answers from the current revision of the expense policy, with a citation.',
  },
  {
    question: 'What does ORA-GUIDE-003 recommend regarding tablespace monitoring?',
    hint: 'Exact document codes are routed straight to that document.',
  },
  {
    question: 'When must a priority-one incident be escalated?',
    hint: 'Pulls the escalation timings out of the incident procedure.',
  },
  {
    question: 'What is the company policy on cryptocurrency payments to suppliers?',
    hint: 'Not covered by the corpus - the assistant should say so rather than guess.',
  },
];

export function ChatPage() {
  const { conversationId: routeConversationId } = useParams();
  const navigate = useNavigate();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeCitation, setActiveCitation] = useState<Citation | null>(null);
  const [filters, setFilters] = useState<RetrievalFilters>({});
  const [departments, setDepartments] = useState<string[]>([]);
  const [leaveEnabled, setLeaveEnabled] = useState(false);

  const conversationIdRef = useRef<string | null>(routeConversationId ?? null);
  /**
   * The conversation whose answer is currently streaming into `turns`.
   *
   * Sending the first message of a new chat makes the server create the
   * conversation, and the client then puts its id in the URL. That route change
   * fires the loader effect below - which would refetch from the database and
   * replace the turns being streamed into. The database does not have the
   * assistant's text yet (it is written when the answer completes), so the
   * refetch would wipe the in-progress answer and, worse, replace the pending
   * turn id that incoming tokens are keyed on, silently dropping every token
   * that followed.
   *
   * While this ref names the routed conversation, the in-memory turns are the
   * source of truth and the loader stands down.
   */
  const streamingConversationRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastQuestionRef = useRef<string>('');

  useEffect(() => {
    api
      .documentFacets()
      .then((facets) => setDepartments(facets.departments))
      .catch(() => undefined);

    // Whether the assistant can act on leave, so the UI can say so plainly
    // rather than leaving the user to discover it by asking.
    api
      .readiness()
      .then((status) => setLeaveEnabled(status.hcm?.leaveToolsEnabled ?? false))
      .catch(() => undefined);
  }, []);

  // Load an existing conversation when one is addressed by URL.
  useEffect(() => {
    // Our own mid-stream navigation: the in-memory turns are ahead of the
    // database, so leave them alone.
    if (routeConversationId && streamingConversationRef.current === routeConversationId) {
      conversationIdRef.current = routeConversationId;
      return;
    }

    conversationIdRef.current = routeConversationId ?? null;
    setActiveCitation(null);
    setError(null);

    if (!routeConversationId) {
      setTurns([]);
      return;
    }

    let active = true;
    api
      .getMessages(routeConversationId)
      .then((messages) => {
        if (!active) return;
        setTurns(
          messages.map((message) => ({
            id: message.id,
            role: message.role === 'user' ? 'user' : 'assistant',
            content: message.content,
            citations: message.citations,
            toolActivity: message.toolActivity ?? [],
            answerStatus: message.answerStatus,
            timings: { retrievalMs: message.retrievalMs, llmMs: message.llmMs },
          })),
        );
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : 'Could not load the conversation');
      });

    return () => {
      active = false;
    };
  }, [routeConversationId]);

  // Keep the newest content in view while an answer streams in.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [turns]);

  const send = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (trimmed.length === 0 || streaming) return;

      lastQuestionRef.current = trimmed;
      setInput('');
      setError(null);
      setStreaming(true);

      const assistantId = `pending-${Date.now()}`;

      setTurns((current) => [
        ...current,
        { id: `user-${Date.now()}`, role: 'user', content: trimmed, citations: [], toolActivity: [] },
        { id: assistantId, role: 'assistant', content: '', citations: [], toolActivity: [] },
      ]);

      const controller = new AbortController();
      abortRef.current = controller;

      await streamChat(
        {
          conversationId: conversationIdRef.current,
          message: trimmed,
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
          signal: controller.signal,
        },
        {
          onEvent(event) {
            switch (event.type) {
              case 'metadata': {
                // First turn: adopt the conversation the server created.
                if (!conversationIdRef.current) {
                  conversationIdRef.current = event.conversationId;
                  // Claim it before navigating, so the route change this causes
                  // does not reload over the answer being streamed.
                  streamingConversationRef.current = event.conversationId;
                  window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
                  navigate(`/chat/${event.conversationId}`, { replace: true });
                }
                break;
              }

              case 'token': {
                setTurns((current) => {
                  // Normally the pending turn is found by id. The fallback
                  // targets the trailing assistant turn instead: if anything
                  // ever replaces the turn list mid-stream, a plain `map` would
                  // match nothing and every token would vanish in silence.
                  // Rendering the answer against the wrong key is recoverable;
                  // rendering nothing at all is not.
                  const index = current.findIndex((turn) => turn.id === assistantId);
                  const target =
                    index >= 0
                      ? index
                      : current.findLastIndex((turn) => turn.role === 'assistant');

                  if (target < 0) return current;

                  const next = [...current];
                  const turn = next[target] as Turn;
                  next[target] = { ...turn, content: turn.content + event.text };
                  return next;
                });
                break;
              }

              case 'reset': {
                // The model began writing, then decided it needed tools. What
                // was shown was composed before it had the answers.
                setTurns((current) =>
                  current.map((turn) => (turn.id === assistantId ? { ...turn, content: '' } : turn)),
                );
                break;
              }

              case 'tool': {
                setTurns((current) =>
                  current.map((turn) =>
                    turn.id === assistantId &&
                    !turn.toolActivity.some((entry) => entry.id === event.activity.id)
                      ? { ...turn, toolActivity: [...turn.toolActivity, event.activity] }
                      : turn,
                  ),
                );
                break;
              }

              case 'citation': {
                setTurns((current) =>
                  current.map((turn) =>
                    turn.id === assistantId && !turn.citations.some((c) => c.chunkId === event.citation.chunkId)
                      ? { ...turn, citations: [...turn.citations, event.citation] }
                      : turn,
                  ),
                );
                break;
              }

              case 'complete': {
                setTurns((current) =>
                  current.map((turn) =>
                    turn.id === assistantId
                      ? {
                          ...turn,
                          id: event.messageId,
                          citations: event.citations,
                          toolActivity: event.toolActivity,
                          answerStatus: event.answerStatus,
                          timings: { retrievalMs: event.timings.retrievalMs, llmMs: event.timings.llmMs },
                        }
                      : turn,
                  ),
                );
                window.dispatchEvent(new Event(CONVERSATIONS_CHANGED));
                break;
              }

              case 'error': {
                setError(event.message);
                break;
              }
            }
          },
          onDone() {
            setStreaming(false);
            abortRef.current = null;
            streamingConversationRef.current = null;
          },
          onError(cause) {
            setError(cause.message);
            setStreaming(false);
            abortRef.current = null;
            streamingConversationRef.current = null;
          },
        },
      );
    },
    [filters, navigate, streaming],
  );

  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
    streamingConversationRef.current = null;
  };

  const retry = () => {
    if (lastQuestionRef.current.length === 0) return;
    // Drop the failed exchange before re-asking, so the thread does not
    // accumulate duplicates.
    setTurns((current) => current.slice(0, -2));
    void send(lastQuestionRef.current);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  };

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">Chat</h1>
          <p className="page-subtitle">
            Grounded in the current revision of each document. Every factual claim is cited.
            {leaveEnabled ? ' Leave balances and bookings come from the HCM system.' : ''}
          </p>
        </div>
        <div className="page-actions">
          {streaming && (
            <button className="ghost" onClick={stop}>
              ■ Stop
            </button>
          )}
        </div>
      </div>

      <div className="chat-layout">
        <div className="chat-main">
          <div className="chat-messages" ref={scrollRef}>
            <div className="chat-thread">
              {turns.length === 0 ? (
                <div style={{ paddingTop: 40 }}>
                  <div className="empty" style={{ paddingBottom: 20 }}>
                    <div className="empty-title">Ask about a policy, procedure or Oracle guideline</div>
                    <div className="empty-hint">
                      The assistant answers only from the documents it has ingested, and tells you when it
                      cannot find enough information.
                    </div>
                  </div>
                  <div className="suggestions">
                    {SUGGESTIONS.map((suggestion) => (
                      <button
                        key={suggestion.question}
                        className="suggestion"
                        onClick={() => void send(suggestion.question)}
                      >
                        {suggestion.question}
                        <span className="suggestion-hint">{suggestion.hint}</span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                turns.map((turn, index) => (
                  <MessageView
                    key={turn.id}
                    role={turn.role}
                    content={turn.content}
                    citations={turn.citations}
                    toolActivity={turn.toolActivity}
                    streaming={streaming && index === turns.length - 1}
                    answerStatus={turn.answerStatus}
                    timings={turn.timings}
                    onCitationClick={setActiveCitation}
                    {...(turn.role === 'assistant' && index === turns.length - 1 && !streaming
                      ? { onRetry: retry }
                      : {})}
                  />
                ))
              )}

              {error && (
                <div className="alert error">
                  {error}
                  <div style={{ marginTop: 8 }}>
                    <button className="small" onClick={retry}>
                      Try again
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="chat-composer">
            <div className="composer-inner">
              {leaveEnabled && (
                <div className="identity-banner">
                  <span aria-hidden="true">👤</span>
                  <span>
                    Leave actions run as the demo employee. Chat has no sign-in yet, so the assistant
                    always acts as one fixed person.
                  </span>
                </div>
              )}

              <div className="chat-filters">
                <select
                  value={filters.department ?? ''}
                  onChange={(event) =>
                    setFilters((current) => ({ ...current, department: event.target.value || null }))
                  }
                >
                  <option value="">All departments</option>
                  {departments.map((department) => (
                    <option key={department} value={department}>
                      {department}
                    </option>
                  ))}
                </select>

                <select
                  value={filters.documentType ?? ''}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      documentType: (event.target.value || null) as DocumentType | null,
                    }))
                  }
                >
                  <option value="">All document types</option>
                  {DOCUMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type.replace(/_/g, ' ')}
                    </option>
                  ))}
                </select>
              </div>

              <div className="composer-box">
                <textarea
                  className="composer-input"
                  rows={1}
                  placeholder="Ask about a policy, procedure or Oracle guideline…"
                  value={input}
                  disabled={streaming}
                  onChange={(event) => {
                    setInput(event.target.value);
                    // Grow with the content, up to the CSS max-height.
                    event.target.style.height = 'auto';
                    event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`;
                  }}
                  onKeyDown={onKeyDown}
                />
                <button className="primary" disabled={streaming || input.trim().length === 0} onClick={() => void send(input)}>
                  {streaming ? <span className="spinner" /> : 'Send'}
                </button>
              </div>

              <div className="composer-hint">
                <span>Enter to send · Shift+Enter for a new line</span>
                <span>Answers cite the document, revision and section they came from.</span>
              </div>
            </div>
          </div>
        </div>

        {activeCitation && (
          <SourcePanel citation={activeCitation} onClose={() => setActiveCitation(null)} />
        )}
      </div>
    </>
  );
}
