import React,{useCallback,useEffect,useState} from 'react';
import { readScoringModels,saveScoringModel,SCORING_MODEL_FIELDS,SCORING_FIELD_LABELS,
  SCORING_SCORE_BAND_FIELDS,SCORING_SCORE_BAND_LABELS,
  EVALUATION_LABELS,DIRECTION_LABELS,RULE_ROLE_LABELS,type ScoringModelRow,
  type ScoringWeight,type Evaluation,type RuleRole,type Direction } from '../api/metrics';
import '../styles/branch-grid.css';
import '../styles/network-score.css';

/**
 * Модель балла филиала настраивается здесь, а не в коде: cap, пороги правил
 * светофора, полосы конверсии и веса показателей. Каждая версия имеет дату
 * вступления в силу и основание; прежние версии сохраняются, поэтому
 * историческая отчётность не искажается.
 */
type WeightForm={metric:string;weight:string;evaluation:Evaluation;plan_metric:string;
  rule_role:RuleRole;band_green:string;band_amber:string;direction:Direction|''};
const EMPTY_WEIGHT:WeightForm={metric:'',weight:'',evaluation:'RUN_RATE',plan_metric:'',
  rule_role:'ORDINARY',band_green:'',band_amber:'',direction:''};
/** Способы расчёта, которым нужен показатель плана. */
const NEEDS_PLAN=(e:Evaluation)=>e==='RUN_RATE'||e==='RATIO_TO_PLAN';

