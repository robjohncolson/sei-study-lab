import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { DraftNavigation } from './DraftNavigation';
import './styles.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><DraftNavigation><App /></DraftNavigation></React.StrictMode>);
