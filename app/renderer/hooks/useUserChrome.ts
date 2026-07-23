import { useEffect } from 'react'

export function useUserChrome(): void {
  useEffect(() => {
    const styleId = 'userchrome-style'
    let style = document.getElementById(styleId) as HTMLStyleElement | null
    if (!style) {
      style = document.createElement('style')
      style.id = styleId
      document.head.appendChild(style)
    }
    function apply(css: string, enabled: boolean) {
      if (style) style.textContent = enabled ? css : ''
    }

    void window.browserAPI.userchrome.get().then((state) => {
      apply(state.cssContent, state.cssEnabled)
    })

    const off = window.browserAPI.userchrome.onChanged(({ css, cssEnabled }) => {
      apply(css, cssEnabled)
    })
    return off
  }, [])
}
