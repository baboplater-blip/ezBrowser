import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary scope="외피">
    <App />
  </ErrorBoundary>,
)
