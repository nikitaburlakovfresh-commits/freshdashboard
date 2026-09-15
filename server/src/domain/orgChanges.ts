import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';
import { canonicalJsonHash } from '../util/crypto';
import { parseDirectoryDate } from './orgDirectory';
import { beginIdempotent, completeIdempotent, IdempotentOperation } from './idempotency';
import { writeAuditAndOutbox } from './auditOutbox';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const operationPermissions: Record<string,string> = {
  ORG_UNIT_CREATE:'org_unit.create',ORG_UNIT_RENAME:'org_unit.rename',ORG_UNIT_MOVE_TO_CLUSTER:'org_unit.move',
};
type Change = Record<string, any>;
type Proposal = Record<string, any>;
const invalid = (message: string) => new ApiError('VALIDATION_ERROR',message);
const conflict = () => new ApiError('ENTITY_VERSION_CONFLICT','Версия или проверка устарела. Откройте черновик заново и повторите проверку.');

async function access(client:PoolClient,auth:AuthedUser,permission:string) {
  // Serialize authorization with any grant/catalog/session revocation writer.
  // Locks are short and held only through this bounded transaction; no role bypass.
  await client.query('LOCK TABLE app_users, sessions, role_grants, roles, role_permissions IN SHARE MODE');
  const result=await client.query(`SELECT DISTINCT rp.permission_code FROM role_grants g
    JOIN roles r ON r.code=g.role_code AND r.scope_kind=g.scope_kind
    JOIN role_permissions rp ON rp.role_code=r.code
    JOIN app_users u ON u.id=g.user_id JOIN sessions s ON s.user_id=u.id
    WHERE u.id=$1 AND s.id=$2 AND u.is_active AND u.user_kind='INDIVIDUAL'
      AND NOT u.password_last_shared_indicator AND s.revoked_at IS NULL
      AND s.captured_auth_epoch=u.auth_epoch AND u.password_hash_updated_at<=s.created_at
      AND s.expires_at>now() AND s.created_at>now()-interval '8 hours'
      AND s.last_seen_at>now()-interval '30 minutes'
      AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
      AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_until IS NULL OR now()<g.valid_until)`,
    [auth.userId,auth.sessionId]);
  const permissions=new Set<string>(result.rows.map(row=>row.permission_code));
  if(!permissions.has('organization.directory.review') || !permissions.has(permission)) {
    throw new ApiError('FORBIDDEN','Требуются отдельное право редактора и действующее назначение NETWORK.');
  }
  return permissions;
}
function object(raw:unknown,keys:string[]):Record<string,any> {
  if(!raw || typeof raw!=='object' || Array.isArray(raw) || Object.keys(raw).some(k=>!keys.includes(k))) throw invalid('Неизвестные или недопустимые поля команды.');
  return raw as Record<string,any>;
}
function changeSchema(raw:unknown):Change {
  const c=object(raw,['operation','target_id','code','kind','display_name','parent_id','type_code','business_model','effective_from','reason']);
  if(!Object.prototype.hasOwnProperty.call(operationPermissions,c.operation)) throw invalid('Поддерживаются только создание, переименование и перенос справочника.');
  for(const [k,v] of Object.entries(c)) {
    if(v!==null && typeof v!=='string') throw invalid(`Поле ${k}: требуется строка.`);
    if(typeof v==='string' && v.length>500) throw invalid(`Поле ${k}: превышена длина.`);
  }
  if(c.operation!=='ORG_UNIT_CREATE' && (typeof c.target_id!=='string' || !uuid.test(c.target_id))) throw invalid('Выберите стабильный OrgUnit.');
  if(c.operation==='ORG_UNIT_CREATE' && c.target_id!==undefined) throw invalid('UUID новой единицы назначается сервером.');
  const allowed=c.operation==='ORG_UNIT_CREATE'
    ? ['operation','code','kind','display_name','parent_id','type_code','business_model','effective_from','reason']
    : ['operation','target_id','effective_from','reason',c.operation==='ORG_UNIT_RENAME'?'display_name':'parent_id'];
  if(Object.keys(c).some(k=>!allowed.includes(k))) throw invalid('Эти поля недоступны для выбранного изменения.');
  return c;
}
function checkOperation(permissions:Set<string>,c:Change) {
  if(!permissions.has(operationPermissions[c.operation])) throw new ApiError('FORBIDDEN','Нет отдельного права на эту операцию OrgUnit.');
}
async function load(client:PoolClient,id:string) {
  if(!uuid.test(id)) throw new ApiError('NOT_FOUND','Предложение не найдено.');
  const r=await client.query('SELECT * FROM org_change_proposals WHERE id=$1 FOR UPDATE',[id]);
  if(!r.rowCount) throw new ApiError('NOT_FOUND','Предложение не найдено.');
  return r.rows[0] as Proposal;
}
function publicProposal(p:Proposal) {
  const {preview_hash, ...result}=p;
  return result;
}
async function directorySnapshot(client:PoolClient,id:string) {
  const r=await client.query(`SELECT d.id,d.code,d.kind,d.type_code,d.lifecycle_state,d.is_demo,d.demo_locked,
    d.pilot_org_unit_id,to_char(d.effective_from,'YYYY-MM-DD') effective_from,to_char(d.effective_to,'YYYY-MM-DD') effective_to,
    (SELECT jsonb_agg(jsonb_build_object('display_name',n.display_name,'effective_from',to_char(n.effective_from,'YYYY-MM-DD'),
      'effective_to',to_char(n.effective_to,'YYYY-MM-DD')) ORDER BY n.effective_from) FROM org_directory_name_history n WHERE n.org_unit_id=d.id) names,
    (SELECT jsonb_agg(jsonb_build_object('parent_id',a.parent_id,'business_model',a.business_model,'effective_from',to_char(a.effective_from,'YYYY-MM-DD'),
      'effective_to',to_char(a.effective_to,'YYYY-MM-DD')) ORDER BY a.effective_from) FROM org_directory_affiliation_history a WHERE a.org_unit_id=d.id) affiliations
    FROM org_directory_units d WHERE d.id=$1`,[id]);
  return r.rows[0] ?? null;
}
async function validate(client:PoolClient,p:Proposal) {
  const c=p.change as Change, issues:{path:string;issue:string}[]=[];
  const issue=(path:string,text:string)=>issues.push({path,issue:text});
  let date:string|undefined;
  try { if(!c.effective_from) throw Error(); date=parseDirectoryDate(c.effective_from); }
  catch { issue('effective_from','Требуется существующая дата YYYY-MM-DD.'); }
  const today=(await client.query("SELECT to_char(CURRENT_DATE,'YYYY-MM-DD') today")).rows[0].today;
  if(date && date<today) issue('effective_from','Изменения задним числом не входят в этот этап.');
  if(!c.reason?.trim()) issue('reason','Укажите основание изменения.');
  if(c.operation!=='ORG_UNIT_MOVE_TO_CLUSTER' && (!c.display_name?.trim() || c.display_name.length>200)) issue('display_name','Укажите название длиной до 200 символов.');
  const before=await directorySnapshot(client,p.target_id);
  let kind=c.kind, parentId=c.parent_id;
  if(c.operation==='ORG_UNIT_CREATE') {
    if(before) issue('target_id','UUID уже занят.');
    if(!c.code || !/^[A-Za-z0-9_-]{1,100}$/.test(c.code)) issue('code','Код: латинские буквы, цифры, _ или -, до 100 символов.');
    else if((await client.query('SELECT 1 FROM org_directory_units WHERE lower(code)=lower($1)',[c.code])).rowCount) issue('code','Код уже существует.');
    if(!['NETWORK','DIVISION','CLUSTER','ORG_UNIT'].includes(kind)) issue('kind','Выберите допустимый уровень иерархии.');
    if(c.type_code && !['CITY_FLAG','EXPRESS','FULL_SERVICE','PICKUP_POINT','OUTLET'].includes(c.type_code)) issue('type_code','Недопустимый тип филиала.');
    if(kind!=='ORG_UNIT' && c.type_code) issue('type_code','Тип филиала допустим только для ORG_UNIT.');
    if(c.business_model && !['FRANCHISE','OWN_OPERATION','UC'].includes(c.business_model)) issue('business_model','Недопустимая бизнес-модель.');
  } else {
    if(!before) issue('target_id','Единица не найдена.');
    else {
      kind=before.kind;
      const originated=await client.query("SELECT 1 FROM org_change_proposals WHERE target_id=$1 AND status='APPLIED' AND change->>'operation'='ORG_UNIT_CREATE'",[p.target_id]);
      if(before.is_demo || before.demo_locked || before.pilot_org_unit_id || before.lifecycle_state!=='PRE_LAUNCH' || !originated.rowCount)
        issue('target_id','Изменять можно только созданные редактором единицы до запуска. Пилот A/B и импорт защищены.');
      if(c.operation==='ORG_UNIT_RENAME') {
        const last=before.names?.at(-1);
        if(!last || last.effective_to || (date && date<=last.effective_from)) issue('effective_from','Новая дата должна быть позже начала последнего открытого имени; пересечение запрещено.');
        if(last?.display_name===c.display_name?.trim()) issue('display_name','Название не изменилось.');
      } else {
        const last=before.affiliations?.at(-1);
        if(!last || last.effective_to || (date && date<=last.effective_from)) issue('effective_from','Новая дата должна быть позже начала последней открытой принадлежности.');
        if(last?.parent_id===(parentId || null)) issue('parent_id','Родитель не изменился.');
      }
    }
  }
  if(c.operation!=='ORG_UNIT_RENAME') {
    if(kind==='NETWORK' && parentId) issue('parent_id','Сеть должна быть корнем без родителя.');
    if(kind!=='NETWORK' && !parentId) issue('parent_id','Подтвердите родителя: создание сироты запрещено.');
    if(parentId && !uuid.test(parentId)) issue('parent_id','Некорректный UUID родителя.');
    if(parentId && uuid.test(parentId) && date) {
      // Check the entire future chain, not just its current edge. For this bounded
      // stage every parent must have an open-ended, gap-free affiliation path.
      const walk=async(id:string,childKind:string,start:string,seen:Set<string>):Promise<void>=>{
        if(seen.has(id)) { issue('parent_id','Цикл иерархии запрещён.'); return; }
        const parent=await directorySnapshot(client,id);
        if(!parent || parent.is_demo || parent.demo_locked || parent.effective_from>start || parent.effective_to) {
          issue('parent_id','Родитель должен быть реальной единицей и покрывать весь будущий интервал.'); return;
        }
        if(!({DIVISION:['NETWORK'],CLUSTER:['DIVISION'],ORG_UNIT:['NETWORK','DIVISION','CLUSTER']} as Record<string,string[]>)[childKind]?.includes(parent.kind)) {
          issue('parent_id','Нарушен уровень иерархии.'); return;
        }
        const links=(parent.affiliations ?? []).filter((a:any)=>!a.effective_to || a.effective_to>start);
        if(!links.length || links[0].effective_from>start || links.at(-1).effective_to) {
          issue('parent_id','Принадлежность родителя не покрывает интервал.'); return;
        }
        for(let i=0;i<links.length;i++) {
          const a=links[i];
          if(i && links[i-1].effective_to!==a.effective_from) issue('parent_id','Разрыв истории принадлежности родителя.');
          if(parent.kind==='NETWORK') {
            if(a.parent_id) issue('parent_id','У корня не может быть родителя.');
          } else if(!a.parent_id) issue('parent_id','В цепочке родителей обнаружена сирота.');
          else await walk(a.parent_id,parent.kind,a.effective_from>start?a.effective_from:start,new Set([...seen,id]));
        }
      };
      await walk(parentId,kind,date,new Set([p.target_id]));
    }
  }
  const descendants=before ? (await client.query(`WITH RECURSIVE children AS (
    SELECT org_unit_id FROM org_directory_affiliation_history WHERE parent_id=$1
    UNION SELECT a.org_unit_id FROM org_directory_affiliation_history a JOIN children c ON a.parent_id=c.org_unit_id)
    SELECT count(*)::int n FROM children`,[p.target_id])).rows[0].n : 0;
  return {valid:issues.length===0,issues,target_id:p.target_id,operation:c.operation,
    effective_from:c.effective_from ?? null,before,
    proposed:{...c,target_id:p.target_id,...(c.operation==='ORG_UNIT_CREATE'?{lifecycle_state:'PRE_LAUNCH'}:{})},
    affected:{directory_units:c.operation==='ORG_UNIT_CREATE'?1:0,name_history:c.operation==='ORG_UNIT_MOVE_TO_CLUSTER'?0:1,
      affiliation_history:c.operation==='ORG_UNIT_RENAME'?0:1,descendant_units:descendants,
      work_items:0,role_grants:0,historical_access_grants:0,financial_records:0},
    warning:'Только справочник. Задачи, роли, импорт, метрики, финансы и запуск не изменяются. Применение необратимо; исправление — новым предложением.'};
}

