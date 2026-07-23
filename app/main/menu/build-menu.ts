import { Menu, type MenuItemConstructorOptions } from 'electron'
import { findKeyFor } from '../keymap/keymap-service'
import { runAction } from '../actions/registry'

function item(label: string, actionId: string, getWindowId: () => string | undefined): MenuItemConstructorOptions {
  const accelerator = findKeyFor(actionId)
  return {
    label,
    accelerator,
    click: () => { void runAction(actionId, { windowId: getWindowId() }) },
  }
}
const sep: MenuItemConstructorOptions = { type: 'separator' }

// 상단 네이티브 메뉴바 — 브라우저의 모든 기능을 Adobe 식으로 논리적 메뉴/하위메뉴에 정리해 발견성을 높인다.
// 모든 항목은 actionId 로 연결(단축키 자동 표시). 새 기능을 추가하면 여기에도 배치할 것.
export function buildAppMenu(getWindowId: () => string | undefined): Menu {
  const I = (label: string, id: string) => item(label, id, getWindowId)
  const template: MenuItemConstructorOptions[] = [
    {
      label: '파일',
      submenu: [
        I('새 탭', 'action.tab.new'),
        I('새 창', 'action.window.new'),
        I('새 시크릿 창', 'action.window.incognito'),
        sep,
        I('탭 복제', 'action.tab.duplicate'),
        I('탭 고정 / 해제', 'action.tab.pin'),
        I('탭 닫기', 'action.tab.close'),
        sep,
        I('최근 닫은 탭', 'action.tab.recentClosed'),
        I('마지막 탭 복원', 'action.tab.restore'),
        sep,
        {
          label: '워크스페이스',
          submenu: [
            I('새 워크스페이스', 'action.workspace.new'),
            I('다음 워크스페이스', 'action.workspace.next'),
            I('이전 워크스페이스', 'action.workspace.prev'),
            sep,
            I('탭을 다음 스페이스로', 'action.tab.move.next.workspace'),
            I('탭을 이전 스페이스로', 'action.tab.move.prev.workspace'),
          ],
        },
        sep,
        I('인쇄', 'action.page.print'),
        I('PDF로 저장', 'action.page.printPdf'),
        sep,
        I('종료', 'action.app.quit'),
      ],
    },
    {
      label: '편집',
      submenu: [
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        sep,
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '모두 선택' },
        sep,
        I('페이지에서 찾기', 'action.find.toggle'),
        I('주소창', 'action.omnibox.focus'),
        sep,
        I('폼 자동 채우기 (내 정보)', 'action.autofill.page'),
        I('비밀번호 관리자', 'action.password.open'),
      ],
    },
    {
      label: '보기',
      submenu: [
        I('새로고침', 'action.page.reload'),
        I('중지', 'action.page.stop'),
        sep,
        I('확대', 'action.page.zoom.in'),
        I('축소', 'action.page.zoom.out'),
        I('기본 배율', 'action.page.zoom.reset'),
        sep,
        I('리더 모드', 'action.tab.reader'),
        {
          label: '다크 모드',
          submenu: [
            I('페이지 강제 다크 토글', 'action.darkmode.toggle'),
            I('이 사이트만 다크 토글', 'action.darkmode.toggleSite'),
            I('OS 설정 따라가기', 'action.darkmode.followSystem'),
          ],
        },
        sep,
        {
          label: '사이드 패널',
          submenu: [
            I('왼쪽 패널 토글', 'action.sidepanel.left.toggle'),
            I('오른쪽 패널 토글', 'action.sidepanel.right.toggle'),
          ],
        },
        I('북마크 바 표시 / 숨김', 'action.bookmark.bar.toggle'),
        sep,
        { role: 'togglefullscreen', label: '전체 화면' },
        I('개발자 도구', 'action.devtools.toggle'),
      ],
    },
    {
      label: '탐색',
      submenu: [
        I('뒤로', 'action.nav.back'),
        I('앞으로', 'action.nav.forward'),
        sep,
        I('다음 탭', 'action.tab.next'),
        I('이전 탭', 'action.tab.prev'),
        I('탭 검색', 'action.tab.search'),
        sep,
        {
          label: '화면 분할 (타일링)',
          submenu: [
            I('좌우 분할', 'action.pane.split.h'),
            I('상하 분할', 'action.pane.split.v'),
            I('분할 해제', 'action.pane.unsplit'),
            I('다음 분할창 포커스', 'action.pane.focus.next'),
          ],
        },
        I('탭바 위치 순환 (상/좌/우)', 'action.tabbar.cycle'),
      ],
    },
    {
      label: '북마크',
      submenu: [
        I('이 페이지 북마크', 'action.bookmark.add'),
        I('북마크 관리', 'action.bookmark.list'),
        I('북마크 바 표시 / 숨김', 'action.bookmark.bar.toggle'),
        sep,
        I('읽기 목록에 추가', 'action.readlater.add'),
        I('읽기 목록 열기', 'action.readlater.open'),
        sep,
        I('방문 기록', 'action.history.open'),
        I('방문 기록 삭제', 'action.history.clear'),
      ],
    },
    {
      label: 'AI',
      submenu: [
        I('AI 어시스턴트 열기', 'action.ai.open'),
        I('이 페이지 요약', 'action.ai.summarize'),
        sep,
        I('✍️  블로그 글쓰기 스튜디오', 'action.ai.write'),
        I('📥  매일 자동 수집 (피드 수집기)', 'action.ai.collectors'),
        sep,
        I('🧠  AI 기억 관리', 'action.memory.open'),
      ],
    },
    {
      label: '도구',
      submenu: [
        I('명령 팔레트', 'action.palette.open'),
        sep,
        I('페이지 번역', 'action.translate.page'),
        I('화면 캡처', 'action.screenshot.viewport'),
        I('QR 코드', 'action.qrcode.show'),
        sep,
        I('다운로드', 'action.downloads.openPage'),
        I('확장 프로그램', 'action.extensions.open'),
        sep,
        {
          label: '광고 차단',
          submenu: [
            I('광고차단 통계', 'action.adblock.openPage'),
            I('이 사이트 광고차단 토글', 'action.adblock.toggleSite'),
          ],
        },
        I('이 사이트 데이터 삭제', 'action.sitedata.clear'),
      ],
    },
    {
      label: '커스터마이즈',
      submenu: [
        I('userChrome.css 편집', 'action.userchrome.edit'),
        I('userChrome 재적용', 'action.userchrome.reload'),
        sep,
        I('유저스크립트', 'action.userscript.toggle'),
        I('사이트 정책 엔진', 'action.policy.open'),
        I('자동화 매크로', 'action.macros.open'),
        I('확장형 Mod', 'action.mods.open'),
        sep,
        I('단축키 편집', 'action.keymap.open'),
        I('성능 게이트', 'action.perf.open'),
      ],
    },
    {
      label: '⚙ 설정',
      submenu: [
        I('설정 열기', 'action.settings.open'),
        sep,
        I('단축키 편집', 'action.keymap.open'),
        I('확장 프로그램', 'action.extensions.open'),
        I('비밀번호 관리자', 'action.password.open'),
        sep,
        I('광고 차단 통계', 'action.adblock.openPage'),
        I('성능 게이트', 'action.perf.open'),
      ],
    },
    {
      label: '도움말',
      submenu: [
        I('업데이트 확인', 'action.update.check'),
        I('피드백 보내기', 'action.help.report'),
      ],
    },
  ]
  return Menu.buildFromTemplate(template)
}
