// Диагностика балла руководителя: из каких филиалов и из каких показателей он
// складывается. Печатает балл каждого филиала зоны, вклад каждого показателя и
// причину отсутствия значения. Только чтение.
import { withTransaction, closePool } from '../src/db/pool';
import { branchAffiliations } from '../src/metrics/orgHierarchy';
import { funnelConversions, buyback45Shares } from '../src/metrics/derived';
import { resolveScoringModel, computeBranchScore } from '../src/metrics/scoring';

const [needle, start, end, ...extra] = process.argv.slice(2);

async function main() {
  if (extra.length || !needle || !start || !end)
    throw new Error('Usage: previewManagerScore <часть-фамилии> <start> <end>');
  await withTransaction(async c => {
    const branches = (await c.query(`SELECT u.id, n.display_name
      FROM org_directory_units u
      JOIN org_directory_name_history n ON n.org_unit_id=u.id
        AND $1::date >= n.effective_from AND (n.effective_to IS NULL OR $1::date < n.effective_to)
      WHERE u.kind='ORG_UNIT' AND u.lifecycle_state<>'CLOSED'`, [end])).rows;
    const ids = branches.map((b: any) => b.id as string);
    const names = new Map<string, string>(branches.map((b: any) => [b.id, b.display_name]));
    const aff = await branchAffiliations(c, ids, end);

    // Группировка идёт по зоне РМ справочника: руководитель может быть не
    // заведён пользователем, а зона существует и закрепляет филиалы.
    const zone = (id: string) => `${aff.get(id)?.cluster_name ?? ''} ${aff.get(id)?.manager_name ?? ''}`;
    const mine = ids.filter(id => zone(id).toLowerCase().includes(needle.toLowerCase()));
    if (!mine.length) {
      const all = [...new Set([...aff.values()].map(a => a.cluster_name).filter(Boolean))].sort();
      throw new Error(`Руководитель по «${needle}» не найден. Есть: ${all.join(', ')}`);
    }
    const model = await resolveScoringModel(c, end);
    if (!model) throw new Error('Модель балла на дату не настроена');
    console.log(`Модель ${model.id}: зелёный от ${model.green_score_from}, жёлтый от ${model.amber_score_from}`);
    console.log(`Веса: ${model.weights.map((r: any) => `${r.metric} ${r.weight}`).join(', ')}`);

    const buyback = await buyback45Shares(c, mine, end);
    const scores: number[] = [];
    for (const id of mine) {
      const rows = (await c.query(`SELECT s.metric, s.value::text value FROM report_fact_snapshots s
        JOIN report_fact_current p ON p.snapshot_id=s.id
        WHERE s.org_unit_id=$1 AND s.period_start=$2 AND s.period_end=$3`, [id, start, end])).rows;
      const values = new Map<string, number>(rows.map((r: any) => [r.metric, Number(r.value)]));
      for (const [k, v] of funnelConversions(values)) values.set(k, v);
      const b = buyback.get(id);
      if (b) values.set('buyback45Share', b.share);
      if (!rows.length) { console.log(`\n${names.get(id)}: нет опубликованных показателей за период`); continue; }
      const score = computeBranchScore(model, values, end);
      if (score.score !== null) scores.push(score.score);
      console.log(`\n${names.get(id)}: балл ${score.score === null ? '—' : score.score.toFixed(1)} ${score.rag}`);
      for (const k of score.components)
        console.log(`   ${k.metric} вес ${k.weight}: факт ${k.fact ?? '—'} план ${k.plan ?? '—'}`
          + ` → ${k.score === null ? `нет значения (${k.missing})` : k.score.toFixed(1)}`);
    }
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    console.log(`\nИТОГО по ${mine.length} филиалам, с баллом ${scores.length}:`
      + ` средний ${avg === null ? '—' : avg.toFixed(1)}`);
  });
}
main().catch(e => { console.error(String(e?.message ?? e)); process.exitCode = 1; }).finally(closePool);
