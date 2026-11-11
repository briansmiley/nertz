import { createRoot } from 'react-dom/client';
import { App, resume } from './App';
import './styles.css';

resume(); // a reload lands back in its seat
createRoot(document.getElementById('root')!).render(<App />);
