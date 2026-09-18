import React,{useCallback,useEffect,useState} from 'react';
import { readThresholds,saveThreshold,type ThresholdRow,type ThresholdCommand } from '../api/metrics';
import { thresholdOrderValid } from '../components/metricThresholdModel';
import { getOrganizationTree } from '../api/organization';
import '../styles/branch-grid.css';

const DIRECTIONS:Record<string,string>={HIGHER_IS_BETTER:'Больше — лучше',LOWER_IS_BETTER:'Меньше — лучше'};
const BASES:Record<string,string>={ABSOLUTE:'Абсолютное значение',PLAN_PERCENT:'Процент исполнения плана'};
const UNITS:Record<string,string>={COUNT:'шт.',RUB:'руб.',PCT:'%'};

type FormState=Omit<ThresholdCommand,'green_from'|'amber_from'>&{green_from:string;amber_from:string};
const EMPTY:FormState={metric:'sales',scope_kind:'NETWORK',org_unit_id:null,direction:'HIGHER_IS_BETTER',
  basis:'ABSOLUTE',unit:'COUNT',green_from:'',amber_from:'',effective_from:'',reason:''};

/**
 * Пороги светофора настраиваются здесь, а не в коде. Каждая версия имеет дату
 * вступления в силу, основание и историю; прежние версии не перезаписываются,
 * поэтому историческая отчётность не искажается.
 */
export default function MetricThresholdsPage() {
  const [items,setItems]=useState<ThresholdRow[]|null>(null);
  const [names,setNames]=useState<Record<string,string>>({});
  const [branches,setBranches]=useState<{id:string;display_name:string}[]>([]);
  const [history,setHistory]=useState(false);
  const [form,setForm]=useState<FormState>(EMPTY);
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);

  const load=useCallback(async(withHistory:boolean)=>{
    setError('');
    try{const r=await readThresholds(withHistory);setItems(r.items);setNames(r.metric_names);}
    catch(e:any){setItems(null);setError(e.message);}
  },[]);
  useEffect(()=>{load(history);},[history,load]);
  useEffect(()=>{const today=new Date().toISOString().slice(0,10);
    getOrganizationTree(today).then(r=>setBranches(r.items.filter(u=>u.kind==='ORG_UNIT'&&!u.is_demo)
      .map(u=>({id:u.id,display_name:u.display_name||u.code})))).catch(()=>setBranches([]));},[]);

  async function submit(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      const body:ThresholdCommand={...form,green_from:Number(form.green_from),amber_from:Number(form.amber_from),
        org_unit_id:form.scope_kind==='ORG_UNIT'?form.org_unit_id:null};
      const r=await saveThreshold(body);
      setNotice(`Порог сохранён и действует с ${r.effective_from}.`+
        (r.previous_id?' Прежняя версия закрыта этой датой и сохранена в истории.':''));
      setForm({...EMPTY,metric:form.metric});
      await load(history);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  const set=(patch:Partial<FormState>)=>setForm(f=>({...f,...patch}));

  return <div className="portal-page">
    <h1>Пороги показателей</h1>
    <p className="portal-muted">Настройка выполняется внутри портала без изменения кода. Пороги действуют
      с указанной даты, ближайшая область (филиал) вытесняет сетевую настройку.</p>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Новая версия порога</h2></div>
      <form className="threshold-form" onSubmit={submit}>
        <label>Показатель
          <select value={form.metric} onChange={e=>set({metric:e.target.value})}>
            {Object.entries(names).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Область
          <select value={form.scope_kind} onChange={e=>set({scope_kind:e.target.value as 'NETWORK'|'ORG_UNIT',
            org_unit_id:null})}>
            <option value="NETWORK">Вся сеть</option>
            <option value="ORG_UNIT">Отдельный филиал</option>
          </select>
        </label>
        {form.scope_kind==='ORG_UNIT'&&<label>Филиал
          <select required value={form.org_unit_id??''} onChange={e=>set({org_unit_id:e.target.value||null})}>
            <option value="">Выберите филиал</option>
            {branches.map(b=><option key={b.id} value={b.id}>{b.display_name}</option>)}
          </select>
        </label>}
        <label>Направление
          <select value={form.direction} onChange={e=>set({direction:e.target.value as FormState['direction']})}>
            {Object.entries(DIRECTIONS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>База расчёта
          <select value={form.basis} onChange={e=>set({basis:e.target.value as FormState['basis'],
            unit:e.target.value==='PLAN_PERCENT'?'PCT':form.unit})}>
            {Object.entries(BASES).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Единица
          <select value={form.unit} disabled={form.basis==='PLAN_PERCENT'}
            onChange={e=>set({unit:e.target.value as FormState['unit']})}>
            {Object.entries(UNITS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Зелёный от<input required type="number" step="any" value={form.green_from}
          onChange={e=>set({green_from:e.target.value})}/></label>
        <label>Жёлтый от<input required type="number" step="any" value={form.amber_from}
          onChange={e=>set({amber_from:e.target.value})}/></label>
        <label>Действует с<input required type="date" value={form.effective_from}
          onChange={e=>set({effective_from:e.target.value})}/></label>
        <label className="threshold-reason">Основание изменения
          <textarea required minLength={16} maxLength={500} value={form.reason}
            onChange={e=>set({reason:e.target.value})}/></label>
        <button className="btn" disabled={busy}>{busy?'Сохраняю…':'Сохранить версию порога'}</button>
      </form>
      <p className="portal-muted">Зелёный порог должен быть строго лучше жёлтого по выбранному направлению.
        Дата вступления в силу должна быть позже действующей версии.</p>
      {error&&<p role="alert">{error}</p>}
      {notice&&<p role="status">{notice}</p>}
    </section>

    <section className="portal-panel">
      <div className="portal-section-head">
        <h2>{history?'Все версии порогов':'Действующие пороги'}</h2>
        <label className="fact-check"><input type="checkbox" checked={history}
          onChange={e=>setHistory(e.target.checked)}/> Показать историю</label>
      </div>
      {items===null&&!error&&<p>Загружаю настройки…</p>}
      {items?.length===0&&<p role="status">Пороги пока не настроены: статусы показателей не рассчитываются.</p>}
      {items&&items.length>0&&<table className="threshold-table">
        <thead><tr><th>Показатель</th><th>Область</th><th>Направление</th><th>База</th>
          <th className="tabnum">Зелёный</th><th className="tabnum">Жёлтый</th><th>Действует</th><th>Основание</th></tr></thead>
        <tbody>{items.map(t=><tr key={t.id}>
          <td>{names[t.metric]??t.metric}</td>
          <td>{t.scope_kind==='NETWORK'?'Вся сеть':(t.display_name??'Филиал')}</td>
          <td>{DIRECTIONS[t.direction]}</td>
          <td>{BASES[t.basis]} · {UNITS[t.unit]}</td>
          <td className="tabnum">{t.green_from}</td>
          <td className="tabnum">{t.amber_from}</td>
          <td>{t.effective_from} → {t.effective_to??'действует'}</td>
          <td>{t.reason}</td>
        </tr>)}</tbody>
      </table>}
    </section>
  </div>;
}