export default function ScoringModelPage() {
  const [items,setItems]=useState<ScoringModelRow[]|null>(null);
  const [names,setNames]=useState<Record<string,string>>({});
  const [history,setHistory]=useState(false);
  const [fields,setFields]=useState<Record<string,string>>({});
  const [weights,setWeights]=useState<WeightForm[]>([{...EMPTY_WEIGHT}]);
  const [effective,setEffective]=useState(''),[reason,setReason]=useState('');
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);

  const load=useCallback(async(withHistory:boolean)=>{
    setError('');
    try{const r=await readScoringModels(withHistory);setItems(r.items);setNames(r.metric_names);}
    catch(e:any){setItems(null);setError(e.message);}
  },[]);
  useEffect(()=>{void load(history);},[history,load]);

  const current=items?.find(m=>m.effective_to===null)??null;
  /** Предзаполнение только действующей версией — неподтверждённых значений не подставляем. */
  function prefill() {
    if(!current)return;
    const next:Record<string,string>={};
    for(const f of SCORING_MODEL_FIELDS) next[f]=String(current[f]);
    setFields(next);
    for(const f of SCORING_SCORE_BAND_FIELDS) next[f]=current[f]===null?'':String(current[f]);
    setWeights(current.weights.map(w=>({metric:w.metric,weight:String(w.weight),
      evaluation:w.evaluation,plan_metric:w.plan_metric??'',rule_role:w.rule_role,
      band_green:w.band_green===null?'':String(w.band_green),
      band_amber:w.band_amber===null?'':String(w.band_amber),
      direction:w.direction??''})));
    setNotice('Форма заполнена действующей версией. Измените нужные параметры и укажите дату и основание.');
  }

  async function submit(e:React.FormEvent) {
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try{
      const model:any={};
      for(const f of SCORING_MODEL_FIELDS) model[f]=Number(fields[f]);
      // Пустое поле порога статуса остаётся пустым: ноль означал бы «порог ноль».
      for(const f of SCORING_SCORE_BAND_FIELDS)
        model[f]=(fields[f]??'').trim()===''?null:Number(fields[f]);
      const list:ScoringWeight[]=weights.map(w=>({metric:w.metric,weight:Number(w.weight),
        evaluation:w.evaluation,plan_metric:NEEDS_PLAN(w.evaluation)?(w.plan_metric||null):null,
        rule_role:w.rule_role,
        band_green:w.evaluation==='BAND_PCT'?Number(w.band_green):null,
        band_amber:w.evaluation==='BAND_PCT'?Number(w.band_amber):null,
        direction:w.evaluation==='BAND_PCT'?(w.direction||null) as Direction|null:null}));
      const r=await saveScoringModel({...model,weights:list,effective_from:effective,reason});
      setNotice(`Модель балла сохранена и действует с ${r.effective_from}.`+
        (r.previous_id?' Прежняя версия закрыта этой датой и сохранена в истории.':''));
      setReason('');
      await load(history);
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  const setWeight=(i:number,patch:Partial<WeightForm>)=>
    setWeights(list=>list.map((w,idx)=>idx===i?{...w,...patch}:w));

  return <div className="portal-page network-kpi">
    <h1>Модель балла филиала</h1>
    <p className="portal-muted">Веса, ограничение балла, пороги правил светофора и полосы конверсии задаются
      внутри портала без изменения кода. Балл не рассчитывается, пока модель не настроена: отсутствие
      данных не заменяется нулём.</p>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Действующая версия</h2>
        {current&&<button type="button" className="btn" onClick={prefill}>Заполнить форму действующей версией</button>}
      </div>
      {items===null&&!error&&<p>Загружаю настройки…</p>}
      {items&&!current&&<p role="status">Модель балла ещё не настроена: балл филиалов и средний балл сети
        не рассчитываются.</p>}
      {current&&<>
        <p className="portal-muted">Действует с {current.effective_from}. Основание: {current.reason}</p>
        {current.green_score_from!==null&&current.amber_score_from!==null
          ?<p className="portal-muted">Статус определяется только баллом: зелёный
            от {current.green_score_from}, жёлтый от {current.amber_score_from}, ниже — красный.
            Правила порога выручки, стоп-фактора и счёта слабых показателей не применяются.</p>
          :<p className="portal-muted">Статус определяется правилами порога выручки, стоп-фактора и
            счёта слабых показателей. Чтобы перейти на статус по баллу, заполните
            «{SCORING_SCORE_BAND_LABELS.green_score_from}» и «{SCORING_SCORE_BAND_LABELS.amber_score_from}».</p>}
        <dl className="score-params">
          {SCORING_SCORE_BAND_FIELDS.map(f=><div key={f}>
            <dt>{SCORING_SCORE_BAND_LABELS[f]}</dt>
            <dd className="tabnum">{current[f]===null?'не задан':current[f]}</dd></div>)}
          {SCORING_MODEL_FIELDS.map(f=><div key={f}>
          <dt>{SCORING_FIELD_LABELS[f]}</dt><dd className="tabnum">{current[f]}</dd></div>)}</dl>
        <table className="score-table">
          <thead><tr><th>Показатель</th><th className="tabnum">Вес</th><th>Расчёт</th>
            <th>Показатель плана</th><th>Полосы</th><th>Роль в правилах</th></tr></thead>
          <tbody>{current.weights.map(w=><tr key={w.metric}>
            <td>{names[w.metric]??w.metric}</td>
            <td className="tabnum">{w.weight}</td>
            <td>{EVALUATION_LABELS[w.evaluation]}</td>
            <td>{w.plan_metric?(names[w.plan_metric]??w.plan_metric):'—'}</td>
            <td className="tabnum">{w.band_green===null?'—'
              :`${w.band_green} / ${w.band_amber} · ${w.direction?DIRECTION_LABELS[w.direction]:''}`}</td>
            <td>{RULE_ROLE_LABELS[w.rule_role]}</td>
          </tr>)}</tbody>
        </table>
      </>}
    </section>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Новая версия модели</h2></div>
      <form onSubmit={submit}>
        <div className="threshold-form">
          {SCORING_SCORE_BAND_FIELDS.map(f=><label key={f}>{SCORING_SCORE_BAND_LABELS[f]}
            <input type="number" step="any" min="0" value={fields[f]??''} placeholder="не задан"
              onChange={e=>setFields(s=>({...s,[f]:e.target.value}))}/></label>)}
        </div>
        <p className="portal-muted">Заполните оба порога статуса — статус будет определяться только
          баллом, как в боевом портале. Оставьте оба пустыми — сработают прежние правила ниже.</p>
        <div className="threshold-form">
          {SCORING_MODEL_FIELDS.map(f=><label key={f}>{SCORING_FIELD_LABELS[f]}
            <input required type="number" step="any" min="0" value={fields[f]??''}
              onChange={e=>setFields(s=>({...s,[f]:e.target.value}))}/></label>)}
        </div>
        <h3>Веса показателей</h3>
        <p className="portal-muted">Расчёт к плану требует показателя плана. Показателю с полосами
          нужны зелёная и жёлтая полосы и направление: «больше — лучше» либо «меньше — лучше».
          Роли «выручка» и «оборачиваемость» применяются только в прежних правилах светофора и
          могут быть назначены одному показателю каждая.</p>
        {weights.map((w,i)=><div className="threshold-form score-weight" key={i}>
          <label>Показатель
            <select required value={w.metric} onChange={e=>setWeight(i,{metric:e.target.value})}>
              <option value="">Выберите показатель</option>
              {Object.entries(names).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select></label>
          <label>Вес<input required type="number" step="any" min="0" max="1000" value={w.weight}
            onChange={e=>setWeight(i,{weight:e.target.value})}/></label>
          <label>Расчёт
            <select value={w.evaluation} onChange={e=>setWeight(i,{evaluation:e.target.value as Evaluation,
              plan_metric:NEEDS_PLAN(e.target.value as Evaluation)?w.plan_metric:'',
              band_green:e.target.value==='BAND_PCT'?w.band_green:'',
              band_amber:e.target.value==='BAND_PCT'?w.band_amber:'',
              direction:e.target.value==='BAND_PCT'?(w.direction||'HIGHER_IS_BETTER'):''})}>
              {Object.entries(EVALUATION_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select></label>
          <label>Показатель плана
            <select value={w.plan_metric} disabled={!NEEDS_PLAN(w.evaluation)}
              required={NEEDS_PLAN(w.evaluation)}
              onChange={e=>setWeight(i,{plan_metric:e.target.value})}>
              <option value="">Не применяется</option>
              {Object.entries(names).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select></label>
          <label>Зелёная полоса, %
            <input type="number" step="any" value={w.band_green} disabled={w.evaluation!=='BAND_PCT'}
              required={w.evaluation==='BAND_PCT'} placeholder="не применяется"
              onChange={e=>setWeight(i,{band_green:e.target.value})}/></label>
          <label>Жёлтая полоса, %
            <input type="number" step="any" value={w.band_amber} disabled={w.evaluation!=='BAND_PCT'}
              required={w.evaluation==='BAND_PCT'} placeholder="не применяется"
              onChange={e=>setWeight(i,{band_amber:e.target.value})}/></label>
          <label>Направление
            <select value={w.direction} disabled={w.evaluation!=='BAND_PCT'}
              onChange={e=>setWeight(i,{direction:e.target.value as Direction|''})}>
              <option value="">Не применяется</option>
              {Object.entries(DIRECTION_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select></label>
          <label>Роль в правилах
            <select value={w.rule_role} onChange={e=>setWeight(i,{rule_role:e.target.value as RuleRole})}>
              {Object.entries(RULE_ROLE_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
            </select></label>
          <button type="button" className="btn-link" disabled={weights.length===1}
            onClick={()=>setWeights(list=>list.filter((_,idx)=>idx!==i))}>Убрать показатель</button>
        </div>)}
        <button type="button" className="btn" disabled={weights.length>=40}
          onClick={()=>setWeights(list=>[...list,{...EMPTY_WEIGHT}])}>Добавить показатель</button>
        <div className="threshold-form">
          <label>Действует с<input required type="date" value={effective}
            onChange={e=>setEffective(e.target.value)}/></label>
          <label className="threshold-reason">Основание изменения
            <textarea required minLength={16} maxLength={500} value={reason}
              onChange={e=>setReason(e.target.value)}/></label>
        </div>
        {error&&<p role="alert">{error}</p>}
        {notice&&<p role="status">{notice}</p>}
        <button className="btn" disabled={busy}>{busy?'Сохраняю…':'Сохранить версию модели балла'}</button>
      </form>
      <p className="portal-muted">Дата вступления в силу должна быть позже действующей версии.
        Ранее рассчитанные периоды не пересчитываются задним числом.</p>
    </section>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>{history?'Все версии модели':'История версий'}</h2>
        <label className="fact-check"><input type="checkbox" checked={history}
          onChange={e=>setHistory(e.target.checked)}/> Показать историю</label></div>
      {items&&items.length>0&&<table className="score-table">
        <thead><tr><th>Действует</th><th className="tabnum">Cap</th><th className="tabnum">Красный ниже</th>
          <th className="tabnum">Зелёный выше</th><th className="tabnum">Стоп-фактор</th>
          <th className="tabnum">Показателей</th><th>Основание</th></tr></thead>
        <tbody>{items.map(m=><tr key={m.id}>
          <td>{m.effective_from} → {m.effective_to??'действует'}</td>
          <td className="tabnum">{m.score_cap}</td>
          <td className="tabnum">{m.red_score_below}</td>
          <td className="tabnum">{m.green_score_above}</td>
          <td className="tabnum">{m.stop_turnover_below}</td>
          <td className="tabnum">{m.weights.length}</td>
          <td>{m.reason}</td>
        </tr>)}</tbody>
      </table>}
    </section>
  </div>;
}
