import { randomBytes } from 'crypto';
import argon2 from 'argon2';
import { PoolClient } from 'pg';
import { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import { sha256 } from '../util/crypto';
import { authorizeNetworkPermissions } from './accessChanges';
import { beginIdempotent,completeIdempotent } from './idempotency';
import { writeAuditAndOutbox } from './auditOutbox';

const invalid=(text:string)=>new ApiError('VALIDATION_ERROR',text);
const conflict=()=>new ApiError('ENTITY_VERSION_CONFLICT','Состояние изменилось. Обновите справочник; повторный выпуск отменяет прежнюю ссылку.');
const unavailable=()=>new ApiError('INVALID_CREDENTIALS','Приглашение недействительно или истекло. Обратитесь к администратору.');
function object(raw:unknown,keys:string[]):Record<string,any> {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k))) throw invalid('Неизвестные поля запроса.');
  return raw as Record<string,any>;
}
function reason(value:unknown):string {
  if(typeof value!=='string'||value.trim().length<10||value.length>500) throw invalid('Основание: от 10 до 500 символов.');
  return value.trim();
}
async function audit(client:PoolClient,userId:string,version:number,actor:string|null,action:string,requestId:string,why:string) {
  await writeAuditAndOutbox(client,{actorUserId:actor,actorRole:null,orgUnitId:null,workItemId:null,
    action,aggregateType:'access',aggregateId:userId,aggregateVersion:version,requestId,
    beforeState:null,afterState:{user_id:userId,version,action},reason:why,resolution:'APPLIED',
    retentionClass:'SECURITY_5Y',eventType:'user.enrollment.recorded',payload:{user_id:userId,version,action}});
}
export async function createPersonalUser(auth:AuthedUser,raw:unknown,key:string|undefined,requestId:string) {
  const b=object(raw,['login','full_name','primary_email','reason']);
  if(typeof b.login!=='string'||!/^[a-z][a-z0-9._-]{2,79}$/.test(b.login)) throw invalid('Логин: 3–80 строчных латинских букв, цифр, точек, дефисов или подчёркиваний.');
  if(typeof b.full_name!=='string'||b.full_name.trim().length<2||b.full_name.length>200||/[\u0000-\u001f\u007f]/.test(b.full_name))
    throw invalid('Укажите ФИО: от 2 до 200 символов.');
  if(typeof b.primary_email!=='string'||b.primary_email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.primary_email.trim()))
    throw invalid('Укажите персональную рабочую почту.');
  const data={login:b.login,full_name:b.full_name.trim(),primary_email:b.primary_email.trim().toLowerCase(),reason:reason(b.reason)};
  if(!key||!/^[A-Za-z0-9._:-]{16,128}$/.test(key)) throw invalid('Требуется Idempotency-Key.');
  return withTransaction(async client=>{
    await authorizeNetworkPermissions(client,auth,['access.directory.read','user.create']);
    const idem=await beginIdempotent(client,auth.userId,'userCreate',key,null,data);
    if('replay' in idem)return idem.replay.body;
    if((await client.query('SELECT 1 FROM app_users WHERE lower(login)=$1 OR lower(primary_email)=$2',[data.login,data.primary_email])).rowCount)
      throw new ApiError('ENTITY_VERSION_CONFLICT','Логин или почта уже используются. Проверьте существующую карточку; дубликат не создан.');
    // Unknown high-entropy password, never disclosed. Pending accounts cannot log in.
    const hash=await argon2.hash(randomBytes(32),{type:argon2.argon2id});
    const user=(await client.query(`INSERT INTO app_users(login,full_name,primary_email,password_hash,password_hash_updated_at,is_active)
      VALUES($1,$2,$3,$4,now(),false) RETURNING id,login,full_name,primary_email,is_active,user_kind`,
      [data.login,data.full_name,data.primary_email,hash])).rows[0];
    await client.query('INSERT INTO user_enrollments(user_id,created_by) VALUES($1,$2)',[user.id,auth.userId]);
    await audit(client,user.id,1,auth.userId,'PERSONAL_USER_CREATED',requestId,data.reason);
    const result={...user,enrollment:{version:1,expires_at:null,completed_at:null,has_invitation:false}};
    await completeIdempotent(client,auth.userId,'userCreate',key,201,result);
    return result;
  });
}
export async function manageInvitation(auth:AuthedUser,id:string,action:'issue'|'revoke',raw:unknown,requestId:string) {
  const b=object(raw,['expected_version','reason']),why=reason(b.reason);
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||!Number.isSafeInteger(b.expected_version)||b.expected_version<1) throw invalid('Нужны пользователь и текущая версия.');
  return withTransaction(async client=>{
    await authorizeNetworkPermissions(client,auth,['access.directory.read','user.enrollment.manage']);
    const row=(await client.query(`SELECT e.*,u.is_active,u.user_kind,u.password_last_shared_indicator
      FROM user_enrollments e JOIN app_users u ON u.id=e.user_id WHERE e.user_id=$1 FOR UPDATE`,[id])).rows[0];
    if(!row||row.completed_at||row.is_active||row.user_kind!=='INDIVIDUAL'||row.password_last_shared_indicator||
      Number(row.version)!==b.expected_version) throw conflict();
    if((await client.query('SELECT 1 FROM role_grants WHERE user_id=$1 UNION ALL SELECT 1 FROM sessions WHERE user_id=$1',[id])).rowCount) throw conflict();
    const token=action==='issue'?randomBytes(32).toString('base64url'):null;
    const e=(await client.query(`UPDATE user_enrollments SET version=version+1,token_digest=$2,
      expires_at=CASE WHEN $2::bytea IS NULL THEN NULL ELSE clock_timestamp()+interval '72 hours' END
      WHERE user_id=$1 RETURNING version,expires_at,completed_at,token_digest IS NOT NULL AS has_invitation`,[id,token?sha256(token):null])).rows[0];
    await audit(client,id,Number(e.version),auth.userId,action==='issue'?'ENROLLMENT_ISSUED':'ENROLLMENT_REVOKED',requestId,why);
    // Secret returned ONCE after commit, never put in audit, outbox or idempotency.
    // A lost response requires an explicit reissue with the new version.
    return {user_id:id,enrollment:{...e,version:Number(e.version)},...(token?{token}:{}),delivery:'MANUAL_NOT_SENT'};
  });
}
export async function acceptInvitation(raw:unknown,requestId:string) {
  const b=object(raw,['token','password']);
  if(typeof b.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.token))throw unavailable();
  if(typeof b.password!=='string'||b.password.length<14||b.password.length>200||b.password.trim().length<14)
    throw invalid('Пароль: от 14 до 200 символов. Используйте уникальную длинную фразу.');
  return withTransaction(async client=>{
    // Same lock order as administrator commands, no enrollment->user inversion.
    await client.query('LOCK TABLE app_users, sessions, role_grants, roles, role_permissions IN SHARE ROW EXCLUSIVE MODE');
    const e=(await client.query(`SELECT e.*,u.is_active,u.user_kind,u.password_last_shared_indicator
      FROM user_enrollments e JOIN app_users u ON u.id=e.user_id
      WHERE e.token_digest=$1 AND e.expires_at>clock_timestamp() FOR UPDATE`,[sha256(b.token)])).rows[0];
    if(!e||e.completed_at||e.is_active||e.user_kind!=='INDIVIDUAL'||e.password_last_shared_indicator)throw unavailable();
    if((await client.query('SELECT 1 FROM role_grants WHERE user_id=$1 UNION ALL SELECT 1 FROM sessions WHERE user_id=$1',[e.user_id])).rowCount)throw unavailable();
    const hash=await argon2.hash(b.password,{type:argon2.argon2id});
    const updated=await client.query(`UPDATE user_enrollments SET version=version+1,token_digest=NULL,expires_at=NULL,
      completed_at=clock_timestamp() WHERE user_id=$1 AND expires_at>clock_timestamp() RETURNING version`,[e.user_id]);
    if(!updated.rowCount)throw unavailable();
    await client.query('UPDATE app_users SET password_hash=$2,password_hash_updated_at=clock_timestamp(),auth_epoch=auth_epoch+1,is_active=true WHERE id=$1',[e.user_id,hash]);
    await audit(client,e.user_id,Number(updated.rows[0].version),e.user_id,'ENROLLMENT_COMPLETED',requestId,'Самостоятельная установка первого пароля по одноразовому приглашению');
    return {activated:true,next:'LOGIN_THEN_EXPLICIT_ASSIGNMENT'};
  });
}
