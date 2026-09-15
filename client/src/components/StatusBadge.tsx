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
  DRAFT: { bg: '#F3F4F6', fg: '#4B5563' },
  ASSIGNED: { bg: '#E0EAFF', fg: '#003DFF' },
  IN_PROGRESS: { bg: '#FEF0C7', fg: '#B54708' },
  SUBMITTED: { bg: '#E0F2FE', fg: '#0C5D8F' },
  COMPLETED: { bg: '#D1FADF', fg: '#067647' },
  CANCELLED: { bg: '#FEE4E2', fg: '#B42318' },
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
