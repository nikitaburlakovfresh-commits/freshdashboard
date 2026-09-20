import React,{createContext,useCallback,useContext,useEffect,useMemo,useState} from 'react';

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

interface ReportDateValue {reportDate:string;setReportDate:(d:string)=>void;periodStart:string}
const Ctx=createContext<ReportDateValue|null>(null);

export function ReportDateProvider({children}:{children:React.ReactNode}) {
  const [reportDate,setDate]=useState(()=>{
    try{
      const saved=localStorage.getItem(KEY);
      return saved&&/^\d{4}-\d{2}-\d{2}$/.test(saved)?saved:today();
    }catch{return today();}
  });
  useEffect(()=>{
    try{localStorage.setItem(KEY,reportDate);}catch{/* Сохранение выбора необязательно. */}
  },[reportDate]);
  const setReportDate=useCallback((d:string)=>{
    // Пустое или некорректное значение из поля даты не сбрасывает срез на «сегодня»
    // молча: выбор пользователя сохраняется до следующего явного изменения.
    if(/^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
  },[]);
  const value=useMemo(()=>({reportDate,setReportDate,periodStart:monthStart(reportDate)}),
    [reportDate,setReportDate]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useReportDate():ReportDateValue {
  const v=useContext(Ctx);
  if(!v) throw new Error('useReportDate вызван вне ReportDateProvider');
  return v;
}
