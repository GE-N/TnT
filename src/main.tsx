import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './style.css';
import './knowledge.css';

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
