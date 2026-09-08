import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { ConversationSummary } from '@docs-rag/shared';
import { api } from '../api/client.js';

/**
 * Navigation and conversation history.
 *
 * Conversations reload on a custom window event rather than through a shared
 * store: the chat page is the only thing that creates them, and a one-line
 * event is a smaller price than a global state library for a single signal.
 */
export const CONVERSATIONS_CHANGED = 'docs-rag:conversations-changed';

export function Sidebar() {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const { conversationId } = useParams();
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;

    const load = () => {
      api
        .listConversations()
        .then((items) => {
          if (active) setConversations(items);
        })
        .catch(() => {
          // The sidebar is not worth an error state: an empty history is a
          // reasonable rendering when the API is briefly unavailable.
        });
    };

    load();
    window.addEventListener(CONVERSATIONS_CHANGED, load);

    return () => {
      active = false;
      window.removeEventListener(CONVERSATIONS_CHANGED, load);
    };
  }, []);

  const remove = async (id: string, event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    await api.deleteConversation(id).catch(() => undefined);
    setConversations((items) => items.filter((item) => item.id !== id));
    if (conversationId === id) navigate('/chat');
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-brand">
          <div className="sidebar-brand-mark">DA</div>
          <div>
            <div className="sidebar-brand-text">Document Assistant</div>
            <div className="sidebar-brand-sub">Policies · Procedures · Oracle</div>
          </div>
        </div>
        <button className="primary" style={{ width: '100%' }} onClick={() => navigate('/chat')}>
          + New chat
        </button>
      </div>

      <nav className="sidebar-nav">
        <NavLink to="/chat" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} end>
          <span className="nav-icon">💬</span> Chat
        </NavLink>
        <NavLink to="/documents" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">📄</span> Documents
        </NavLink>
        <NavLink to="/admin" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`} end>
          <span className="nav-icon">⚙️</span> Admin
        </NavLink>
        <NavLink to="/admin/retrieval" className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
          <span className="nav-icon">🔍</span> Retrieval debug
        </NavLink>
      </nav>

      <div className="sidebar-section">Recent conversations</div>
      <div className="conversation-list">
        {conversations.length === 0 ? (
          <div style={{ padding: '6px 10px', fontSize: 12.5 }} className="subtle">
            No conversations yet.
          </div>
        ) : (
          conversations.map((conversation) => (
            <button
              key={conversation.id}
              type="button"
              className={`conversation-item${conversationId === conversation.id ? ' active' : ''}`}
              onClick={() => navigate(`/chat/${conversation.id}`)}
            >
              <span className="conversation-title">{conversation.title ?? 'Untitled conversation'}</span>
              <span
                role="button"
                tabIndex={-1}
                aria-label="Delete conversation"
                className="subtle"
                onClick={(event) => void remove(conversation.id, event)}
              >
                ×
              </span>
            </button>
          ))
        )}
      </div>

      <div className="sidebar-footer">Answers are grounded in the current revision of each document.</div>
    </aside>
  );
}
