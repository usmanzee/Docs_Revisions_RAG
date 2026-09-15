import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { getAdminKey, setAdminKey } from '../api/client.js';
import { adminApi } from '../api/admin-client.js';

/**
 * The operations console shell.
 *
 * Separate from the employee application in three ways that matter:
 *
 *   - Its own URL space (/admin/*), so it can be firewalled, put behind a
 *     different auth provider, or served from a different host later without
 *     touching the employee app.
 *   - Its own credential check, performed once here rather than by each page
 *     discovering a 401 on its own and rendering a key box in the middle of a
 *     half-broken screen.
 *   - Its own look, so it is never ambiguous which application you are in when
 *     the buttons in front of you rebuild a corpus.
 */

type Gate = 'checking' | 'locked' | 'unlocked';

export function AdminLayout() {
  const [gate, setGate] = useState<Gate>('checking');
  const [keyInput, setKeyInput] = useState(getAdminKey());
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  /**
   * Verify the stored credential against a real admin endpoint.
   *
   * The key is checked here rather than trusted because the alternative - assume
   * it works, let each page fail - produces a console that looks broken when it
   * is merely locked.
   */
  const verify = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      await adminApi.stats();
      setGate('unlocked');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      // A wrong key is a locked door. Anything else is a broken server, and
      // saying "check your key" would send the operator down the wrong path.
      if (/unauthorized|401/i.test(message)) {
        setGate('locked');
      } else {
        setGate('locked');
        setError(message);
      }
    }
  }, []);

  useEffect(() => {
    void verify();
  }, [verify]);

  const unlock = (event: React.FormEvent): void => {
    event.preventDefault();
    setAdminKey(keyInput.trim());
    setGate('checking');
    void verify();
  };

  if (gate === 'checking') {
    return (
      <div className="admin-gate">
        <div className="row subtle">
          <span className="spinner" /> Checking access…
        </div>
      </div>
    );
  }

  if (gate === 'locked') {
    return (
      <div className="admin-gate">
        <form className="admin-gate-card" onSubmit={unlock}>
          <div className="admin-gate-mark">⚙️</div>
          <h1>Operations console</h1>
          <p className="subtle">
            Ingestion, corpus generation and revision control. Separate from the assistant.
          </p>

          {error && <div className="alert error">{error}</div>}

          <label className="source-field-label" htmlFor="admin-key">
            Admin API key
          </label>
          <input
            id="admin-key"
            type="password"
            value={keyInput}
            autoFocus
            onChange={(event) => setKeyInput(event.target.value)}
            placeholder="ADMIN_API_KEY"
          />

          <button className="primary" type="submit">
            Unlock
          </button>

          <p className="subtle" style={{ fontSize: 12 }}>
            Must match <code>ADMIN_API_KEY</code> in the API environment. Held in this browser tab
            only — never written to disk, never sent anywhere but this API.
          </p>

          <button type="button" className="link-button" onClick={() => navigate('/chat')}>
            ← Back to the assistant
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="admin-app">
      <header className="admin-bar">
        <div className="admin-brand">
          <span className="admin-brand-mark">⚙️</span>
          <div>
            <div className="admin-brand-text">Operations console</div>
            <div className="admin-brand-sub">Corpus · Ingestion · Revisions · Retrieval</div>
          </div>
        </div>

        <nav className="admin-nav">
          <NavLink to="/admin" end className={({ isActive }) => `admin-nav-link${isActive ? ' active' : ''}`}>
            Overview
          </NavLink>
          <NavLink
            to="/admin/documents"
            className={({ isActive }) => `admin-nav-link${isActive ? ' active' : ''}`}
          >
            Documents
          </NavLink>
          <NavLink
            to="/admin/retrieval"
            className={({ isActive }) => `admin-nav-link${isActive ? ' active' : ''}`}
          >
            Retrieval debug
          </NavLink>
        </nav>

        <div className="admin-bar-end">
          <button
            className="ghost"
            onClick={() => {
              // Clearing the key re-locks the console without touching the
              // employee session.
              setAdminKey('');
              setGate('locked');
            }}
          >
            Lock
          </button>
          <a href="/chat" className="admin-exit">
            Assistant →
          </a>
        </div>
      </header>

      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}
