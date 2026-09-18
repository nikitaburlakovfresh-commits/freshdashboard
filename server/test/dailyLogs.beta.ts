import request from 'supertest';
import { pool,closePool } from '../src/db/pool';
import { _resetForTests as reset } from '../src/auth/rateLimit';
import { app,authed,login,idemKey,Session } from './helpers';
const A='00000000-0000-4000-8000-00000000000a',B='00000000-0000-4000-8000-00000000000b';
let rm:Session,rf:Session,other:Session,today:string;
beforeAll(async()=>{
  rm=await login('rm_a');rf=await login('rf_a');other=await login('rf_b');
  today=(await pool.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day;
});
beforeEach(reset);afterAll(closePool);
const policy=(role='RF',version=0)=>({role,expected_version:version,effective_from:today,base_open_time:'00:00',base_close_time:'23:59',early_open_hours:24,late_close_hours:48,reason:'Синтетическая beta-проверка'});
async function open(role='RF',session=rf,date=today) {
  return authed(session).post('/api/v1/daily-logs/open').send({org_unit_id:A,role,business_date:date});
}
async function field(id:string,path:string,value:string,version=1,session=rf) {
  return authed(session).patch(`/api/v1/work-items/${id}/fields`).set('Idempotency-Key',idemKey('dailyfield')).send({changes:[{field_path:path,new_value:value,expected_version:version}]});
}
async function task() {
  const t=await authed(rm).post('/api/v1/work-items').set('Idempotency-Key',idemKey('diarytask'))
    .send({org_unit_id:A,template_code:'pilot_task_v1',title:'Синтетическая задача с результатом',due_at:'2025-01-01T00:00:00Z'});
  expect(t.status).toBe(201);
  expect((await authed(rm).post(`/api/v1/work-items/${t.body.id}/assign`).set('Idempotency-Key',idemKey('diaryassign')).send({expected_entity_version:1,assignee_user_id:rf.userId})).status).toBe(200);
  const filled=await field(t.body.id,'completion_summary','Первый неизменяемый результат выполнения для дневной записи');
  expect(filled.status).toBe(200);return filled.body;
}
test('no anonymous access, CSRF bypass or invented policy default',async()=>{
  expect((await request(app).get(`/api/v1/daily-logs/overview?business_date=${today}`)).status).toBe(401);
  expect((await request(app).post('/api/v1/daily-logs/open').set('Cookie',rf.cookie).send({})).status).toBe(403);
  expect((await open()).status).toBe(422);
  expect((await authed(rf).post(`/api/v1/daily-logs/policies/${A}`).send(policy())).status).toBe(404);
  expect((await authed(other).get(`/api/v1/daily-logs/day?org_unit_id=${A}&role=RF&business_date=${today}`)).status).toBe(404);
});
test('manager sets policy with CAS, explicit dates and immutable history',async()=>{
  const saved=await authed(rm).post(`/api/v1/daily-logs/policies/${A}`).send(policy());
  expect(saved.status).toBe(200);expect(saved.body.version).toBe(1);
  expect((await authed(rm).post(`/api/v1/daily-logs/policies/${A}`).send(policy())).status).toBe(409);
  expect((await authed(rm).post(`/api/v1/daily-logs/policies/${A}`).send({...policy('RF',1),effective_from:'2020-01-01'})).status).toBe(422);
  await expect(pool.query('DELETE FROM daily_log_policies WHERE id=$1',[saved.body.id])).rejects.toThrow(/immutable/);
});
test('concurrent open is unique by person role branch day',async()=>{
  const responses=await Promise.all([open(),open(),open()]);
  responses.forEach(r=>expect(r.status).toBe(200));
  expect(new Set(responses.map(r=>r.body.id)).size).toBe(1);
  const card=await authed(rf).get(`/api/v1/work-items/${responses[0].body.id}`);
  expect(card.body.daily_log).toMatchObject({business_date:today,role_code:'RF',can_fill:true});
  expect(card.body.assignee_user_id).toBe(rf.userId);
  const count=await pool.query('SELECT count(*) FROM audit_log WHERE work_item_id=$1 AND action=$2',[responses[0].body.id,'CREATE']);
  expect(count.rows[0].count).toBe(1);
});
test('separate roles cannot share diary or override pinned policy',async()=>{
  const original=(await open()).body.id;
  const before=(await authed(rf).get(`/api/v1/work-items/${original}`)).body.daily_log;
  expect((await authed(rm).post(`/api/v1/daily-logs/policies/${A}`).send({...policy('RF',1),late_close_hours:24})).status).toBe(200);
  const after=(await authed(rf).get(`/api/v1/work-items/${original}`)).body.daily_log;
  expect(after).toEqual(before);
  expect((await open('ROP')).status).toBe(404);
  await pool.query("INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from) VALUES($1,'ROP',$2,now())",[rf.userId,A]);
  expect((await authed(rm).post(`/api/v1/daily-logs/policies/${A}`).send(policy('ROP'))).status).toBe(200);
  const rop=await open('ROP');expect(rop.status).toBe(200);expect(rop.body.id).not.toBe(original);
  expect((await authed(rf).post('/api/v1/work-items').set('Idempotency-Key',idemKey('badtemplate'))
    .send({org_unit_id:A,template_code:'personal_daily_rf_v1',title:'Bypass',due_at:'2026-09-18T00:00:00Z'})).status).toBe(422);
});
test('invalid date, future fill window, different branch denied',async()=>{
  for(const date of ['2026-02-30','bad','2099-01-01']) expect((await open('RF',rf,date)).status).toBe(422);
  expect((await authed(rf).post('/api/v1/daily-logs/open').send({org_unit_id:B,role:'RF',business_date:today})).status).toBe(404);
});
test('task submit creates immutable link atomically and retry does not duplicate',async()=>{
  const t=await task(),key=idemKey('linksubmit');
  const body={expected_entity_version:t.entity_version,add_to_daily_log:true,business_date:today};
  const submit=()=>authed(rf).post(`/api/v1/work-items/${t.id}/submit`).set('Idempotency-Key',key).send(body);
  const first=await submit(),second=await submit();
  expect(first.status).toBe(200);expect(second.body.current_submission.id).toBe(first.body.current_submission.id);
  const day=(await authed(rf).get(`/api/v1/daily-logs/day?org_unit_id=${A}&role=RF&business_date=${today}`)).body;
  expect(day.links.filter((l:any)=>l.submission_id===first.body.current_submission.id)).toHaveLength(1);
  const rework=await authed(rm).post(`/api/v1/work-items/${t.id}/rework`).set('Idempotency-Key',idemKey('linkrework'))
    .send({expected_entity_version:first.body.entity_version,submission_id:first.body.current_submission.id,submission_revision:1,reason:'Нужна детализация результата'});
  expect(rework.status).toBe(200);
  const patched=await field(t.id,'completion_summary','Вторая редакция, старый текст сохраняется в снимке',2);
  const resubmitted=await authed(rf).post(`/api/v1/work-items/${t.id}/submit`).set('Idempotency-Key',idemKey('linkresubmit'))
    .send({expected_entity_version:patched.body.entity_version,add_to_daily_log:true,business_date:today});
  expect(resubmitted.status).toBe(200);
  const updated=(await authed(rf).get(`/api/v1/daily-logs/day?org_unit_id=${A}&role=RF&business_date=${today}`)).body;
  const versions=updated.links.filter((l:any)=>l.work_item_id===t.id);
  expect(versions).toHaveLength(2);expect(versions[0].completion_summary).toContain('Первый');expect(versions[1].completion_summary).toContain('Вторая');
});
test('outside window link rolls back submission status and all evidence',async()=>{
  const t=await task();
  const before=(await pool.query('SELECT count(*) FROM submissions WHERE work_item_id=$1',[t.id])).rows;
  const result=await authed(rf).post(`/api/v1/work-items/${t.id}/submit`).set('Idempotency-Key',idemKey('linkoutside'))
    .send({expected_entity_version:t.entity_version,add_to_daily_log:true,business_date:'2099-01-01'});
  expect(result.status).toBe(422);
  expect((await pool.query('SELECT count(*) FROM submissions WHERE work_item_id=$1',[t.id])).rows).toEqual(before);
  expect((await authed(rf).get(`/api/v1/work-items/${t.id}`)).body.status).toBe('ASSIGNED');
});
test('daily fill preserves CAS and full submit/review lifecycle',async()=>{
  const id=(await open()).body.id;
  let patched:any;
  for(const [p,v] of [['day_plan','План работы на день'],['completion_summary','Итоги и следующий шаг'],['risks','Нет выявленных рисков']]) {
    patched=await field(id,p,v);expect(patched.status).toBe(200);
  }
  expect((await field(id,'day_plan','Потерянное обновление')).status).toBe(409);
  const submitted=await authed(rf).post(`/api/v1/work-items/${id}/submit`).set('Idempotency-Key',idemKey('daily-sub'))
    .send({expected_entity_version:patched.body.entity_version});
  expect(submitted.status).toBe(200);
  const snapshots=await pool.query('SELECT task_submission_id FROM daily_submission_links WHERE daily_submission_id=$1',[submitted.body.current_submission.id]);
  expect(snapshots.rowCount).toBe(2);
  await expect(pool.query('DELETE FROM daily_submission_links WHERE daily_submission_id=$1',[submitted.body.current_submission.id])).rejects.toThrow(/immutable/);
  expect((await pool.query('SELECT marker FROM daily_submission_markers WHERE submission_id=$1',[submitted.body.current_submission.id])).rowCount).toBe(1);
  expect((await field(id,'risks','Поздняя правка',2)).status).toBe(422);
  const accepted=await authed(rm).post(`/api/v1/work-items/${id}/accept`).set('Idempotency-Key',idemKey('daily-accept'))
    .send({expected_entity_version:submitted.body.entity_version,submission_id:submitted.body.current_submission.id,submission_revision:1});
  expect(accepted.status).toBe(200);
});
test('submitted/accepted diary refuses late append, task remains editable',async()=>{
  const t=await task();
  const res=await authed(rf).post(`/api/v1/work-items/${t.id}/submit`).set('Idempotency-Key',idemKey('closedlink'))
    .send({expected_entity_version:t.entity_version,add_to_daily_log:true,business_date:today});
  expect(res.status).toBe(422);
  expect((await authed(rf).get(`/api/v1/work-items/${t.id}`)).body.status).toBe('ASSIGNED');
});
test('overview exact scope, accepted diary not counted as task, null business KPIs',async()=>{
  const view=await authed(rm).get(`/api/v1/daily-logs/overview?business_date=${today}`);
  expect(view.status).toBe(200);
  expect(view.body.branches.map((b:any)=>b.id)).toEqual([A]);
  expect(view.body.metric_state).toBe('NOT_PUBLISHED');
  expect(view.body.branches[0].diary_accepted).toBe(1);
  expect(view.body.branches[0].completed_tasks).toBe(0);
  expect(view.body.attention.every((t:any)=>!t.title.startsWith('Ежедневник'))).toBe(true);
  expect((await authed(other).get(`/api/v1/daily-logs/overview?business_date=${today}&org_unit_id=${A}`)).status).toBe(404);
});
test('revoked diary role cannot leak through list, detail, history or branch counters',async()=>{
  const id=(await open()).body.id;
  // Separate synthetic user for revocation; do not mutate shared fixture grants.
  await pool.query(`INSERT INTO app_users(login,full_name,password_hash,password_hash_updated_at)
    SELECT 'diary_revoke','Проверка отзыва',password_hash,now() FROM app_users WHERE id=$1`,[rf.userId]);
  const dual=await login('diary_revoke');
  await pool.query("INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from) VALUES($1,'RF',$2,now())",[dual.userId,A]);
  const own=(await open('RF',dual)).body.id;
  await pool.query("INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from) VALUES($1,'ROP',$2,now())",[dual.userId,A]);
  await pool.query("UPDATE role_grants SET revoked_at=now() WHERE user_id=$1 AND role_code IN('RF','REGIONAL_MANAGER')",[dual.userId]);
  for(const path of [`/work-items/${own}`,`/work-items/${own}/history`])
    expect((await authed(dual).get(`/api/v1${path}`)).status).toBe(404);
  const list=await authed(dual).get('/api/v1/work-items?limit=100');
  expect(list.body.items.some((t:any)=>[id,own].includes(t.id))).toBe(false);
  const view=await authed(dual).get(`/api/v1/daily-logs/overview?business_date=${today}`);
  expect(view.body.branches[0].diaries).toEqual([]);
});
test('an existing expired diary is readable but cannot start, save or submit',async()=>{
  const original=(await open()).body.id;
  const expired=(await pool.query(`INSERT INTO work_items(org_unit_id,template_version_id,title,due_at,status,assignee_user_id,created_by)
    SELECT org_unit_id,template_version_id,'Истёкшее окно: синтетическая запись',now()-interval '1 year','ASSIGNED',assignee_user_id,created_by
    FROM work_items WHERE id=$1 RETURNING id`,[original])).rows[0].id;
  await pool.query(`INSERT INTO daily_log_records(work_item_id,org_unit_id,user_id,role_code,business_date,policy_id,base_open,base_close,window_open,window_close)
    SELECT $2,org_unit_id,user_id,role_code,business_date-365,policy_id,base_open-interval '1 year',base_close-interval '1 year',window_open-interval '1 year',window_close-interval '1 year'
    FROM daily_log_records WHERE work_item_id=$1`,[original,expired]);
  await pool.query(`INSERT INTO work_item_fields(work_item_id,org_unit_id,field_path,updated_by)
    SELECT $2,org_unit_id,field_path,updated_by FROM work_item_fields WHERE work_item_id=$1`,[original,expired]);
  const card=await authed(rf).get(`/api/v1/work-items/${expired}`);
  expect(card.status).toBe(200);expect(card.body.daily_log.can_fill).toBe(false);
  expect((await field(expired,'day_plan','Недопустимая правка')).status).toBe(422);
  for(const action of ['start','submit']) {
    expect((await authed(rf).post(`/api/v1/work-items/${expired}/${action}`).set('Idempotency-Key',idemKey('expired'))
      .send({expected_entity_version:1})).status).toBe(422);
  }
  expect((await pool.query('SELECT count(*) FROM submissions WHERE work_item_id=$1',[expired])).rows[0].count).toBe(0);
});
