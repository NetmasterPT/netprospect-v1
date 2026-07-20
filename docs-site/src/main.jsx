import React from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import './theme.css';
import './ui.css';
import App from './App.jsx';

// tema antes do paint (evita flash) — default dark, como o dashboard
try { document.documentElement.setAttribute('data-theme', localStorage.getItem('np-theme') || 'dark'); } catch (e) {}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>,
);
