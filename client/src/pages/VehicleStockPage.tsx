import React,{useEffect,useMemo,useState} from 'react';
import { Link,useParams,useSearchParams } from 'react-router-dom';
import { readVehicleStock,type VehicleStockRow } from '../api/metrics';
import '../styles/branch-card.css';

/**
 * Реестр автомобилей филиала на дату среза. Показывает ровно то, что пришло из
 * отчёта «Анализ склада»: ничего не досчитывается, пустое значение остаётся
 * прочерком. Персональные столбцы источника в портал не переносятся.
 */

const RUB=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const rub=(v:number|null)=>v===null||v===undefined?'—':RUB.format(Math.round(v));
const num=(v:number|null)=>v===null||v===undefined?'—':RUB.format(v);
const pct=(v:number|null)=>v===null||v===undefined?'—':`${(v*100).toFixed(1).replace('.',',')}%`;

type SortKey='days'|'margin'|'price'|'diff'|'leads';

export default function VehicleStockPage() {
  const {id=''}=useParams();
  const [params]=useSearchParams();
  const [observedOn,setObservedOn]=useState(params.get('observed_on')??'');
  const [items,setItems]=useState<VehicleStockRow[]|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [supply,setSupply]=useState('');
  const [aged,setAged]=useState(false);
  const [sort,setSort]=useState<SortKey>('days');

  async function load(e?:React.FormEvent) {
    e?.preventDefault();
    if(!observedOn)return;
    setBusy(true);setError('');setItems(null);
    try{setItems((await readVehicleStock(observedOn,id)).items);}
    catch(err:any){setError(err?.message??'Не удалось прочитать реестр.');}
    finally{setBusy(false);}
  }
  useEffect(()=>{if(observedOn)void load();},[id]);

  const supplyTypes=useMemo(()=>[...new Set((items??[]).map(r=>r.supply_type).filter(Boolean))] as string[],[items]);
  const shown=useMemo(()=>{
    let list=[...(items??[])];
    if(supply)list=list.filter(r=>r.supply_type===supply);
    if(aged)list=list.filter(r=>r.days_on_stock!==null&&r.days_on_stock>=45);
    const key=(r:VehicleStockRow)=>sort==='days'?r.days_on_stock
      :sort==='margin'?r.margin_rub:sort==='price'?r.sale_price_rub
        :sort==='diff'?r.market_diff_rub:r.leads;
    // Пустое значение уходит в конец: отсутствие данных не равно нулю и не
    // должно выглядеть худшим или лучшим результатом.
    return list.sort((a,b)=>{
      const x=key(a),y=key(b);
      if(x===null||x===undefined)return 1;
      if(y===null||y===undefined)return -1;
      return y-x;
    });
  },[items,supply,aged,sort]);

  const totals=useMemo(()=>({
    count:shown.length,
    cost:shown.reduce((n,r)=>n+(r.cost_rub??0),0),
    aged:shown.filter(r=>r.days_on_stock!==null&&r.days_on_stock>=45).length,
  }),[shown]);

  return <section className="portal-panel">
    <div className="portal-section-head"><h1>Реестр авто (VIN)</h1></div>
    <form className="beta-filters" onSubmit={load}>
      <label>Дата среза<input required aria-label="Дата среза" type="date" value={observedOn}
        onChange={e=>{setItems(null);setObservedOn(e.target.value);}}/></label>
      <button className="btn" disabled={busy}>{busy?'Читаю…':'Показать реестр'}</button>
      <Link className="btn btn-ghost" to={`/branch-card/${id}`}>К карточке филиала</Link>
    </form>
    {error&&<p role="alert">{error}</p>}
    {!items&&!error&&!busy&&<p>Укажите дату среза реестра.</p>}
    {items&&items.length===0&&<p role="status">На эту дату реестр по филиалу не опубликован.</p>}
    {items&&items.length>0&&<>
      <div className="beta-filters">
        <label>Тип поставки
          <select value={supply} onChange={e=>setSupply(e.target.value)}>
            <option value="">все</option>
            {supplyTypes.map(t=><option key={t} value={t}>{t}</option>)}
          </select></label>
        <label><input type="checkbox" checked={aged} onChange={e=>setAged(e.target.checked)}/>
          только 45 дней и больше</label>
        <label>Сортировка
          <select value={sort} onChange={e=>setSort(e.target.value as SortKey)}>
            <option value="days">срок хранения</option>
            <option value="margin">маржа</option>
            <option value="price">цена продажи</option>
            <option value="diff">разница к рынку</option>
            <option value="leads">лиды</option>
          </select></label>
      </div>
      <p className="portal-muted">Автомобилей {totals.count} · себестоимость {rub(totals.cost)} ₽ ·
        из них 45 дней и больше {totals.aged}</p>
      <div className="card-table-scroll">
        <table className="local-table">
          <thead><tr>
            <th>Автомобиль</th><th>VIN</th><th>Поставка</th><th>Хранение, дн</th>
            <th>Себестоимость</th><th>Цена продажи</th><th>Рынок</th><th>Разница</th>
            <th>Маржа</th><th>Рентаб.</th><th>Изм. цены</th><th>Лиды</th><th>Реклама</th>
          </tr></thead>
          <tbody>{shown.map(r=><tr key={r.id}>
            <td>{[r.make,r.model,r.production_year].filter(Boolean).join(' ')||'—'}
              {r.mileage!==null&&<><br/><small className="portal-muted">{num(r.mileage)} км
                {r.color?` · ${r.color}`:''}</small></>}</td>
            <td><code>{r.vehicle_key}</code>{r.key_kind==='FRAME'&&<><br/>
              <small className="portal-muted">номер кузова</small></>}</td>
            <td>{r.supply_type??'—'}</td>
            <td className="tabnum" data-aged={r.days_on_stock!==null&&r.days_on_stock>=45?'yes':undefined}>
              {num(r.days_on_stock)}</td>
            <td className="tabnum">{rub(r.cost_rub)}</td>
            <td className="tabnum">{rub(r.sale_price_rub)}</td>
            <td className="tabnum">{rub(r.market_price_rub)}</td>
            <td className="tabnum">{rub(r.market_diff_rub)}</td>
            <td className="tabnum">{rub(r.margin_rub)}</td>
            <td className="tabnum">{pct(r.profitability)}</td>
            <td className="tabnum">{r.price_changes_count===null?'—'
              :<>{r.price_changes_count}{r.price_changes_days!==null&&
                <small className="portal-muted"> / {Math.round(r.price_changes_days)} дн</small>}</>}</td>
            <td className="tabnum">{num(r.leads)}</td>
            <td>{r.advertising_status??'—'}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </>}
  </section>;
}
