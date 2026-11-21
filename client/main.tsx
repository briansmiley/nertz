import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resume } from './net';
import './styles/index.css';

resume(); // a reload lands back in its seat
createRoot(document.getElementById('root')!).render(<App />);
