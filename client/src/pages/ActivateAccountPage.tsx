import React,{useEffect,useRef,useState} from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../api/client';
import Logo from '../components/Logo';
import '../styles/enrollment.css';

export default function ActivateAccountPage() {
  const [token,setToken]=useState(()=>window.location.hash.slice(1));
  const [password,setPassword]=useState(''),[repeat,setRepeat]=useState(''),[busy,setBusy]=useState(false),[done,setDone]=useState(false),[error,setError]=useState('');
  const generation=useRef(0);
  useEffect(()=>{
    function consumeFragment() {
      // A queued hashchange can arrive after replaceState has already consumed
      // the fragment. It must not erase the in-memory bearer a second time.
      if(!window.location.hash)return;
      generation.current++;
      setToken(window.location.hash.slice(1));setPassword('');setRepeat('');setBusy(false);setDone(false);setError('');
      // Fragments never reach HTTP access logs. Remove from browser history too.
      window.history.replaceState(null,'','/activate-account');
    }
    if(window.location.hash)consumeFragment();
    window.addEventListener('hashchange',consumeFragment);
    return()=>{generation.current++;window.removeEventListener('hashchange',consumeFragment);};
  },[]);
  async function submit(e:React.FormEvent) {
    e.preventDefault();if(password!==repeat){setError('Пароли не совпадают.');return;}
    const current=generation.current;
    setBusy(true);setError('');
    try {
      await apiFetch('/auth/enrollment/accept',{method:'POST',body:{token,password}});
      if(current!==generation.current)return;
      setToken('');setPassword('');setRepeat('');setDone(true);
    } catch(e) {if(current===generation.current)setError(e instanceof Error?e.message:'Не удалось установить пароль. Если запрос уже завершился, попробуйте обычный вход.');}
    finally {if(current===generation.current)setBusy(false);}
  }
  return <main className="enrollment-page"><section className="enrollment-card">
    <Logo size={36}/><span className="portal-eyebrow">FRESH · ПЕРСОНАЛЬНЫЙ ДОСТУП</span>
    <h1>{done?'Пароль установлен':'Первый вход'}</h1>
    {done?<><p>Личная учётная запись активирована. Войдите по логину, который передал администратор; доступ к филиалам появится только после отдельного назначения.</p>
      <Link className="btn" to="/">Перейти ко входу</Link></>:
    !/^[A-Za-z0-9_-]{43}$/.test(token)?<><p>В ссылке нет действительного приглашения. Откройте полную ссылку администратора или запросите новую.</p><Link to="/">Обычный вход</Link></>:
    <form onSubmit={submit}>
      <p>Установите свой пароль. Ссылка одноразовая и действует 72 часа с момента выпуска; общие пароли старого портала использовать не нужно.</p>
      <label>Новый пароль<input type="password" autoComplete="new-password" required minLength={14} maxLength={200} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></label>
      <small>От 14 до 200 символов. Используйте уникальную длинную фразу.</small>
      <label>Повторите пароль<input type="password" autoComplete="new-password" required minLength={14} maxLength={200} value={repeat} onChange={e=>setRepeat(e.target.value)} disabled={busy}/></label>
      {error&&<p role="alert" className="org-error">{error} Если пароль уже установлен, попробуйте обычный вход.</p>}
      <button className="btn" disabled={busy||!password||password!==repeat}>{busy?'Устанавливаем пароль…':'Установить пароль'}</button>
      <p>После обновления страницы откройте исходную ссылку заново. Если она уже использована, войдите обычным способом.</p><Link to="/">Обычный вход</Link>
    </form>}
  </section></main>;
}
