import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {/* NavLink / Routes 必须挂在 Router 之下，漏掉这层会直接白屏 */}
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);