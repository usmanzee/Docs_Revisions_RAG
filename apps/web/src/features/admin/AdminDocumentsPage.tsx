import { DocumentsPage } from '../documents/DocumentsPage.js';

/**
 * The document list, with rows leading to the console's editable view rather
 * than the employee application's read-only one.
 */
export function AdminDocumentsPage() {
  return <DocumentsPage basePath="/admin/documents" />;
}
