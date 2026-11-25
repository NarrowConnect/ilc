import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import AppUpdatePrompt from './components/AppUpdatePrompt.jsx';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
    <AppUpdatePrompt />
  </React.StrictMode>
);
