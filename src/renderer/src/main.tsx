import './browserFallback';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/bricolage-grotesque';
import '@fontsource-variable/instrument-sans';
import '@fontsource/martian-mono/400.css';
import '@fontsource/martian-mono/500.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './design/global.css';
import './nexus/styles/index.css';

// The Nexus mark: a plain ink square (favicon) and the "Nexus" wordmark (boot
// splash), both drawn from the --nx-* tokens. No illustration, no portrait.
const ink = getComputedStyle(document.documentElement).getPropertyValue('--nx-ink').trim() || 'currentColor';
const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/svg+xml';
favicon.href = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="2" y="2" width="12" height="12" rx="2" fill="${ink}"/></svg>`
);
document.head.appendChild(favicon);

const splashMark = document.querySelector('#cth-splash .mk');
if (splashMark) {
  const mark = document.createElement('div');
  mark.className = 'nx-boot-mark';
  mark.textContent = 'Nexus';
  splashMark.replaceWith(mark);
}

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
