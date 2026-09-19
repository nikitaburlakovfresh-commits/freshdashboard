import React,{useCallback,useEffect,useState} from 'react';
import { readSourceNaming,saveSourceAlias,saveSourceExclusion,revokeSourceExclusion,
  type SourceAliasRow,type SourceExclusionRow } from '../api/metrics';
import { getOrganizationTree } from '../api/organization';
import '../styles/branch-grid.css';

interface Unit { id:string; display_name:string; kind:string }
const today=()=>new Date().toISOString().slice(0,10);

/**
 * Названия филиалов в выгрузках QLIK отличаются от канонических названий сети
 * («Fresh Омск» — это «Омск Кольцевая»). Соответствия и исключения задаются
 * здесь, внутри портала: у каждой записи есть дата вступления в силу,
 * основание и история, поэтому прежние публикации не искажаются.
 */
export default function SourceNamingPage() {
  const [aliases,setAliases]=useState<SourceAliasRow[]|null>(null);
  const [exclusions,setExclusions]=useState<SourceExclusionRow[]>([]);
  const [branches,setBranches]=useState<Unit[]>([]);
  const [networkId,setNetworkId]=useState('');
  const [history,setHistory]=useState(false);
  const [alias,setAlias]=useState({org_unit_id:'',source_name:'',effective_from:today(),reason:''});
  const [excl,setExcl]=useState({source_name:'',effective_from:today(),reason:''});
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);

  const load=useCallback(async(withHistory:boolean)=>{
    setError('');
    try{const r=await readSourceNaming(withHistory);setAliases(r.aliases);setExclusions(r.exclusions);}
    catch(e:any){setAliases(null);setError(e.message);}
  },[]);
  useEffect(()=>{load(history);},[history,load]);
  useEffect(()=>{getOrganizationTree(today()).then(r=>{
    setBranches(r.items.filter(u=>u.kind==='ORG_UNIT'&&!u.is_demo)
      .map(u=>({id:u.id,display_name:u.display_name||u.code,kind:u.kind}))
      .sort((a,b)=>a.display_name.localeCompare(b.display_name,'ru')));
    setNetworkId(r.items.find(u=>u.kind==='NETWORK')?.id??'');
  }).catch(()=>{setBranches([]);setNetworkId('');});},[]);

  async function submitAlias(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      const r=await saveSourceAlias(alias);
      setNotice(`Название закреплено за филиалом и действует с ${r.effective_from}.`+
        (r.previous_id?' Прежняя запись закрыта этой датой и сохранена в истории.':''));
      setAlias({org_unit_id:alias.org_unit_id,source_name:'',effective_from:today(),reason:''});
      await load(history);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  async function submitExclusion(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      if(!networkId)throw new Error('Сеть не определена: обновите страницу.');
      const r=await saveSourceExclusion({...excl,network_id:networkId});
      setNotice(`Название «${r.source_name}» исключено из приёма: строки не публикуются и не создают филиал.`);
      setExcl({source_name:'',effective_from:today(),reason:''});
      await load(history);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  async function revoke(row:SourceExclusionRow) {
    const reason=window.prompt(`Основание отмены исключения «${row.source_name}» (16–500 символов)`)??'';
    if(reason.trim().length<16){setError('Отмена исключения требует основания не короче 16 символов.');return;}
    setBusy(true);setError('');setNotice('');
    try{await revokeSourceExclusion(row.id,reason.trim());
      setNotice(`Исключение «${row.source_name}» отменено. Запись сохранена в истории.`);
      await load(history);}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  }

  return <div className="portal-page">
    <h1>Названия филиалов в отчётах</h1>
    <p className="portal-muted">Настройка выполняется внутри портала без изменения кода. Приём сопоставляет
      строки выгрузок по этим названиям; исключённые названия не блокируют приём и не становятся филиалом.</p>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Закрепить название за филиалом</h2></div>
      <form className="threshold-form" onSubmit={submitAlias}>
        <label>Филиал сети
          <select required value={alias.org_unit_id}
            onChange={e=>setAlias(a=>({...a,org_unit_id:e.target.value}))}>
            <option value="">Выберите филиал</option>
            {branches.map(b=><option key={b.id} value={b.id}>{b.display_name}</option>)}
          </select>
        </label>
        <label>Название в выгрузке
          <input required minLength={2} maxLength={200} placeholder="Например: Fresh Омск"
            value={alias.source_name} onChange={e=>setAlias(a=>({...a,source_name:e.target.value}))}/>
        </label>
        <label>Действует с
          <input required type="date" value={alias.effective_from}
            onChange={e=>setAlias(a=>({...a,effective_from:e.target.value}))}/>
        </label>
        <label className="threshold-reason">Основание
          <textarea required minLength={16} maxLength={500} value={alias.reason}
            onChange={e=>setAlias(a=>({...a,reason:e.target.value}))}/>
        </label>
        <button className="btn" disabled={busy}>{busy?'Сохраняю…':'Закрепить название'}</button>
      </form>
      <p className="portal-muted">Одно название не может одновременно указывать на два филиала.
        Перенос названия закрывает прежнюю запись датой вступления в силу и сохраняет её в истории.</p>
    </section>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Исключить название из приёма</h2></div>
      <form className="threshold-form" onSubmit={submitExclusion}>
        <label>Название в выгрузке
          <input required minLength={2} maxLength={200} placeholder="Например: Fresh Смоленск"
            value={excl.source_name} onChange={e=>setExcl(x=>({...x,source_name:e.target.value}))}/>
        </label>
        <label>Действует с
          <input required type="date" value={excl.effective_from}
            onChange={e=>setExcl(x=>({...x,effective_from:e.target.value}))}/>
        </label>
        <label className="threshold-reason">Основание исключения
          <textarea required minLength={16} maxLength={500} value={excl.reason}
            placeholder="Например: филиал закрыт и не входит в управляемый контур сети"
            onChange={e=>setExcl(x=>({...x,reason:e.target.value}))}/>
        </label>
        <button className="btn" disabled={busy}>{busy?'Сохраняю…':'Исключить название'}</button>
      </form>
      {error&&<p role="alert">{error}</p>}
      {notice&&<p role="status">{notice}</p>}
    </section>

    <section className="portal-panel">
      <div className="portal-section-head">
        <h2>{history?'Все записи, включая закрытые':'Действующие записи'}</h2>
        <label className="fact-check"><input type="checkbox" checked={history}
          onChange={e=>setHistory(e.target.checked)}/> Показать историю</label>
      </div>
      {aliases===null&&!error&&<p>Загружаю настройки…</p>}
      {aliases?.length===0&&<p role="status">Названия ещё не закреплены: сопоставление идёт только
        по каноническим названиям филиалов.</p>}
      {aliases&&aliases.length>0&&<table className="threshold-table">
        <thead><tr><th>Название в выгрузке</th><th>Филиал</th><th>Действует с</th><th>Закрыто</th>
          <th>Основание</th></tr></thead>
        <tbody>{aliases.map(a=><tr key={a.id}>
          <td>{a.source_name}</td>
          <td>{a.display_name??a.code}</td>
          <td>{a.effective_from}</td>
          <td>{a.effective_to??'—'}</td>
          <td>{a.reason}</td>
        </tr>)}</tbody>
      </table>}

      <h3>Исключённые названия</h3>
      {exclusions.length===0&&<p role="status">Исключений нет.</p>}
      {exclusions.length>0&&<table className="threshold-table">
        <thead><tr><th>Название</th><th>Действует с</th><th>Отменено</th><th>Основание</th><th/></tr></thead>
        <tbody>{exclusions.map(x=><tr key={x.id}>
          <td>{x.source_name}</td>
          <td>{x.effective_from}</td>
          <td>{x.revoked_at?new Date(x.revoked_at).toLocaleString('ru-RU'):'—'}</td>
          <td>{x.reason}</td>
          <td>{!x.revoked_at&&<button className="btn btn-ghost" disabled={busy}
            onClick={()=>revoke(x)}>Отменить</button>}</td>
        </tr>)}</tbody>
      </table>}
    </section>
  </div>;
}
