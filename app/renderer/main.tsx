import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { initI18n } from './i18n'
import './styles.css'

// 현재 언어 사전 청크를 받은 뒤 첫 렌더 — 로컬 파일이라 수 ms 이고, 실패해도 원문으로 그린다.
void initI18n().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <ErrorBoundary scope="ui.errorBoundary.scope.default">
      <App />
    </ErrorBoundary>,
  )
})
