import React,{useCallback,useEffect,useState} from 'react';
import { readFocusCatalog,saveFocusConfiguration,type FocusCatalogRow,
  type FocusConfigurationRow } from '../api/metrics';
import '../styles/branch-grid.css';
import '../styles/network-score.css';

/**
 * Фокусы внимания месяца настраиваются внутри портала: ровно пять слотов,
 * показатель выбирается из каталога фокусов, план задаётся вручную. План не
 * подставляется по умолчанию и отсутствие плана не равно нулю.
 */
const FORMATS:Record<string,string>={COUNT:'шт.',PCT:'%',RUB:'руб.',RUB_MLN:'млн руб.'};
const monthStart=()=>`${new Date().toISOString().slice(0,7)}-01`;
type SlotForm={metric_code:string;plan:string};

export default function FocusConfigPage() {
  const [month,setMonth]=useState(monthStart());
  const [catalog,setCatalog]=useState<FocusCatalogRow[]>([]);
  const [configurations,setConfigurations]=useState<FocusConfigurationRow[]>([]);
  const [slotCount,setSlotCount]=useState(5);
  const [history,setHistory]=useState(false);
  const [slots,setSlots]=useState<SlotForm[]>(Array.from({length:5},()=>({metric_code:'',plan:''})));
  const [effective,setEffective]=useState(''),[reason,setReason]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [loaded,setLoaded]=useState(false);

  const load=useCallback(async(m:string,withHistory:boolean)=>{
    setError('');setLoaded(false);
    try{
      const r=await readFocusCatalog(m,withHistory);
      setCatalog(r.catalog);setConfigurations(r.configurations);setSlotCount(r.slot_count);
      setSlots(prev=>prev.length===r.slot_count?prev
        :Array.from({length:r.slot_count},(_,i)=>prev[i]??{metric_code:'',plan:''}));
      setLoaded(true);
    }catch(e:any){setError(e.message);}
  },[]);
  useEffect(()=>{void load(month,history);},[month,history,load]);

  const current=configurations.find(c=>c.effective_to===null&&c.month===month)??null;
  const labels=Object.fromEntries(catalog.map(c=>[c.code,c.label]));

  function prefill() {
    if(!current)return;
    const next=Array.from({length:slotCount},(_,i)=>{
      const s=current.slots.find(x=>x.slot===i+1);
      return {metric_code:s?.metric_code??'',plan:s?.plan===null||s?.plan===undefined?'':String(s.plan)};
    });
    setSlots(next);
    setNotice('Форма заполнена действующей версией фокусов этого месяца.');
  }

  async function submit(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      const r=await saveFocusConfiguration({month,effective_from:effective,reason,
        slots:slots.map((s,i)=>({slot:i+1,metric_code:s.metric_code,
          plan:s.plan.trim()===''?null:Number(s.plan)}))});
      setNotice(`Фокусы месяца ${r.month} сохранены и действуют с ${r.effective_from}.`+
        (r.previous_id?' Прежняя версия закрыта этой датой и сохранена в истории.':''));
      setReason('');
      await load(month,history);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  const set=(i:number,patch:Partial<SlotForm>)=>
    setSlots(list=>list.map((s,idx)=>idx===i?{...s,...patch}:s));

  return <div className="portal-page network-kpi">
    <h1>Фокусы внимания месяца</h1>
    <p className="portal-muted">Пять фокусов на месяц выбираются из каталога и настраиваются внутри портала.
      Версии историчны: изменение фокусов не переписывает прошедшие месяцы.</p>

    <section className="portal-panel beta-filters">
      <label>Месяц фокусов<input aria-label="Месяц фокусов" type="month" value={month.slice(0,7)}
        onChange={e=>{if(e.target.value)setMonth(`${e.target.value}-01`);}}/></label>
      <label className="fact-check"><input type="checkbox" checked={history}
        onChange={e=>setHistory(e.target.checked)}/> Показать историю версий</label>
      {current&&<button type="button" className="btn" onClick={prefill}>Заполнить действующей версией</button>}
    </section>

    {error&&<p role="alert" className="portal-panel">{error}</p>}

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Действующие фокусы на {month}</h2></div>
      {!loaded&&!error&&<p>Загружаю каталог фокусов…</p>}
      {loaded&&!current&&<p role="status">На этот месяц фокусы не настроены: в обзоре сети блок фокусов
        останется пустым.</p>}
      {current&&<table className="score-table">
        <thead><tr><th>Слот</th><th>Показатель</th><th className="tabnum">План</th></tr></thead>
        <tbody>{current.slots.map(s=><tr key={s.slot}>
          <td>Фокус {s.slot}</td>
          <td>{labels[s.metric_code]??s.metric_code}</td>
          <td className="tabnum">{s.plan===null||s.plan===undefined?'не задан':String(s.plan)}</td>
        </tr>)}</tbody>
      </table>}
    </section>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Новая версия фокусов</h2></div>
      <form onSubmit={submit}>
        {slots.map((s,i)=><div className="threshold-form score-weight" key={i}>
          <label>Фокус {i+1}
            <select required value={s.metric_code} onChange={e=>set(i,{metric_code:e.target.value})}>
              <option value="">Выберите показатель фокуса</option>
              {catalog.map(c=><option key={c.code} value={c.code}>{c.label}</option>)}
            </select></label>
          <label>План{s.metric_code&&` (${FORMATS[catalog.find(c=>c.code===s.metric_code)?.format??'']??''})`}
            <input type="number" step="any" min="0" value={s.plan} placeholder="не задан"
              onChange={e=>set(i,{plan:e.target.value})}/></label>
          <span className="portal-muted">{(()=>{
            const c=catalog.find(x=>x.code===s.metric_code);
            if(!c)return 'Показатель из каталога фокусов.';
            const need=[c.requires_vin_level&&'VIN-уровень',c.requires_daily_logs&&'ежедневники']
              .filter(Boolean).join(', ');
            return `${c.direction==='HIGHER_IS_BETTER'?'Больше — лучше':'Меньше — лучше'}`+
              (need?` · требуется источник: ${need}`:'');
          })()}</span>
        </div>)}
        <div className="threshold-form">
          <label>Действует с<input required type="date" value={effective}
            onChange={e=>setEffective(e.target.value)}/></label>
          <label className="threshold-reason">Основание изменения
            <textarea required minLength={16} maxLength={500} value={reason}
              onChange={e=>setReason(e.target.value)}/></label>
        </div>
        {notice&&<p role="status">{notice}</p>}
        <button className="btn" disabled={busy}>{busy?'Сохраняю…':'Сохранить версию фокусов'}</button>
      </form>
      <p className="portal-muted">Один показатель нельзя поставить в два слота. Дата вступления в силу
        должна быть позже действующей версии этого месяца. Пустой план означает «план не задан», а не ноль.</p>
    </section>

    {history&&configurations.length>0&&<section className="portal-panel">
      <div className="portal-section-head"><h2>История версий фокусов</h2></div>
      <table className="score-table">
        <thead><tr><th>Месяц</th><th>Действует</th><th>Показатели</th><th>Основание</th></tr></thead>
        <tbody>{configurations.map(c=><tr key={c.id}>
          <td>{c.month}</td>
          <td>{c.effective_from} → {c.effective_to??'действует'}</td>
          <td>{c.slots.map(s=>labels[s.metric_code]??s.metric_code).join(', ')}</td>
          <td>{c.reason}</td>
        </tr>)}</tbody>
      </table>
    </section>}
  </div>;
}
