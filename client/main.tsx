import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resume } from './net';
import { startOutbox } from './outbox';
import { startTips } from './tip';
import './styles/index.css';

resume(); // a reload lands back in its seat
startOutbox(); // feedback kept while offline goes once it can
startTips(); // the game's own tooltips, for every data-tip
createRoot(document.getElementById('root')!).render(<App />);
