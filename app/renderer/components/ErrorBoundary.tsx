import React from 'react'
import { t } from '../i18n'

/**
 * 외피 오류 경계.
 *
 * 왜 (2026-09-07, 임무 22): 외피에는 오류 경계가 없었다. 컴포넌트가 렌더 중 한 번만 던져도
 * React 가 트리 전체를 언마운트해 **탭바·주소창이 통째로 사라진 흰 외피**가 된다.
 * 회귀 #8(preload 경로)·#9(sandbox 번들)에서 실제로 겪은 실패 모습이 바로 이것이고,
 * 그때는 원인이 부팅이었지만 렌더 중 예외로도 같은 화면이 나온다.
 *
 * 사용자가 창을 잃지 않도록, 트리를 통째로 버리는 대신 **그 자리만** 좁은 안내로 바꾼다.
 * `scope` 는 어디가 무너졌는지 나타내는 i18n 키(예: "ui.errorBoundary.scope.sidePanel").
 * 알려지지 않은 값이 오면 원문 그대로 콘솔·안내문에 쓴다(디버그 목적, 번역 없음).
 */

// 알려진 scope 키 → 한국어 fallback. 새 scope 를 추가하면 여기에도 등록할 것(사전에 키가
// 아직 없어도 화면이 깨지지 않게).
const SCOPE_FALLBACK: Record<string, string> = {
  'ui.errorBoundary.scope.default': '외피',
  'ui.errorBoundary.scope.sidePanel': '사이드 패널',
  'ui.errorBoundary.scope.videoPanel': '동영상 패널',
  'ui.errorBoundary.scope.downloadPanel': '다운로드 패널',
}

function scopeLabel(scope?: string): string {
  const key = scope || 'ui.errorBoundary.scope.default'
  const fallback = SCOPE_FALLBACK[key] ?? key
  return key.startsWith('ui.errorBoundary.scope.') ? t(key, fallback) : fallback
}

type Props = { children: React.ReactNode; scope?: string; compact?: boolean }
type State = { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // 메인 로그(userData/logs)에도 남도록 콘솔로 보낸다 — 외피 콘솔은 DevTools 로 열어 본다.
    console.error(`[외피 오류: ${this.props.scope ?? '외피'}]`, error, info.componentStack)
  }

  private retry = (): void => { this.setState({ error: null }) }

  override render(): React.ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    const where = scopeLabel(this.props.scope)
    return (
      <div className={`error-boundary${this.props.compact ? ' compact' : ''}`} role="alert">
        <div className="eb-title">⚠ {t('ui.errorBoundary.title', '{where}에 오류가 발생했습니다', { where })}</div>
        <div className="eb-msg">{String(error.message || error)}</div>
        <div className="eb-actions">
          <button type="button" onClick={this.retry}>{t('ui.errorBoundary.retry', '다시 시도')}</button>
          <button type="button" onClick={() => location.reload()}>{t('ui.errorBoundary.reload', '외피 새로고침')}</button>
        </div>
        <div className="eb-hint">{t('ui.errorBoundary.hint', '열린 탭과 페이지는 그대로 있습니다.')}</div>
      </div>
    )
  }
}
