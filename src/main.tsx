import './ui/styles.css';
import { createRoot } from 'react-dom/client';
import { App } from './ui/App';
import { GuestApp } from './ui/GuestApp';

const q = new URLSearchParams(location.search);
const guest = q.has('join') || q.get('role') === 'display' || q.get('role') === 'remote' || q.get('role') === 'viewer';
createRoot(document.getElementById('root')!).render(guest ? <GuestApp /> : <App />);
