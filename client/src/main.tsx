import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './styles/tokens.css';
import { AuthProvider } from './auth/AuthContext';
import App from './App';

const rootEl = document.getElementById('root')!;
try { document.documentElement.dataset.theme = localStorage.getItem('fresh-theme') === 'light' ? 'light' : 'dark'; } catch { /* Dark default when storage is unavailable. */ }
createRoot(rootEl).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
