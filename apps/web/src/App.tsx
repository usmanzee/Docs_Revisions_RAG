import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { EmployeeLayout } from './layouts/EmployeeLayout.js';
import { ChatPage } from './features/chat/ChatPage.js';
import { DocumentsPage } from './features/documents/DocumentsPage.js';
import { DocumentDetailPage } from './features/documents/DocumentDetailPage.js';

/**
 * Two applications sharing one origin.
 *
 *   /            the assistant and the document browser - what employees use
 *   /admin/*     the operations console - corpus, ingestion, revisions, retrieval
 *
 * The admin console is lazy-loaded, so someone who only ever chats never
 * downloads the code that can rebuild a corpus. That also means the split is
 * real in the build output rather than only in the routing table, which is what
 * makes it straightforward to serve /admin from somewhere else - or not serve it
 * at all - later on.
 */
const AdminLayout = lazy(() =>
  import('./layouts/AdminLayout.js').then((module) => ({ default: module.AdminLayout })),
);
const AdminPage = lazy(() =>
  import('./features/admin/AdminPage.js').then((module) => ({ default: module.AdminPage })),
);
const RetrievalDebugPage = lazy(() =>
  import('./features/admin/RetrievalDebugPage.js').then((module) => ({
    default: module.RetrievalDebugPage,
  })),
);
const AdminDocumentsPage = lazy(() =>
  import('./features/admin/AdminDocumentsPage.js').then((module) => ({
    default: module.AdminDocumentsPage,
  })),
);
const AdminDocumentPage = lazy(() =>
  import('./features/admin/AdminDocumentPage.js').then((module) => ({
    default: module.AdminDocumentPage,
  })),
);

function LoadingConsole() {
  return (
    <div className="admin-gate">
      <div className="row subtle">
        <span className="spinner" /> Loading console…
      </div>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      {/* Employee application */}
      <Route element={<EmployeeLayout />}>
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="/chat" element={<ChatPage />} />
        <Route path="/chat/:conversationId" element={<ChatPage />} />
        <Route path="/documents" element={<DocumentsPage />} />
        <Route path="/documents/:documentId" element={<DocumentDetailPage />} />
      </Route>

      {/* Operations console */}
      <Route
        path="/admin"
        element={
          <Suspense fallback={<LoadingConsole />}>
            <AdminLayout />
          </Suspense>
        }
      >
        <Route
          index
          element={
            <Suspense fallback={<LoadingConsole />}>
              <AdminPage />
            </Suspense>
          }
        />
        <Route
          path="documents"
          element={
            <Suspense fallback={<LoadingConsole />}>
              <AdminDocumentsPage />
            </Suspense>
          }
        />
        <Route
          path="documents/:documentId"
          element={
            <Suspense fallback={<LoadingConsole />}>
              <AdminDocumentPage />
            </Suspense>
          }
        />
        <Route
          path="retrieval"
          element={
            <Suspense fallback={<LoadingConsole />}>
              <RetrievalDebugPage />
            </Suspense>
          }
        />
        {/* An unknown admin path stays inside the console rather than
            bouncing an operator out to the chat screen. */}
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Route>

      <Route path="*" element={<Navigate to="/chat" replace />} />
    </Routes>
  );
}
