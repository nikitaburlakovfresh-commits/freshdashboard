import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { listWorkItems } from '../api/endpoints';
import { orgUnitLabel } from '../constants/orgUnits';
import type { WorkItem } from '../api/types';
import StatusBadge from '../components/StatusBadge';
import CreateTaskModal from './CreateTaskModal';
import LocalBusinessData from '../components/LocalBusinessData';
import '../styles/portal.css';

export const METRICS = [
  {code:'sales_units',name:'Продажи автомобилей',unit:'шт.',source:'kso_margin_revenue',section:'sales'},
  {code:'margin_fact',name:'Маржа + КСО',unit:'₽',source:'kso_margin_revenue',section:'sales'},
  {code:'stock_units_end',name:'Автомобили на складе',unit:'шт.',source:'main_summary',section:'stock'},
  {code:'hangers45_total',name:'Склад 45+',unit:'шт.',source:'main_summary',section:'stock'},
];
export default function DashboardPage(){
  const {me}=useAuth();
  const orgs=[...new Set(me?.grants.map(g=>g.org_unit_id)??[])];
  const [org,setOrg]=useState(orgs[0]??'');
  const [items,setItems]=useState<WorkItem[]>([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  const [partial,setPartial]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [updated,setUpdated]=useState('');
  const [create,setCreate]=useState(false);
  const canCreate=me?.grants.some(g=>g.role==='REGIONAL_MANAGER');
  useEffect(()=>{
    let live=true;
    setLoading(true);setError('');
    (async()=>{
      let cursor:string|undefined;const all:WorkItem[]=[];
      for(let p=0;p<20;p++){
        const page=await listWorkItems({org_unit_id:org||undefined,limit:50,cursor});
        all.push(...page.items);cursor=page.next_cursor??undefined;
        if(!cursor)break;
      }
      if(live){setItems(all);setPartial(Boolean(cursor));setUpdated(new Date().toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}));}
    })().catch(e=>{if(live)setError(e.message??'Не удалось получить задачи');}).finally(()=>{if(live)setLoading(false);});
    return()=>{live=false;};
  },[org,refresh,me?.user.id]);
  const open=items.filter(t=>!['COMPLETED','CANCELLED'].includes(t.status));
  const overdue=open.filter(t=>Date.parse(t.due_at)<Date.now());
  const attention=[...open].sort((a,b)=>Date.parse(a.due_at)-Date.parse(b.due_at)).slice(0,5);
  const counts=[
    {title:'Все задачи',count:items.length,link:'/tasks'},
    {title:'В работе',count:items.filter(t=>t.status==='IN_PROGRESS').length,link:'/tasks?status=IN_PROGRESS'},
    {title:'На проверке',count:items.filter(t=>t.status==='SUBMITTED').length,link:'/tasks?status=SUBMITTED'},
    {title:'Выполнены',count:items.filter(t=>t.status==='COMPLETED').length,link:'/tasks?status=COMPLETED'},
  ];
  return <div className="portal-dashboard">
    <header className="portal-heading">
      <div><h1>Обзор сети</h1><p>Фактические показатели, фокусы внимания и исполнение задач</p></div>
      {canCreate&&<button className="portal-primary" onClick={()=>setCreate(true)}>+ Создать задачу пилота</button>}
    </header>
    <LocalBusinessData key={me?.user.id}/>
    <div className="portal-section-head task-section-heading"><div><div className="portal-eyebrow">ОТДЕЛЬНЫЙ КОНТУР · ПИЛОТ R1</div><h2>Операционная работа</h2></div><span className="portal-chip">Задачи ≠ бизнес-показатели</span></div>
    <div className="portal-context task-context">
      <label>Контур задач · синтетические A/B<select aria-label="Филиал задач" value={org} onChange={e=>setOrg(e.target.value)}>{orgs.map(o=><option key={o} value={o}>{orgUnitLabel(o)}</option>)}</select></label>
      <div className="portal-context-note">Только доступные по роли задачи<br/><span>Не связан с филиалами локального Excel</span></div>
    </div>
    <div className="portal-grid">
      <section className="portal-panel">
        <div className="portal-section-head"><div><h2>Исполнение задач</h2><p className="portal-muted">Текущие состояния · все сроки</p></div><button className="portal-text-button" onClick={()=>setRefresh(x=>x+1)} disabled={loading}>{loading?'Обновление…':'Обновить'}</button></div>
        {error?<div className="portal-error" role="alert">{error} <button onClick={()=>setRefresh(x=>x+1)}>Повторить</button></div>:
        loading?<div className="portal-empty" role="status">Загружаем доступные задачи…</div>:
        <><div className="portal-task-counts">{counts.map(c=><Link to={c.link} key={c.title}><strong>{c.count}</strong><span>{c.title}</span></Link>)}</div>
        <div className="portal-alert-line"><span className={overdue.length?'portal-warning':''}>{overdue.length?`Требуют внимания: ${overdue.length} с истёкшим сроком`:'Открытых задач с истёкшим сроком нет'}</span><span>{updated}</span></div>
        {partial&&<p role="status" className="portal-warning">Показаны счётчики только первых 1000 задач, это не полный итог.</p>}</>}
        <Link className="portal-module-link" to="/tasks">Перейти в раздел задач →</Link>
      </section>
      <section className="portal-panel">
        <div className="portal-section-head"><h2>БДР · план и факт</h2><span className="portal-chip">Не подключён</span></div>
        <div className="portal-empty"><div className="portal-empty-mark">₽</div><h3>Финансовая модель на своём месте</h3><p>Выручка, расходы и прибыль появятся после согласования расчётов и подключения БДР. Сейчас финансовые итоги не рассчитаны.</p></div>
        <Link className="portal-module-link" to={`/bdr?org=${org}`}>Открыть структуру раздела →</Link>
      </section>
    </div>
    <section className="portal-panel">
      <div className="portal-section-head"><div><h2>Ближайшие действия</h2><p className="portal-muted">Открытые задачи по возрастанию срока · до 5 записей</p></div><Link to="/tasks">Все задачи →</Link></div>
      {error?<p className="portal-error">Список недоступен: повторите загрузку выше.</p>:loading?<p role="status">Загрузка…</p>:attention.length?attention.map(t=><Link className="portal-task-row" to={`/tasks/${t.id}`} key={t.id}><div><strong>{t.title}</strong><span>Срок: {new Date(t.due_at).toLocaleString('ru-RU',{timeZone:'UTC'})} UTC</span></div><StatusBadge status={t.status}/></Link>):<div className="portal-empty compact">Открытых задач нет. {canCreate?'Создайте первую задачу кнопкой вверху.':'Новые назначения появятся здесь.'}</div>}
    </section>
    <footer className="portal-next"><span>FRESH Portal · сетевой срез по ТЗ v2.12</span><span>Не полная реализация ТЗ · R1 + локальный Excel</span></footer>
    {create&&<CreateTaskModal grants={me?.grants??[]} onClose={()=>setCreate(false)} onCreated={()=>{setCreate(false);setRefresh(x=>x+1);}}/>}
  </div>;
}
