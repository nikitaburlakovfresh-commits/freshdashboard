import { withTransaction } from '../db/pool';
import type { ActorContext } from './workItemService';
import { getEffectiveGrants } from './grants';
import { dailyDate, liveFence } from './dailyLogs';
import { ApiError } from '../util/errors';

// Live operational view, NOT historical KPI facts or publication of previews.
export async function operationalOverview(ctx:ActorContext,dateRaw:unknown,org?:string) {
  const date=dailyDate(dateRaw);
  return withTransaction(async c=>{
    await liveFence(c,ctx);
    const grants=(await getEffectiveGrants(c,ctx.authUser.userId)).filter(g=>g.orgUnitId&&g.permissions.includes('work_item.read'));
    const orgs=[...new Set(grants.map(g=>g.orgUnitId!))];
    if(org&&!orgs.includes(org)) throw new ApiError('NOT_FOUND','Филиал недоступен.');
    const scopes=org?[org]:orgs;
    const managers=grants.filter(g=>g.role==='REGIONAL_MANAGER').map(g=>g.orgUnitId!);
    const branches=(await c.query(`SELECT d.id,d.code,d.is_demo,d.type_code,
      org_lifecycle_at(d.id,$2::date) lifecycle_state,n.display_name,a.business_model
      FROM org_directory_units d
      JOIN org_directory_name_history n ON n.org_unit_id=d.id AND n.effective_from<=$2::date AND (n.effective_to IS NULL OR n.effective_to>$2::date)
      JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id AND a.effective_from<=$2::date AND (a.effective_to IS NULL OR a.effective_to>$2::date)
      WHERE d.id=ANY($1::uuid[]) AND d.kind='ORG_UNIT' AND d.effective_from<=$2::date AND (d.effective_to IS NULL OR d.effective_to>$2::date)
      ORDER BY n.display_name`,[scopes,date])).rows;
    if(org&&!branches.length) throw new ApiError('NOT_FOUND','Филиал не найден на выбранную дату.');
    // Server-side aggregate counts are independent of the attention-list cap.
    // Counts and attention are separate statements in this live operational view.
    const visible=`WITH visible AS MATERIALIZED (
      SELECT w.*,d.business_date,d.role_code daily_role,t.field_ownership_rules
      FROM work_items w JOIN templates t ON t.id=w.template_version_id
      LEFT JOIN daily_log_records d ON d.work_item_id=w.id
      WHERE w.org_unit_id=ANY($1::uuid[]) AND (
        w.org_unit_id=ANY($2::uuid[]) OR (d.work_item_id IS NOT NULL AND w.org_unit_id=ANY($5::uuid[])) OR (w.assignee_user_id=$3 AND EXISTS (
          SELECT 1 FROM role_grants g WHERE g.user_id=$3 AND g.org_unit_id=w.org_unit_id
            AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
            AND EXISTS(SELECT 1 FROM jsonb_each_text(t.field_ownership_rules))
            AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(t.field_ownership_rules) o WHERE o.value<>g.role_code)
        )))
    )`;
    // РФ и дивизиональный читают ежедневники филиала без проверки (26.09.2026).
    const diaryReaders=grants.filter(g=>g.role==='RF'||g.role==='DIVISION_MANAGER').map(g=>g.orgUnitId!);
    const values=[branches.map(b=>b.id),managers,ctx.authUser.userId,date,diaryReaders];
    const stats=(await c.query(`${visible}
      SELECT org_unit_id,
      count(*) FILTER(WHERE business_date IS NULL AND status NOT IN('COMPLETED','CANCELLED'))::int open_tasks,
      count(*) FILTER(WHERE business_date IS NULL AND status IN('ASSIGNED','IN_PROGRESS') AND due_at<now())::int overdue_tasks,
      count(*) FILTER(WHERE business_date IS NULL AND status='SUBMITTED')::int awaiting_review,
      count(*) FILTER(WHERE business_date IS NULL AND status='COMPLETED')::int completed_tasks,
      count(*) FILTER(WHERE business_date=$4::date AND status IN('ASSIGNED','IN_PROGRESS'))::int diary_drafts,
      count(*) FILTER(WHERE business_date=$4::date AND status='SUBMITTED')::int diary_submitted,
      count(*) FILTER(WHERE business_date=$4::date AND status='COMPLETED')::int diary_accepted,
      coalesce(jsonb_agg(jsonb_build_object('id',id,'title',title,'status',status,'role',daily_role)
        ORDER BY created_at) FILTER(WHERE business_date=$4::date),'[]'::jsonb) diaries
      FROM visible GROUP BY org_unit_id`,values)).rows;
    // Прогресс заполнения ежедневника: сколько полей заполнено из схемы шаблона
    // и сколько обязательных. Без этого руководитель видит только «в работе» и
    // не понимает, там одно поле или двадцать восемь задач. Этот же процент
    // нужен сводке — в старом портале он в ней был.
    //
    // Пустая строка считается незаполненным полем: пробел не ответ. Отметка
    // «Не выполнено» — заполненное поле, это осознанный ответ руководителя.
    const fill=(await c.query(`${visible}
      SELECT v.id work_item_id,v.org_unit_id,v.daily_role,v.status,
        (SELECT count(*) FROM jsonb_array_elements(t.field_schema) e)::int total,
        (SELECT count(*) FROM jsonb_array_elements(t.field_schema) e
          WHERE coalesce(e.value->>'required','false')='true')::int required_total,
        count(f.field_path) FILTER(WHERE f.value IS NOT NULL AND btrim(f.value)<>'')::int filled,
        count(f.field_path) FILTER(WHERE f.value IS NOT NULL AND btrim(f.value)<>''
          AND EXISTS(SELECT 1 FROM jsonb_array_elements(t.field_schema) e
            WHERE e.value->>'field_path'=f.field_path AND coalesce(e.value->>'required','false')='true'))::int required_filled
      FROM visible v
      JOIN templates t ON t.id=v.template_version_id
      LEFT JOIN work_item_fields f ON f.work_item_id=v.id
      WHERE v.business_date=$4::date
      GROUP BY v.id,v.org_unit_id,v.daily_role,v.status,t.field_schema`,values)).rows;
    // Сколько ролей обязано сдать ежедневник на этом филиале: роли берутся из
    // настроенных окон заполнения, а не из списка того, что уже создано.
    // Ежедневник, который не создали, — это ноль, а не отсутствие обязанности.
    const expected=(await c.query(
      `SELECT org_unit_id,count(DISTINCT role_code)::int roles
         FROM daily_log_policies WHERE org_unit_id=ANY($1::uuid[])
          AND effective_from<=$2::date GROUP BY org_unit_id`,
      [branches.map(b=>b.id),date])).rows;
    const attention=(await c.query(`${visible} SELECT id,org_unit_id,title,status,due_at FROM visible
      WHERE business_date IS NULL AND status IN('ASSIGNED','IN_PROGRESS','SUBMITTED') AND $4::date IS NOT NULL
      ORDER BY due_at,id LIMIT 10`,values)).rows;
    const policies=org?(await c.query(`SELECT DISTINCT ON(role_code) *,to_char(effective_from,'YYYY-MM-DD') effective_from
      FROM daily_log_policies WHERE org_unit_id=$1 ORDER BY role_code,version DESC`,[org])).rows:[];
    const clock=(await c.query("SELECT now() AS server_time,to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0];
    return {business_date:date,current_business_date:clock.day,server_time:clock.server_time,
      scope:'CURRENT_EXACT_GRANTS',task_basis:'CURRENT_STATE_ALL_DATES',metric_state:'SEPARATE_AUTHORIZED_QUERY',
      branches:branches.map(b=>({...b,can_manage:managers.includes(b.id),visibility:managers.includes(b.id)?'BRANCH':'PERSONAL',
        ...(stats.find(s=>s.org_unit_id===b.id)??{open_tasks:0,overdue_tasks:0,awaiting_review:0,completed_tasks:0,diary_drafts:0,diary_submitted:0,diary_accepted:0,diaries:[]}),
        diary_completion:diaryCompletion(
          fill.filter((f:any)=>f.org_unit_id===b.id),
          expected.find((e:any)=>e.org_unit_id===b.id)?.roles??0)})),
      attention,policies};
  });
}

/**
 * Прогресс заполнения ежедневников филиала за день.
 *
 * `expected_roles` — сколько ролей обязано сдать по настроенным окнам. Если окна
 * не настроены, обязанности нет, и процент не считается: ноль из нуля — это не
 * «ничего не сделали», а «нечего было делать».
 *
 * `fill_pct` — среднее заполнение созданных ежедневников по всем полям схемы.
 * Считается по факту заполненных полей, а не по статусу: «в работе» может
 * означать и одно поле, и двадцать семь.
 */
function diaryCompletion(rows:any[],expectedRoles:number) {
  const created=rows.length;
  const submitted=rows.filter(r=>['SUBMITTED','COMPLETED'].includes(r.status)).length;
  const totals=rows.reduce((acc,r)=>({filled:acc.filled+r.filled,total:acc.total+r.total,
    required_filled:acc.required_filled+r.required_filled,required_total:acc.required_total+r.required_total}),
    {filled:0,total:0,required_filled:0,required_total:0});
  return {
    expected_roles:expectedRoles,created,submitted,
    // Процент сдачи — от обязанных ролей, а не от созданных записей: иначе
    // филиал, не создавший ни одного ежедневника, покажет 100%.
    submitted_pct:expectedRoles>0?submitted/expectedRoles*100:null,
    fill_pct:totals.total>0?totals.filled/totals.total*100:null,
    required_fill_pct:totals.required_total>0?totals.required_filled/totals.required_total*100:null,
    fields_filled:totals.filled,fields_total:totals.total,
    // Отдельно по каждому созданному ежедневнику: руководителю нужно знать, у
    // кого именно провал, а не только средний процент по филиалу.
    by_role:rows.map(r=>({work_item_id:r.work_item_id,role:r.daily_role,status:r.status,
      filled:r.filled,total:r.total,
      fill_pct:r.total>0?r.filled/r.total*100:null})),
  };
}
