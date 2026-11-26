import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resume } from './net';
import { startOutbox } from './outbox';
import { startTips } from './tip';
import './styles/index.css';

// The built game is kept by a service worker (public/sw.js): it loads, and plays offline, with no network.
if (import.meta.env.PROD && 'serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
resume(); // a reload lands back in its seat
startOutbox(); // feedback that could not be sent goes once it can
startTips(); // the game's own tooltips, for every data-tip
createRoot(document.getElementById('root')!).render(<App />);
