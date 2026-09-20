import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { METRIC_NAMES } from './shared/reportModel';
import { provisionFactAccess } from './factProvisioning';

/**
 * Явная выдача чтения опубликованных показателей по всем действующим реальным
 * филиалам сети одному сотруднику.
 *
 * Неявного сетевого читателя в модели нет и не появляется: на каждый филиал
 * создаётся отдельное назначение области видимости и отдельный допуск к
 * закрытому перечню показателей, каждый со своей записью аудита. Демо-филиалы
 * пилота и филиалы вне активного жизненного цикла не затрагиваются.
 * Уже существующие назначения и допуски не перезаписываются.
 */
export async function provisionBranchReader(login:string,roleCode:string,metrics:string[],approval:string) {
  if(!login||!roleCode||!metrics.length||metrics.length>8||
    new Set(metrics).size!==metrics.length||metrics.some(m=>!Object.hasOwn(METRIC_NAMES,m))||
    approval.trim().length<16||approval.length>500)
    throw new Error('Login, role, metric allowlist (1–8) and explicit approval required');

  const prepared=await withTransaction(async c=>{
    await c.query('LOCK TABLE app_users,role_grants,org_directory_units IN SHARE ROW EXCLUSIVE MODE');
    const user=(await c.query(`SELECT id FROM app_users WHERE login=$1 AND is_active
      AND user_kind='INDIVIDUAL' AND NOT password_last_shared_indicator`,[login])).rows[0];
    if(!user) throw new Error('Active individual account required');
    if(!(await c.query('SELECT 1 FROM roles WHERE code=$1',[roleCode])).rowCount)
      throw new Error('Unknown role code');
    const units=(await c.query(`SELECT id,code FROM org_directory_units
      WHERE kind='ORG_UNIT' AND effective_to IS NULL AND NOT is_demo AND NOT demo_locked
        AND org_lifecycle_at(id,(now() AT TIME ZONE 'UTC')::date)='ACTIVE'
      ORDER BY code`)).rows as {id:string;code:string}[];
    if(!units.length) throw new Error('No active real branches in directory');

    const created:{branch:string;grant_id:string;reused:boolean}[]=[];
    for(const u of units) {
      const existing=(await c.query(`SELECT id FROM role_grants WHERE user_id=$1 AND org_unit_id=$2
        AND scope_kind='ORG_UNIT' AND role_code=$3 AND revoked_at IS NULL
        AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())`,
      [user.id,u.id,roleCode])).rows[0];
      if(existing) {created.push({branch:u.code,grant_id:existing.id,reused:true});continue;}
      const eventId=randomUUID();
      const audit=await writeAuditAndOutbox(c,{actorUserId:null,actorRole:null,orgUnitId:u.id,workItemId:null,
        action:'ROLE_GRANT_PROVISIONED',aggregateType:'access',aggregateId:eventId,aggregateVersion:1,
        requestId:eventId,beforeState:null,
        afterState:{login,role_code:roleCode,org_unit_id:u.id,scope_kind:'ORG_UNIT'},
        reason:approval.trim(),resolution:'APPLIED',retentionClass:'SECURITY_5Y',
        eventType:'access.role_grant',payload:{login,org_unit_id:u.id}});
      const row=(await c.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
        VALUES($1,$2,$3,'ORG_UNIT',now()) RETURNING id`,[user.id,roleCode,u.id])).rows[0];
      created.push({branch:u.code,grant_id:row.id,reused:false});
      void audit;
    }
    return created;
  });

  // Допуск к показателям выдаётся штатным сценарием по каждому назначению
  // отдельно, поэтому уже выданные допуски остаются нетронутыми.
  const results:{branch:string;status:string}[]=[];
  for(const g of prepared) {
    try{
      await provisionFactAccess(g.grant_id,'READ',metrics,approval);
      results.push({branch:g.branch,status:'READ_PROVISIONED'});
    }catch(e:any){
      results.push({branch:g.branch,status:`SKIPPED: ${e?.message??'refused'}`});
    }
  }
  return {login,role_code:roleCode,metrics,branches:results.length,results};
}
