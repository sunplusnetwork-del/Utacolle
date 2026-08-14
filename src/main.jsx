import React from 'react';
import ReactDOM from 'react-dom/client';
import App, { SongFormPopup } from './App.jsx';

const isSongFormPopup = new URLSearchParams(window.location.search).get('popup') === 'songform';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isSongFormPopup ? <SongFormPopup /> : <App />}
  </React.StrictMode>
);
