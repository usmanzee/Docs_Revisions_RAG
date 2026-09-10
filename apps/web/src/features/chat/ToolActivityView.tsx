import { useState } from 'react';
import type { ToolActivity } from '@docs-rag/shared';

/**
 * What the assistant actually did.
 *
 * Shown inline and expanded by default for writes. When an assistant can change
 * a real leave record, "it said it booked something" is not good enough - the
 * user should be able to see the call that was made and what came back, without
 * having to go looking.
 */

const WRITE_TOOLS = new Set(['apply_for_leave', 'withdraw_leave_request', 'cancel_leave_request']);

const LABELS: Record<string, string> = {
  get_leave_balance: 'Checked leave balance',
  get_leave_history: 'Looked up leave history',
  validate_leave_request: 'Checked whether the request is allowed',
  apply_for_leave: 'Submitted a leave request',
  withdraw_leave_request: 'Withdrew a leave request',
  cancel_leave_request: 'Cancelled approved leave',
};

function summariseArguments(args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.join(' · ');
}

export function ToolActivityView({ activity }: { activity: ToolActivity[] }) {
  if (activity.length === 0) return null;

  return (
    <div className="tool-activity">
      {activity.map((entry) => (
        <ToolCard key={entry.id} activity={entry} />
      ))}
    </div>
  );
}

function ToolCard({ activity }: { activity: ToolActivity }) {
  const isWrite = WRITE_TOOLS.has(activity.name);
  // A write, a refusal or a failure is something the user needs to read.
  // A routine lookup can stay collapsed.
  const [expanded, setExpanded] = useState(isWrite || activity.refused || activity.error !== null);

  const tone = activity.error ? 'failed' : activity.refused ? 'refused' : isWrite ? 'write' : '';
  const label = LABELS[activity.name] ?? activity.name;
  const args = summariseArguments(activity.arguments);

  return (
    <div className={`tool-card ${tone}`}>
      <div className="tool-head">
        <span aria-hidden="true">
          {activity.error ? '⚠️' : activity.refused ? '🚫' : isWrite ? '✅' : '🔎'}
        </span>
        <span className="tool-name">{label}</span>
        {isWrite && !activity.error && !activity.refused && <span className="badge accent">action taken</span>}
        {activity.refused && <span className="badge warning">not permitted</span>}
        {activity.error && <span className="badge danger">failed</span>}
        <button className="tool-toggle" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'hide detail' : 'show detail'}
        </button>
      </div>

      {args.length > 0 && <div className="tool-args">{args}</div>}

      {expanded && <div className="tool-summary">{activity.summary}</div>}
    </div>
  );
}
