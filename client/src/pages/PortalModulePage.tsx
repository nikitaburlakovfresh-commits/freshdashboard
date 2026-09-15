import React from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { METRICS } from './DashboardPage';
import { orgUnitLabel } from '../constants/orgUnits';
import { useAuth } from '../auth/AuthContext';
const modules:Record<string,{title:string,description:string,rows:string[]}>={
  '/analytics':{title:'Продажи и склад',description:'Детализация показателей главного дашборда.',rows:['Продажи и выполнение плана','Маржа и прогноз выполнения','Структура склада и автомобили 45+','Переход к связанным задачам']},
  '/bdr':{title:'БДР',description:'Финансовый план и факт филиала. Расчёты ещё не подключены.',rows:['Выручка и себестоимость','Валовая прибыль','Операционные расходы','Финансовый результат','План / факт и отклонения']},
  '/kpi':{title:'KPI и MBO',description:'Показатели и цели будут связаны с измеримым результатом.',rows:['Показатель и утверждённая цель','Период, план и фактическое значение','Задачи для достижения цели','Отдельная проверка достижения результата']},
  '/diary':{title:'Ежедневник',description:'Будущий контур регулярных обязательств и задач дня.',rows:['Обязательства на день','Результаты и подтверждения','Просрочки и корректирующие действия']},
};
export default function PortalModulePage(){
  const {pathname}=useLocation();const [params]=useSearchParams();const {me}=useAuth();
  const m=modules[pathname]??modules['/analytics'];const metric=METRICS.find(x=>x.code===params.get('metric'));
  const org=params.get('org');const allowed=me?.grants.some(g=>g.org_unit_id===org);
  return <div className="portal-dashboard">
    <Link to="/">← На главный дашборд</Link>
    <header className="portal-heading"><div><div className="portal-eyebrow">РАЗДЕЛ ПОРТАЛА · КАРКАС</div><h1>{metric?.name??m.title}</h1><p>{m.description}</p></div><span className="portal-chip">Данные не подключены</span></header>
    {params.get('period')&&<p className="portal-muted">Период: {params.get('period')} · {org&&allowed?orgUnitLabel(org):'Ваш доступный контур'}</p>}
    <section className="portal-panel"><h2>Что будет в этом разделе</h2><div className="portal-module-rows">{m.rows.map((row,i)=><div key={row}><span>{String(i+1).padStart(2,'0')}</span><strong>{row}</strong><small>Следующий этап</small></div>)}</div></section>
    <section className="portal-panel"><h2>Состояние подключения</h2><p>Этот раздел пока остаётся навигационным каркасом. Первый источник продаж и склада доступен через локальную загрузку Excel на главном дашборде, с детализацией по филиалам и сверкой ячеек. При уходе с дашборда загруженные данные сбрасываются; серверное сохранение не подключено.</p>{metric&&<p className="portal-muted">Код: {metric.code} · источник: {metric.source}. Для просмотра загрузите отчёт на главной странице.</p>}<p>Ноль не подставляется вместо отсутствующих данных. Завершение задачи не означает автоматическое достижение KPI или финансовой цели.</p></section>
    <Link className="portal-primary" to="/tasks">Открыть работающий модуль задач</Link>
  </div>;
}
