import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyStoredTheme } from './theme.js';
import './styles.css';

// public/theme-init.js set the saved theme before the first paint; this
// confirms it and sets the window frame colour.
applyStoredTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
