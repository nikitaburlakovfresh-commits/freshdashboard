import React,{useState} from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter,Routes,Route } from 'react-router-dom';
import BranchCardPage from '../src/pages/BranchCardPage';
import VehicleStockPage from '../src/pages/VehicleStockPage';
import '../src/styles/tokens.css';
import '../src/styles/portal.css';

/** Предпросмотр двух экранов на данных прода, без входа в портал. */
function Preview() {
  const [view,setView]=useState<'card'|'vin'>('card');
  const path=view==='card'
    ?'/branch-card/8d3ece6d-f69a-4d37-9d11-b6deee1af180?start=2026-09-01&end=2026-09-20'
    :'/branch-card/8d3ece6d-f69a-4d37-9d11-b6deee1af180/vin?observed_on=2026-09-19';
  return <div className="portal-shell">
    <div style={{display:'flex',gap:8,padding:'10px 16px',borderBottom:'1px solid #e3e6ea',background:'#fff'}}>
      <button className="btn" onClick={()=>setView('card')} disabled={view==='card'}>Карточка филиала</button>
      <button className="btn" onClick={()=>setView('vin')} disabled={view==='vin'}>Реестр авто (VIN)</button>
      <span className="portal-muted" style={{alignSelf:'center',fontSize:'.78rem'}}>
        Предпросмотр на данных прода: Дагомыс, 01.09–20.09, срез реестра 19.09</span>
    </div>
    <main className="portal-main">
      <MemoryRouter key={view} initialEntries={[path]}>
        <Routes>
          <Route path="/branch-card/:id" element={<BranchCardPage/>}/>
          <Route path="/branch-card/:id/vin" element={<VehicleStockPage/>}/>
        </Routes>
      </MemoryRouter>
    </main>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Preview/>);
