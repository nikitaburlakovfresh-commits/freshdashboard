import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';
import { canonicalJsonHash } from '../util/crypto';
import { beginIdempotent, completeIdempotent } from './idempotency';
import { writeAuditAndOutbox } from './auditOutbox';
import { isServiceActor, serviceAuthorization } from './serviceActor';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid=(message:string)=>new ApiError('VALIDATION_ERROR',message);
const conflict=()=>new ApiError('ENTITY_VERSION_CONFLICT','Проверка устарела. Откройте предложение заново и повторите проверку.');
type Proposal=Record<string,any>;
type Change={operation:'GRANT_ROLE';user_id:string;role_code:string;org_unit_id:string;valid_from:string;valid_until:string|null;reason:string}
 |{operation:'REVOKE_ROLE';grant_id:string;reason:string};
const userColumns='id,login,full_name,user_kind,is_active,password_last_shared_indicator';
const safePermissions=new Set(['work_item.read','work_item.create','work_item.assign','work_item.start',
  'work_item.fields.write','work_item.submit','work_item.accept','work_item.rework','work_item.cancel',
  'work_item.reopen','work_item.history.read','notification.read']);

// Сервисному субъекту доступен только закрытый перечень настроек канона
// (пороги, модель балла, фокусы) — по явному разрешению владельца продукта.
// Управление людьми, ролями и назначениями сервисному контуру недоступно и
// остаётся за живым администратором с действующей сессией.
// Названия филиалов в источниках добавлены в сервисную настройку по явному
// решению владельца продукта 19.09.2026 для разового наполнения справочника;
// возможность отзывается вместе с субъектом, управление людьми недоступно.
const serviceConfigurable=new Set(['metric.threshold.manage','metric.scoring.manage','metric.focus.manage',
  'report.source_naming.manage']);

