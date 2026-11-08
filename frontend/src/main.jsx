import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { CommerceProvider } from './context/CommerceContext.jsx';
import { VoucherReadinessProvider } from './hooks/useVoucherReadiness.js';
import { LOGO_SRC } from './config/branding.js';
import './styles.css';
import './commerce.css';

document.querySelector('link[rel="icon"]').href = LOGO_SRC;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <VoucherReadinessProvider><CommerceProvider><App /></CommerceProvider></VoucherReadinessProvider>
  </React.StrictMode>,
);
