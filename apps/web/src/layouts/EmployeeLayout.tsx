import { Outlet } from 'react-router-dom';
import { Sidebar } from '../components/Sidebar.js';

/**
 * The shell everyone uses: assistant and document browser.
 *
 * Deliberately contains no route into the admin console. Operational controls -
 * running ingestion, generating a corpus, reprocessing a failed revision - are
 * not employee concerns, and putting them one click from the chat box invites
 * someone to press a button whose consequences they have no reason to
 * understand. The admin console is reached by going to /admin.
 */
export function EmployeeLayout() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Outlet />
      </main>
    </div>
  );
}
