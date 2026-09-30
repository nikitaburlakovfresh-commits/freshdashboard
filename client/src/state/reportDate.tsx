import React,{createContext,useCallback,useContext,useEffect,useMemo,useState} from 'react';
import { readPublishedPeriods,type PublishedPeriod } from '../api/metrics';

/**
 * Глобальная дата отчётного среза. Один выбор в топбаре действует на все
 * экраны портала: обзор сети, карточку филиала, реестр. Дата не подставляет
 * данные и ничего не досчитывает — она лишь задаёт запрашиваемый срез,
 * поэтому за выбранное число показатели могут отсутствовать, и это не ноль.
 */
const KEY='fresh-report-date';
/** Местная дата пользователя: toISOString давал вчерашний день до 03:00 МСК. */
const localDay=(offset=0)=>{const d=new Date(Date.now()+offset*86400000);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
const today=()=>localDay();
/** Вчерашний день — дата данных для загрузки отчётов QLIK по умолчанию. */
export const yesterday=()=>localDay(-1);
/** Первое число месяца выбранной даты: период факта считается от начала месяца. */
export const monthStart=(date:string)=>`${date.slice(0,7)}-01`;

interface ReportDateValue {reportDate:string;setReportDate:(d:string)=>void;periodStart:string;
  periods:PublishedPeriod[];periodEnd:string}
const Ctx=createContext<ReportDateValue|null>(null);

export function ReportDateProvider({children}:{children:React.ReactNode}) {
  const [reportDate,setDate]=useState(()=>{
    try{
      // По умолчанию — сегодня (решение владельца 30.09.2026). Экран сам покажет
      // последние загруженные данные не позже этой даты. Выбор другой даты
      // сохраняется только до конца дня.
      const saved=JSON.parse(localStorage.getItem(KEY)??'null');
      return saved?.on===today()&&/^\d{4}-\d{2}-\d{2}$/.test(saved?.date??'')?saved.date:today();
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
      // Дата не подменяется: сервер сам берёт последний срез с фактами не позже неё.
    }).catch(()=>{/* Отсутствие перечня не меняет выбранный срез. */});
    return()=>{alive=false;};
  },[]);
  useEffect(()=>{
    try{localStorage.setItem(KEY,JSON.stringify({date:reportDate,on:today()}));}catch{/* Сохранение выбора необязательно. */}
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
