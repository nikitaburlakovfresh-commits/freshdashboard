import React from 'react';

/** Светофор показателя. Значения порогов приходят с сервера из настроек:
 * компонент только отображает уже вычисленный статус и никогда не считает его
 * сам. Отсутствие данных — отдельный статус NONE, а не зелёный и не ноль. */
export type RagStatus = 'RED' | 'AMBER' | 'GREEN' | 'NONE';

const LABELS: Record<RagStatus, string> = {
  RED: 'Красный',
  AMBER: 'Жёлтый',
  GREEN: 'Зелёный',
  NONE: 'Нет данных',
};

export function RagDot({ status }: { status: RagStatus }) {
  return <span className="rag-dot" data-rag={status} role="img" aria-label={LABELS[status]} />;
}

export default function RagBadge({ status, label }: { status: RagStatus; label?: string }) {
  return (
    <span className="rag-badge" data-rag={status}>
      <RagDot status={status} />
      {label ?? LABELS[status]}
    </span>
  );
}
