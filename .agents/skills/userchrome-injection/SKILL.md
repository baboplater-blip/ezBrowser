---
name: userchrome-injection
description: userChrome.css / userChrome.js 주입·핫리로드 절차. 안전 셀렉터 카탈로그 유지, JS 격리 컨텍스트, fs.watch 디바운스.
---

# userChrome 주입

## 파일

```
{userData}/userChrome.css
{userData}/userChrome.js   # opt-in, settings.freedom.userChromeJs
```

설정에서 "에디터로 열기" 버튼 → `shell.openPath(filePath)`.

## 메인 프로세스 — 읽기 + 감시

```ts
import { promises as fs, watch } from 'node:fs'
import path from 'node:path'

const CSS_PATH = path.join(app.getPath('userData'), 'userChrome.css')
const JS_PATH  = path.join(app.getPath('userData'), 'userChrome.js')

let cssCache = ''
let jsCache  = ''
let cssWatcher: ReturnType<typeof watch> | null = null

async function loadCss() {
  try { cssCache = await fs.readFile(CSS_PATH, 'utf8') }
  catch { cssCache = '' }
}

const debouncedReload = debounce(async () => {
  await loadCss()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('userchrome:css', cssCache)
  }
}, 200)

function startWatch() {
  // 파일 없으면 생성 (에디터에서 열 수 있게)
  fs.access(CSS_PATH).catch(() => fs.writeFile(CSS_PATH, '/* userChrome.css — 외피 CSS 주입 */\n'))
  cssWatcher?.close()
  cssWatcher = watch(CSS_PATH, () => debouncedReload())
}

app.whenReady().then(async () => {
  await loadCss()
  startWatch()
})
```

## 외피 렌더러 — 적용

```ts
// preload 노출
contextBridge.exposeInMainWorld('browserAPI', {
  ...
  onUserChromeCss: (cb: (css: string) => void) => {
    ipcRenderer.on('userchrome:css', (_, css) => cb(css))
  },
})

// renderer 부팅
function applyUserCss(css: string) {
  let style = document.getElementById('userchrome-style') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'userchrome-style'
    document.head.appendChild(style)
  }
  style.textContent = css
}

browserAPI.onUserChromeCss(applyUserCss)
browserAPI.userchrome.getCss().then(applyUserCss)  // 초기 로드
```

## userChrome.js (opt-in, 위험)

```ts
async function loadJs() {
  if (!settings.freedom.userChromeJs) return ''
  try { return await fs.readFile(JS_PATH, 'utf8') } catch { return '' }
}

// renderer
ipcRenderer.on('userchrome:js', (_, js) => {
  try {
    const fn = new Function('browserAPI', js)
    fn(window.browserAPI)
  } catch (e) {
    console.error('[userChrome.js]', e)
    showToast('userChrome.js 오류: ' + (e as Error).message)
  }
})
```

`require`, `process`, `electron` 절대 노출 금지. `Function` 생성자가 글로벌만 접근.

## 안전 셀렉터 카탈로그 (계약)

`ui-designer` 와 합의된 셀렉터/변수는 절대 변경 금지. 변경 필요 시:
1. 새 이름 추가 + 옛 이름 별칭(`@supports selector(...)` 또는 SCSS extend)
2. 1버전 deprecation 안내
3. 다음 버전에 제거

핵심 셀렉터:
```
.tabbar, .tab, .tab.active, .tab.pinned
.toolbar, .omnibox, .omnibox-suggestions
.sidepanel.left, .sidepanel.right
.command-palette
--color-*, --density-*, --tab-*
```

## 에러 처리

CSS 파싱 에러는 브라우저가 무시 (잘못된 룰만 무시). JS 에러는 toast + 콘솔.

설정 페이지에 "userChrome 로그" 탭 (최근 100줄).

## 절대 피할 것

- JS 에서 메인 프로세스 require — `browserAPI` 게이트만
- 핫리로드 무한 루프 (renderer 가 CSS 수정 → 파일 변경) — renderer 는 적용만, 파일 write 안 함
- fs.watch 디바운스 없이 — 파일 저장 시 다중 fire
- 안전 셀렉터 이름 임의 변경 — 사용자 CSS 깨짐
- 보안 약화 (sandbox/contextIsolation off) 를 userChrome 옵션으로 — 절대 금지