export async function listOrgChanges(auth:AuthedUser) {
  return withTransaction(async client=>{
    const permissions=await access(client,auth,'organization.change.draft');
    const rows=await client.query(`SELECT * FROM org_change_proposals ORDER BY updated_at DESC,id LIMIT 100`);
    return {items:rows.rows.filter(p=>permissions.has(operationPermissions[p.change.operation])).map(publicProposal),limit:100};
  });
}
export async function getOrgChange(auth:AuthedUser,id:string) {
  return withTransaction(async client=>{
    const permissions=await access(client,auth,'organization.change.draft');
    const p=await load(client,id); checkOperation(permissions,p.change);
    const history=await client.query(`SELECT actor_user_id,action,aggregate_version,occurred_at,before_state,after_state
      FROM audit_log WHERE aggregate_type='org_change' AND aggregate_id=$1 ORDER BY aggregate_version`,[id]);
    return {...publicProposal(p),history:history.rows};
  });
}
export async function commandOrgChange(auth:AuthedUser,action:'create'|'edit'|'preview'|'apply',id:string|null,raw:unknown,key:string|undefined,requestId:string) {
  return withTransaction(async client=>{
    const phase=action==='create'||action==='edit'?'draft':action;
    const permissions=await access(client,auth,`organization.change.${phase}`);
    // Prevent all external directory writers racing validation, and serialize
    // graph mutations before acquiring proposal locks (consistent lock order).
    await client.query('LOCK TABLE org_directory_units, org_directory_name_history, org_directory_affiliation_history, org_change_proposals IN SHARE ROW EXCLUSIVE MODE');
    let p=id ? await load(client,id) : null;
    if(p) checkOperation(permissions,p.change);
    const body=object(raw,action==='create'?['change']:action==='edit'?['change','expected_version']:action==='preview'?['expected_version']:['expected_version','preview_token']);
    let change:Change|undefined;
    if(action==='create'||action==='edit') { change=changeSchema(body.change); checkOperation(permissions,change); }
    if(!key || !/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw invalid('Требуется корректный Idempotency-Key.');
    const operation=({create:'orgChangeCreate',edit:'orgChangeEdit',preview:'orgChangePreview',apply:'orgChangeApply'} as const)[action] as IdempotentOperation;
    const idem=await beginIdempotent(client,auth.userId,operation,key,id,body);
    if('replay' in idem) return idem.replay.body;
    if(p && (!Number.isSafeInteger(body.expected_version) || p.version!==body.expected_version || p.status==='APPLIED')) throw conflict();
    const before=p ? publicProposal(p) : null;
    if(action==='create') {
      const r=await client.query(`INSERT INTO org_change_proposals(target_id,created_by,updated_by,change)
        VALUES($1,$2,$2,$3) RETURNING *`,[change!.target_id ?? randomUUID(),auth.userId,change]);
      p=r.rows[0];
    } else if(action==='edit') {
      if(change!.operation!==p!.change.operation || (change!.target_id && change!.target_id!==p!.target_id)) throw invalid('Операция и целевой UUID неизменны; создайте новое предложение.');
      p=(await client.query(`UPDATE org_change_proposals SET change=$2,version=version+1,status='DRAFT',
        preview_summary=NULL,preview_token=NULL,preview_actor=NULL,preview_hash=NULL,preview_base_version=NULL,preview_expires_at=NULL,
        updated_by=$3,updated_at=now() WHERE id=$1 RETURNING *`,[id,change,auth.userId])).rows[0];
    } else if(action==='preview') {
      const summary=await validate(client,p!);
      const rev=(await client.query('SELECT version FROM org_directory_revision')).rows[0].version;
      p=(await client.query(`UPDATE org_change_proposals SET version=version+1,status=$2,preview_summary=$3,
        preview_token=$4,preview_actor=$5,preview_hash=$6,preview_base_version=$7,preview_expires_at=now()+interval '15 minutes',
        updated_by=$5,updated_at=now() WHERE id=$1 RETURNING *`,[id,summary.valid?'PREVIEW':'DRAFT',summary,
        summary.valid?randomUUID():null,auth.userId,canonicalJsonHash(p!.change),rev])).rows[0];
    } else {
      const rev=(await client.query('SELECT version,now() now FROM org_directory_revision')).rows[0];
      if(p!.status!=='PREVIEW' || p!.preview_token!==body.preview_token || p!.preview_actor!==auth.userId ||
        new Date(p!.preview_expires_at)<=new Date(rev.now) || p!.preview_base_version!==rev.version ||
        !Buffer.from(p!.preview_hash).equals(canonicalJsonHash(p!.change))) throw conflict();
      const summary=await validate(client,p!);
      if(!summary.valid) throw new ApiError('VALIDATION_ERROR','Проверка больше не проходит.',{issues:summary.issues});
      const c=p!.change,date=c.effective_from,target=p!.target_id;
      if(c.operation==='ORG_UNIT_CREATE') {
        await client.query(`INSERT INTO org_directory_units(id,code,kind,type_code,lifecycle_state,effective_from)
          VALUES($1,$2,$3,$4,'PRE_LAUNCH',$5)`,[target,c.code,c.kind,c.type_code || null,date]);
        await client.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
          VALUES($1,$2,$3,$4)`,[target,c.display_name.trim(),date,c.reason.trim()]);
        await client.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,business_model,effective_from,change_reason)
          VALUES($1,$2,$3,$4,$5)`,[target,c.parent_id || null,c.business_model || null,date,c.reason.trim()]);
      } else if(c.operation==='ORG_UNIT_RENAME') {
        await client.query('UPDATE org_directory_name_history SET effective_to=$2 WHERE org_unit_id=$1 AND effective_to IS NULL',[target,date]);
        await client.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
          VALUES($1,$2,$3,$4)`,[target,c.display_name.trim(),date,c.reason.trim()]);
      } else {
        const old=(await client.query('SELECT * FROM org_directory_affiliation_history WHERE org_unit_id=$1 AND effective_to IS NULL',[target])).rows[0];
        await client.query('UPDATE org_directory_affiliation_history SET effective_to=$2 WHERE org_unit_id=$1 AND effective_to IS NULL',[target,date]);
        await client.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,business_model,effective_from,change_reason)
          VALUES($1,$2,$3,$4,$5)`,[target,c.parent_id,old.business_model,date,c.reason.trim()]);
      }
      p=(await client.query(`UPDATE org_change_proposals SET version=version+1,status='APPLIED',preview_token=NULL,
        applied_by=$2,applied_at=now(),updated_by=$2,updated_at=now(),preview_summary=$3 WHERE id=$1 RETURNING *`,
        [id,auth.userId,{...summary,after:await directorySnapshot(client,target)}])).rows[0];
    }
    const result=publicProposal(p!);
    // Audit records change-set transitions, not fabricated human approvals.
    // Preview capabilities/hashes stay out of audit/outbox payloads.
    const safe=(value:any)=>value ? {...value,preview_token:undefined,preview_hash:undefined}:null;
    await writeAuditAndOutbox(client,{
      actorUserId:auth.userId,actorRole:null,orgUnitId:null,workItemId:null,action:`ORG_CHANGE_${action.toUpperCase()}`,
      aggregateType:'org_change',aggregateId:p!.id,aggregateVersion:p!.version,requestId,
      beforeState:safe(before),afterState:safe(result),reason:p!.change.reason?.trim() || null,resolution:'APPLIED',
      retentionClass:'SECURITY_5Y',eventType:'organization.change.recorded',
      payload:{proposal_id:p!.id,status:p!.status,operation:p!.change.operation,target_id:p!.target_id},
    });
    await completeIdempotent(client,auth.userId,operation,key,200,result);
    return result;
  });
}
