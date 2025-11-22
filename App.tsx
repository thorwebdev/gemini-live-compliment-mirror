import React from 'react';
import { MagicMirror } from './components/MagicMirror';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-900 overflow-hidden relative">
      <div className="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] opacity-30 pointer-events-none"></div>
      <MagicMirror />
    </div>
  );
};

export default App;