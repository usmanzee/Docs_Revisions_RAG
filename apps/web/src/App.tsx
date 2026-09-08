import { Navigate, Route, Routes } from 'react-router-dom';
import { Sidebar } from './components/Sidebar.js';
import { ChatPage } from './features/chat/ChatPage.js';
import { DocumentsPage } from './features/documents/DocumentsPage.js';
import { DocumentDetailPage } from './features/documents/DocumentDetailPage.js';
import { AdminPage } from './features/admin/AdminPage.js';
import { RetrievalDebugPage } from './features/admin/RetrievalDebugPage.js';

export function App() {
  return (
    <div className="app">
      <Sidebar />
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/chat/:conversationId" element={<ChatPage />} />
          <Route path="/documents" element={<DocumentsPage />} />
          <Route path="/documents/:documentId" element={<DocumentDetailPage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/admin/retrieval" element={<RetrievalDebugPage />} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
      </main>
    </div>
  );
}
