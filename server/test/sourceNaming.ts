// Isolated real PostgreSQL suite. Only synthetic identities and branch names.
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { authed,login,Session } from './helpers';

let admin:Session,rf:Session,branch:string,otherBranch:string,network:string;
const base='/api/v1/metrics/source-naming';
const password=randomBytes(32).toString('base64url');
const reason='Synthetic approved source naming decision';

beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'naming_admin',fullName:'Администратор названий · тест',password,
    reason:'Synthetic isolated source naming administration',approvalReference:'SYNTHETIC_NAMING_APPROVAL'});
  expect(b.grantId).toBeTruthy();
  admin=await login('naming_admin',password);rf=await login('rf_a');
  branch=randomUUID();otherBranch=randomUUID();
  network=(await pool.query("SELECT id FROM org_directory_units WHERE kind='NETWORK' LIMIT 1")).rows[0].id;
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,'NAMING_ONE','ORG_UNIT','ACTIVE','2020-01-01'),($2,'NAMING_TWO','ORG_UNIT','ACTIVE','2020-01-01')`,
  [branch,otherBranch]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Филиал первый · тест','2020-01-01','Synthetic isolated naming fixture'),
      ($2,'Филиал второй · тест','2020-01-01','Synthetic isolated naming fixture')`,[branch,otherBranch]);
});
beforeEach(resetLimits);
afterAll(async()=>{resetLimits();await closePool();});

it('миграция не выдаёт право настройки никому',async()=>{
  expect((await pool.query("SELECT count(*)::int n FROM role_permissions WHERE permission_code='report.source_naming.manage'")).rows[0].n).toBe(0);
  expect((await authed(admin).get(base)).status).toBe(403);
  // Право выдаётся явно; дальнейшие проверки идут от выданного права.
  await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','report.source_naming.manage')");
  expect((await authed(admin).get(base)).status).toBe(200);
});

const setAlias=(patch:any={},s=admin)=>authed(s).post(`${base}/aliases`)
  .send({org_unit_id:branch,source_name:'Fresh Тестовое Название',effective_from:'2026-01-01',reason,...patch});
const exclude=(patch:any={},s=admin)=>authed(s).post(`${base}/exclusions`)
  .send({network_id:network,source_name:'Fresh Чужой Франчайзи',effective_from:'2026-01-01',reason,...patch});

describe('названия филиалов в источниках настраиваются внутри портала',()=>{
  it('псевдоним создаётся и виден в перечне',async()=>{
    const r=await setAlias();
    expect(r.status).toBe(201);
    expect(r.body.source_name).toBe('Fresh Тестовое Название');
    const list=await authed(admin).get(base);
    expect(list.status).toBe(200);
    const row=list.body.aliases.find((a:any)=>a.id===r.body.id);
    expect(row.org_unit_id).toBe(branch);
    // Нормализация убирает служебные слова и регистр.
    expect(row.source_name_norm).toBe('тестовое название');
  });

  it('перенос названия на другой филиал закрывает прежнюю запись датой',async()=>{
    const moved=await setAlias({org_unit_id:otherBranch,effective_from:'2026-03-01'});
    expect(moved.status).toBe(201);
    expect(moved.body.previous_id).toBeTruthy();
    const history=await authed(admin).get(`${base}?history=true`);
    const closed=history.body.aliases.find((a:any)=>a.id===moved.body.previous_id);
    expect(closed.effective_to).toBe('2026-03-01');
  });

  it('одно название не может указывать на два филиала одновременно',async()=>{
    const r=await setAlias({org_unit_id:branch,effective_from:'2026-02-01'});
    expect(r.status).toBe(422);
  });

  it('основание обязательно',async()=>{
    const r=await setAlias({source_name:'Fresh Прочее',reason:'коротко'});
    expect(r.status).toBe(422);
  });

  it('несуществующий филиал не принимается',async()=>{
    const r=await setAlias({org_unit_id:randomUUID(),source_name:'Fresh Ниоткуда',effective_from:'2026-04-01'});
    expect(r.status).toBe(404);
  });

  it('право на настройку требуется',async()=>{
    const r=await setAlias({source_name:'Fresh Без Прав'},rf);
    expect([403,404]).toContain(r.status);
    const list=await authed(rf).get(base);
    expect([403,404]).toContain(list.status);
  });
});

describe('исключения названий вне контура сети',()=>{
  it('название исключается с основанием и отменяется без удаления истории',async()=>{
    const created=await exclude();
    expect(created.status).toBe(201);
    const again=await exclude();
    expect(again.status).toBe(422);
    const revoked=await authed(admin).post(`${base}/exclusions/${created.body.id}/revoke`)
      .send({reason:'Synthetic approved exclusion revocation'});
    expect(revoked.status).toBe(200);
    const history=await authed(admin).get(`${base}?history=true`);
    const row=history.body.exclusions.find((e:any)=>e.id===created.body.id);
    expect(row.revoked_at).toBeTruthy();
    const list=await authed(admin).get(base);
    expect(list.body.exclusions.some((e:any)=>e.id===created.body.id)).toBe(false);
  });

  it('исключение и псевдоним не могут действовать для одного названия',async()=>{
    const ex=await exclude({source_name:'Fresh Конфликт'});
    expect(ex.status).toBe(201);
    const alias=await setAlias({source_name:'Fresh Конфликт',effective_from:'2026-05-01'});
    expect(alias.status).toBe(422);
  });
});