export async function authorizeNetworkPermissions(client:PoolClient,auth:AuthedUser,required:string[]) {
  if(await isServiceActor(client,auth.userId)) {
    if(!required.length||required.some(p=>!serviceConfigurable.has(p)))
      throw new ApiError('FORBIDDEN','Сервисному контуру доступна только настройка порогов, модели балла, фокусов и названий филиалов в отчётах.');
    const service=await serviceAuthorization(client,auth.userId,'CONFIGURE');
    if(!service) throw new ApiError('FORBIDDEN','Сервисному субъекту не выдана действующая возможность CONFIGURE.');
    const rows=await client.query(`SELECT DISTINCT rp.permission_code FROM role_grants g
      JOIN roles r ON r.code=g.role_code AND r.scope_kind=g.scope_kind
      JOIN role_permissions rp ON rp.role_code=r.code
      WHERE g.id=$1`,[service.grantId]);
    const granted=new Set(rows.rows.map(r=>r.permission_code));
    if(required.some(p=>!granted.has(p)))
      throw new ApiError('FORBIDDEN','У гранта сервисного субъекта нет требуемого права настройки.');
    return;
  }
  // One consistent lock order; no SHARE -> write lock upgrade between admins.
  await client.query('LOCK TABLE app_users, sessions, role_grants, roles, role_permissions IN SHARE ROW EXCLUSIVE MODE');
  const rows=await client.query(`SELECT DISTINCT rp.permission_code FROM app_users u
    JOIN sessions s ON s.user_id=u.id JOIN role_grants g ON g.user_id=u.id
    JOIN roles r ON r.code=g.role_code AND r.scope_kind=g.scope_kind
    JOIN role_permissions rp ON rp.role_code=r.code
    WHERE u.id=$1 AND s.id=$2 AND u.is_active AND u.user_kind='INDIVIDUAL'
      AND NOT u.password_last_shared_indicator AND s.revoked_at IS NULL
      AND s.captured_auth_epoch=u.auth_epoch AND u.password_hash_updated_at<=s.created_at
      AND s.expires_at>now() AND s.created_at>now()-interval '8 hours' AND s.last_seen_at>now()-interval '30 minutes'
      AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL AND g.revoked_at IS NULL
      AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())`,[auth.userId,auth.sessionId]);
  const permissions=new Set(rows.rows.map(r=>r.permission_code));
  if(required.some(p=>!permissions.has(p)))
    throw new ApiError('FORBIDDEN','Требуются явные права управления назначениями с областью NETWORK.');
}
async function authorize(client:PoolClient,auth:AuthedUser,phase:string) {
  await authorizeNetworkPermissions(client,auth,['access.directory.read',...(phase==='read'?[]:[`access.change.${phase}`,'user.assign_role'])]);
}
function object(raw:unknown,keys:string[]):Record<string,any> {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))
    throw invalid('Неизвестные поля команды.');
  return raw as Record<string,any>;
}
function timestamp(value:unknown):value is string {
  return typeof value==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
}
function parseChange(raw:unknown):Change {
  const c=object(raw,['operation','user_id','role_code','org_unit_id','valid_from','valid_until','grant_id','reason']);
  if(typeof c.reason!=='string'||c.reason.trim().length<10||c.reason.length>500) throw invalid('Укажите основание: от 10 до 500 символов.');
  if(c.operation==='REVOKE_ROLE') {
    if(!uuid.test(c.grant_id??'')||Object.keys(c).some(k=>!['operation','grant_id','reason'].includes(k))) throw invalid('Выберите одно назначение для отзыва.');
  } else if(c.operation==='GRANT_ROLE') {
    if(!uuid.test(c.user_id??'')||!uuid.test(c.org_unit_id??'')||typeof c.role_code!=='string'||
      !/^[A-Z][A-Z0-9_]{0,79}$/.test(c.role_code)||c.grant_id!==undefined||
      (c.valid_from!=='NOW'&&!timestamp(c.valid_from))||(c.valid_until!==null&&!timestamp(c.valid_until)))
      throw invalid('Нужны пользователь, роль, филиал и интервал UTC. Начало: NOW либо точная дата.');
  } else throw invalid('Поддерживаются только GRANT_ROLE и REVOKE_ROLE.');
  return {...c,reason:c.reason.trim()} as Change;
}
function publicProposal(p:Proposal) { const {preview_hash,...safe}=p; return safe; }
async function load(client:PoolClient,id:string) {
  if(!uuid.test(id)) throw new ApiError('NOT_FOUND','Предложение не найдено.');
  const p=(await client.query('SELECT * FROM access_change_proposals WHERE id=$1 FOR UPDATE',[id])).rows[0];
  if(!p) throw new ApiError('NOT_FOUND','Предложение не найдено.');
  return p as Proposal;
}
async function validate(client:PoolClient,p:Proposal,auth:AuthedUser) {
  const c=p.change as Change,issues:string[]=[];
  const now=(await client.query('SELECT now() AS now')).rows[0].now as Date;
  const grant=c.operation==='REVOKE_ROLE'
    ?(await client.query('SELECT * FROM role_grants WHERE id=$1',[c.grant_id])).rows[0]:null;
  const userId=c.operation==='GRANT_ROLE'?c.user_id:grant?.user_id;
  const orgId=c.operation==='GRANT_ROLE'?c.org_unit_id:grant?.org_unit_id;
  const roleCode=c.operation==='GRANT_ROLE'?c.role_code:grant?.role_code;
  const user=userId?(await client.query(`SELECT ${userColumns} FROM app_users WHERE id=$1`,[userId])).rows[0]:null;
  const grants=userId?(await client.query('SELECT * FROM role_grants WHERE user_id=$1 ORDER BY id',[userId])).rows:[];
  const role=roleCode?(await client.query(`SELECT r.code,r.display_name,r.scope_kind,
    ARRAY(SELECT permission_code FROM role_permissions WHERE role_code=r.code ORDER BY permission_code) permissions
    FROM roles r WHERE r.code=$1`,[roleCode])).rows[0]:null;
  const branch=orgId?(await client.query(`SELECT id,code,kind,
    org_lifecycle_at(id,(now() AT TIME ZONE 'UTC')::date) lifecycle_state,is_demo,demo_locked,
    to_char(effective_from,'YYYY-MM-DD') effective_from,to_char(effective_to,'YYYY-MM-DD') effective_to
    FROM org_directory_units WHERE id=$1`,[orgId])).rows[0]:null;
  if(!user||user.user_kind!=='INDIVIDUAL'||user.password_last_shared_indicator) issues.push('Требуется существующая личная учётная запись.');
  if(userId===auth.userId||grants.some(g=>g.scope_kind==='NETWORK')) issues.push('Собственные назначения и учётные записи с сетевыми правами здесь не изменяются.');
  if(!role||role.scope_kind!=='ORG_UNIT'||!role.permissions.length||role.permissions.some((v:string)=>!safePermissions.has(v)))
    issues.push('Роль не имеет поддерживаемого набора операционных прав филиала.');
  if(!branch||branch.kind!=='ORG_UNIT'||branch.is_demo||branch.demo_locked) issues.push('Выберите реальный филиал; A/B и другие уровни недоступны.');
  let activeTasks=0;
  if(userId&&orgId) activeTasks=(await client.query(`SELECT count(*)::int n FROM work_items WHERE org_unit_id=$1
    AND (assignee_user_id=$2 OR created_by=$2) AND status NOT IN ('COMPLETED','CANCELLED')`,[orgId,userId])).rows[0].n;
  if(c.operation==='GRANT_ROLE') {
    const start=c.valid_from==='NOW'?now:new Date(c.valid_from),end=c.valid_until?new Date(c.valid_until):null;
    if(!user?.is_active) issues.push('Пользователь не активен.');
    if(branch?.lifecycle_state!=='ACTIVE') issues.push('Филиал не введён в эксплуатацию. Активация здесь не выполняется.');
    if(start<now||(end&&end<=start)) issues.push('Интервал должен начинаться сейчас или в будущем и иметь положительную длительность.');
    if(branch && (start.toISOString().slice(0,10)<branch.effective_from ||
      (branch.effective_to&&(!end||end>new Date(`${branch.effective_to}T00:00:00.000Z`)))))
      issues.push('Интервал выходит за даты существования филиала.');
    if(grants.some(g=>g.role_code===c.role_code&&g.org_unit_id===c.org_unit_id&&!g.revoked_at&&
      (!end||new Date(g.valid_from)<end)&&(!g.valid_until||new Date(g.valid_until)>start)))
      issues.push('У пользователя уже есть пересекающееся назначение этой роли в филиале.');
  } else {
    if(!grant||grant.scope_kind!=='ORG_UNIT'||grant.revoked_at||(grant.valid_until&&new Date(grant.valid_until)<=now))
      issues.push('Назначение отсутствует, отозвано или завершено.');
    if(activeTasks) issues.push('Есть незавершённые задачи пользователя в филиале. Сначала передайте или завершите их.');
  }
  const summary={valid:!issues.length,issues,operation:c.operation,user:user?{id:user.id,login:user.login,full_name:user.full_name}:null,
    branch,role,grant:grant??null,valid_from:c.operation==='GRANT_ROLE'?c.valid_from:null,
    valid_until:c.operation==='GRANT_ROLE'?c.valid_until:null,
    affected:{role_grants:1,active_tasks:activeTasks,changed_tasks:0,financial_records:0},
    warning:'Точечное назначение, без наследования на дивизион и без смены подчинённости. История задач и показатели не переписываются. Отзыв действует сразу; выдача начинается в указанный момент.'};
  // Bind the preview to all authorization-relevant target state, not a clock tick.
  const hash=canonicalJsonHash({change:c,user,grants,role,branch,activeTasks});
  return {summary,hash};
}
export async function accessDirectory(auth:AuthedUser) {
  return withTransaction(async client=>{
    await authorize(client,auth,'read');
    // Fail explicitly rather than present an incomplete scope as complete.
    const users=(await client.query(`SELECT ${userColumns},primary_email,
      (SELECT jsonb_build_object('version',e.version,'expires_at',e.expires_at,
        'completed_at',e.completed_at,'has_invitation',e.token_digest IS NOT NULL)
        FROM user_enrollments e WHERE e.user_id=app_users.id) enrollment
      FROM app_users ORDER BY login LIMIT 1001`)).rows;
    const grants=(await client.query('SELECT * FROM role_grants ORDER BY created_at DESC,id LIMIT 5001')).rows;
    const branches=(await client.query(`SELECT id,code,org_lifecycle_at(id,(now() AT TIME ZONE 'UTC')::date) lifecycle_state FROM org_directory_units
      WHERE kind='ORG_UNIT' AND NOT is_demo AND NOT demo_locked ORDER BY code LIMIT 1001`)).rows;
    if(users.length>1000||grants.length>5000||branches.length>1000) throw invalid('Справочник превышает размер этого выпуска. Нужна серверная пагинация.');
    const roles=(await client.query(`SELECT r.code,r.display_name,
      ARRAY(SELECT permission_code FROM role_permissions WHERE role_code=r.code ORDER BY permission_code) permissions
      FROM roles r WHERE scope_kind='ORG_UNIT' ORDER BY r.display_name`)).rows
      .filter(r=>r.permissions.length&&r.permissions.every((p:string)=>safePermissions.has(p)));
    return {users:users.map(({password_last_shared_indicator,...u})=>({...u,personal:!password_last_shared_indicator})),grants,branches,roles};
  });
}
export async function listAccessChanges(auth:AuthedUser) {
  return withTransaction(async client=>{
    await authorize(client,auth,'read');
    const rows=(await client.query('SELECT * FROM access_change_proposals ORDER BY updated_at DESC,id LIMIT 100')).rows;
    return {items:rows.map(publicProposal),limit:100};
  });
}
export async function getAccessChange(auth:AuthedUser,id:string) {
  return withTransaction(async client=>{
    await authorize(client,auth,'read');const p=await load(client,id);
    const history=(await client.query(`SELECT actor_user_id,action,aggregate_version,occurred_at FROM audit_log
      WHERE aggregate_type='access' AND aggregate_id=$1 ORDER BY aggregate_version`,[id])).rows;
    return {...publicProposal(p),history};
  });
}
export async function commandAccessChange(auth:AuthedUser,action:'create'|'preview'|'apply',id:string|null,
  raw:unknown,key:string|undefined,requestId:string) {
  return withTransaction(async client=>{
    await authorize(client,auth,action==='create'?'draft':action);
    await client.query('LOCK TABLE org_directory_units, work_items, access_change_proposals IN SHARE ROW EXCLUSIVE MODE');
    const body=object(raw,action==='create'?['change']:action==='preview'?['expected_version']:['expected_version','preview_token']);
    let p=id?await load(client,id):null;
    const change=action==='create'?parseChange(body.change):null;
    if(!key||!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw invalid('Требуется Idempotency-Key.');
    const operation=({create:'accessChangeCreate',preview:'accessChangePreview',apply:'accessChangeApply'} as const)[action];
    const idem=await beginIdempotent(client,auth.userId,operation,key,id,body);
    if('replay' in idem) return idem.replay.body;
    if(p&&(!Number.isSafeInteger(body.expected_version)||p.version!==body.expected_version||p.status==='APPLIED')) throw conflict();
    const before=p?publicProposal(p):null;
    if(action==='create') {
      p=(await client.query(`INSERT INTO access_change_proposals(target_id,created_by,updated_by,change)
        VALUES($1,$2,$2,$3) RETURNING *`,[change!.operation==='GRANT_ROLE'?randomUUID():change!.grant_id,auth.userId,change])).rows[0];
    } else {
      const {summary,hash}=await validate(client,p!,auth);
      if(action==='preview') {
        p=(await client.query(`UPDATE access_change_proposals SET version=version+1,status=$2,preview_summary=$3,
          preview_token=$4,preview_actor=$5,preview_hash=$6,preview_expires_at=now()+interval '15 minutes',
          updated_by=$5,updated_at=now() WHERE id=$1 RETURNING *`,
          [id,summary.valid?'PREVIEW':'DRAFT',summary,summary.valid?randomUUID():null,auth.userId,hash])).rows[0];
      } else {
        const time=(await client.query('SELECT now() now')).rows[0].now;
        if(p!.status!=='PREVIEW'||p!.preview_actor!==auth.userId||p!.preview_token!==body.preview_token||
          !p!.preview_expires_at||new Date(p!.preview_expires_at)<=time||!summary.valid||
          !p!.preview_hash||!Buffer.from(p!.preview_hash).equals(hash)) throw conflict();
        const c=p!.change as Change;
        if(c.operation==='GRANT_ROLE') await client.query(`INSERT INTO role_grants(id,user_id,role_code,org_unit_id,scope_kind,valid_from,valid_until)
          VALUES($1,$2,$3,$4,'ORG_UNIT',COALESCE($5::timestamptz,now()),$6)`,
          [p!.target_id,c.user_id,c.role_code,c.org_unit_id,c.valid_from==='NOW'?null:c.valid_from,c.valid_until]);
        else await client.query('UPDATE role_grants SET revoked_at=now(),grant_version=grant_version+1 WHERE id=$1',[c.grant_id]);
        const afterGrant=(await client.query('SELECT * FROM role_grants WHERE id=$1',[p!.target_id])).rows[0];
        p=(await client.query(`UPDATE access_change_proposals SET version=version+1,status='APPLIED',preview_token=NULL,
          applied_by=$2,applied_at=now(),updated_by=$2,updated_at=now(),preview_summary=$3 WHERE id=$1 RETURNING *`,
          [id,auth.userId,{...summary,after_grant:afterGrant}])).rows[0];
      }
    }
    const safe=(v:any)=>v?{...v,preview_token:undefined,preview_hash:undefined}:null;
    const result=publicProposal(p!);
    await writeAuditAndOutbox(client,{actorUserId:auth.userId,actorRole:null,orgUnitId:null,workItemId:null,
      action:`ACCESS_CHANGE_${action.toUpperCase()}`,aggregateType:'access',aggregateId:p!.id,aggregateVersion:p!.version,
      requestId,beforeState:safe(before),afterState:safe(result),reason:p!.change.reason,resolution:'APPLIED',
      retentionClass:'SECURITY_5Y',eventType:'access.change.recorded',
      payload:{proposal_id:p!.id,operation:p!.change.operation,status:p!.status,grant_id:p!.target_id}});
    await completeIdempotent(client,auth.userId,operation,key,200,result);
    return result;
  });
}
