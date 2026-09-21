import type { PoolClient } from 'pg';

/**
 * Какой опубликованный период показать на выбранную дату среза.
 *
 * Раньше экраны требовали точного совпадения периода: выбрал 21.09 — значит
 * ищем период, который кончается ровно 21.09. Отчёты за 21-е ещё не загружены,
 * совпадения нет, и портал показывал пустоту, хотя данные за 20-е опубликованы.
 * Так вёл себя только новый портал; старый работал от даты среза и показывал
 * последнее, что у него есть на эту дату.
 *
 * Здесь та же логика: берётся самый поздний опубликованный период, который
 * заканчивается не позже выбранной даты и начинается не раньше начала её
 * месяца. Месяц не пересекается намеренно — накопительные показатели считаются
 * от начала месяца, и подставлять в сентябрьский экран августовский период
 * нельзя.
 *
 * Выбранная дата и дата фактических данных возвращаются раздельно. Показать
 * данные за 20-е под подписью «на 21-е» значит соврать о свежести, поэтому
 * экран обязан назвать настоящую дату.
 */
export interface EffectivePeriod {
  /** Что выбрал пользователь. */
  requested_end: string;
  /** Начало периода фактических данных. */
  start: string;
  /** Конец периода фактических данных: может быть раньше выбранной даты. */
  end: string;
  /** Данные не на выбранную дату, а на более раннюю. */
  stale: boolean;
}

/**
 * `allowedOrgUnits` ограничивает поиск областью доступа: пользователь не должен
 * узнавать о свежести данных по филиалам, которых ему видеть не положено.
 * Пустой список означает отсутствие доступа — периода нет.
 */
export async function resolveEffectivePeriod(
  c: PoolClient, start: string, end: string, allowedOrgUnits: string[],
): Promise<EffectivePeriod | null> {
  if (!allowedOrgUnits.length) return null;
  const row = (await c.query(
    `SELECT to_char(s.period_start,'YYYY-MM-DD') period_start,
            to_char(s.period_end,'YYYY-MM-DD') period_end
       FROM report_fact_snapshots s
       JOIN report_fact_current p ON p.snapshot_id=s.id
      WHERE s.org_unit_id=ANY($1::uuid[])
        AND s.period_start>=$2::date AND s.period_end<=$3::date
        -- Точечные срезы склада (период из одного дня) не задают период экрана:
        -- склад приходит отдельным замером и читается своим запросом.
        AND s.period_start<>s.period_end
      ORDER BY s.period_end DESC, s.period_start ASC
      LIMIT 1`, [allowedOrgUnits, start, end])).rows[0];
  if (!row) return null;
  return {
    requested_end: end, start: row.period_start, end: row.period_end,
    stale: row.period_end !== end,
  };
}
