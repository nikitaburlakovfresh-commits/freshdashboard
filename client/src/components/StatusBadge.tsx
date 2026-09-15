import React from 'react';
import type { WorkItemStatus } from '../api/types';

const LABELS: Record<WorkItemStatus, string> = {
  DRAFT: 'Черновик',
  ASSIGNED: 'Назначена',
  IN_PROGRESS: 'В работе',
  SUBMITTED: 'На проверке',
  COMPLETED: 'Выполнена',
  CANCELLED: 'Отменена',
};

const COLORS: Record<WorkItemStatus, { bg: string; fg: string }> = {
  DRAFT: { bg: 'var(--fresh-raised)', fg: 'var(--fresh-text-muted)' },
  ASSIGNED: { bg: 'var(--fresh-info-bg)', fg: 'var(--fresh-link)' },
  IN_PROGRESS: { bg: 'var(--fresh-warning-bg)', fg: 'var(--fresh-warning)' },
  SUBMITTED: { bg: 'var(--fresh-info-bg)', fg: 'var(--fresh-link)' },
  COMPLETED: { bg: 'var(--fresh-success-bg)', fg: 'var(--fresh-success)' },
  CANCELLED: { bg: 'var(--fresh-danger-bg)', fg: 'var(--fresh-danger)' },
};

export default function StatusBadge({ status }: { status: WorkItemStatus }) {
  const c = COLORS[status];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '3px 10px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        background: c.bg,
        color: c.fg,
        whiteSpace: 'nowrap',
      }}
    >
      {LABELS[status]}
    </span>
  );
}
