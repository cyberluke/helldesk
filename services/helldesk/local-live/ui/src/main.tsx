import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@fontsource-variable/manrope'
import '@fontsource-variable/jetbrains-mono'
import './index.css'
import './tailwind.css'
import './connections.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
