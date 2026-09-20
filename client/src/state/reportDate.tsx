import React,{createContext,useCallback,useContext,useEffect,useMemo,useState} from 'react';
import { readPublishedPeriods,type PublishedPeriod } from '../api/metrics';

/**
 * Глобальная дата отчётного среза. Один выбор в топбаре действует на все
 * экраны портала: обзор сети, карточку филиала, реестр. Дата не подставляет
 * данные и ничего не досчитывает — она лишь задаёт запрашиваемый срез,
 * поэтому за выбранное число показатели могут отсутствовать, и это не ноль.
 */
const KEY='fresh-report-date';
const today=()=>new Date().toISOString().slice(0,10);
/** Первое число месяца выбранной даты: период факта считается от начала месяца. */
export const monthStart=(date:string)=>`${date.slice(0,7)}-01`;

interface ReportDateValue {reportDate:string;setReportDate:(d:string)=>void;periodStart:string;
  periods:PublishedPeriod[];periodEnd:string}
const Ctx=createContext<ReportDateValue|null>(null);

export function ReportDateProvider({children}:{children:React.ReactNode}) {
  const [reportDate,setDate]=useState(()=>{
    try{
      const saved=localStorage.getItem(KEY);
      return saved&&/^\d{4}-\d{2}-\d{2}$/.test(saved)?saved:today();
    }catch{return today();}
  });
  const [periods,setPeriods]=useState<PublishedPeriod[]>([]);
  useEffect(()=>{
    // Перечень опубликованных срезов нужен, чтобы дата по умолчанию указывала на
    // существующую публикацию. Пользовательский выбор не переопределяется.
    let alive=true;
    readPublishedPeriods().then((r:{periods:PublishedPeriod[]})=>{
      if(!alive)return;
      setPeriods(r.periods);
      // Если выбранная дата не совпадает ни с одним опубликованным срезом,
      // экран был бы пустым: подставляем последнюю публикацию и сообщаем это
      // подписью среза. Данные при этом не досчитываются.
      if(r.periods.length&&!r.periods.some(p=>p.period_end===reportDate))
        setDate(r.periods[0].period_end);
    }).catch(()=>{/* Отсутствие перечня не меняет выбранный срез. */});
    return()=>{alive=false;};
  },[]);
  useEffect(()=>{
    try{localStorage.setItem(KEY,reportDate);}catch{/* Сохранение выбора необязательно. */}
  },[reportDate]);
  const setReportDate=useCallback((d:string)=>{
    // Пустое или некорректное значение из поля даты не сбрасывает срез на «сегодня»
    // молча: выбор пользователя сохраняется до следующего явного изменения.
    if(/^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
  },[]);
  const match=periods.find(p=>p.period_end===reportDate);
  const value=useMemo(()=>({reportDate,setReportDate,periods,
    periodStart:match?match.period_start:monthStart(reportDate),
    periodEnd:reportDate}),[reportDate,setReportDate,periods,match]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReportDate():ReportDateValue {
  const v=useContext(Ctx);
  if(!v) throw new Error('useReportDate вызван вне ReportDateProvider');
  return v;
}
