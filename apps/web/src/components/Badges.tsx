import type { ProcessingStatus, RevisionStatus } from '@docs-rag/shared';

/**
 * Status badges.
 *
 * Colour carries meaning here, so each mapping is deliberate: a PENDING
 * revision is a warning because it means the document's newest content is not
 * yet searchable, and FAILED is a danger because someone has to act.
 */

const PROCESSING_TONE: Record<ProcessingStatus, string> = {
  PENDING: 'warning',
  PROCESSING: 'info',
  READY: 'success',
  FAILED: 'danger',
  SUPERSEDED: '',
};

export function ProcessingBadge({ status }: { status: ProcessingStatus }) {
  return <span className={`badge ${PROCESSING_TONE[status]}`}>{status}</span>;
}

export function RevisionBadge({ status, isCurrent }: { status: RevisionStatus; isCurrent: boolean }) {
  if (isCurrent) return <span className="badge success">CURRENT</span>;
  return <span className="badge">{status}</span>;
}

export function JobStatusBadge({ status }: { status: string }) {
  const tone =
    status === 'COMPLETED'
      ? 'success'
      : status === 'PARTIALLY_COMPLETED'
        ? 'warning'
        : status === 'FAILED'
          ? 'danger'
          : 'info';
  return <span className={`badge ${tone}`}>{status.replace(/_/g, ' ')}</span>;
}

export function ExtractionBadge({ method }: { method: string }) {
  if (method === 'NATIVE_TEXT') return null;
  const tone = method === 'OCR' ? 'info' : method === 'VISION' ? 'accent' : '';
  return <span className={`badge ${tone}`}>{method}</span>;
}
