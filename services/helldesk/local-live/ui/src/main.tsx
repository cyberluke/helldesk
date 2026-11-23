import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import '@fontsource-variable/manrope'
import '@fontsource-variable/jetbrains-mono'
// xterm ships its own stylesheet. Without it the terminal has no layout and its
// hidden input helper (.xterm-helper-textarea) leaks as a native textarea — the
// "doubled input" in the FrontDesk dock. Import BEFORE the app theme so local
// `.xterm` overrides still win.
import '@xterm/xterm/css/xterm.css'
import './index.css'
import './tailwind.css'
import './connections.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
