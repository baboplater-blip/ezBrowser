import { useEffect, useState } from 'react'

interface Props {
  open: boolean
  onClose: () => void
}

export function UserChromePanel({ open, onClose }: Props) {
  const [css, setCss] = useState('')
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    if (!open) return
    void window.browserAPI.userchrome.get().then((state) => {
      setCss(state.cssContent)
      setEnabled(state.cssEnabled)
      setError(state.lastError)
    })
    const off = window.browserAPI.userchrome.onChanged(({ css, cssEnabled, lastError }) => {
      setCss(css)
      setEnabled(cssEnabled)
      setError(lastError)
    })
    return off
  }, [open])

  if (!open) return null

  return (
    <div className="sidepanel right" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sidepanel-header">
        <span>userChrome.css</span>
        <button className="icon-btn" onClick={onClose} aria-label="닫기">×</button>
      </div>
      <div className="sidepanel-body">
        <div className="row">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => window.browserAPI.settings.set('freedom.userChromeCss', e.target.checked)}
            />
            {' '}활성화
          </label>
          <button onClick={() => window.browserAPI.userchrome.open('css')}>외부 에디터로 열기</button>
          <button onClick={() => window.browserAPI.userchrome.reload()}>핫리로드</button>
        </div>
        {error && <div className="error">⚠️ {error}</div>}
        <textarea
          className="userchrome-editor"
          value={css}
          onChange={(e) => setCss(e.target.value)}
          spellCheck={false}
        />
        <div className="row">
          <button
            className="primary"
            onClick={() => window.browserAPI.userchrome.update('css', css)}
          >
            저장 + 적용
          </button>
        </div>
        <details className="hint">
          <summary>사용 가능한 안전 셀렉터·변수</summary>
          <pre>
{`.tabbar, .tab, .tab.active, .tab.pinned
.toolbar, .omnibox, .omnibox-suggestions
.sidepanel.left, .sidepanel.right
.command-palette

--color-bg-base, --color-bg-elevated, --color-bg-sunken
--color-text-primary, --color-text-secondary
--color-accent-primary
--tab-active-bg, --tab-inactive-bg
--density-tabbar-h, --density-toolbar-h`}
          </pre>
        </details>
      </div>
    </div>
  )
}
