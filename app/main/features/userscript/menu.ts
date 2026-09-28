// GM_registerMenuCommand 백엔드(item 7). 콜백 함수 자체는 격리 월드 안에 남고(IPC 로 함수를
// 직렬화할 수 없으므로), 메인은 "라벨" 만 들고 있다가 사용자가 실행을 요청하면 그 탭으로
// menuRunEvent 를 보내 격리 월드 쪽 로컬 맵에서 fn 을 찾아 호출하게 한다.
//
// UI 노출(툴바 아이콘·명령 팔레트 항목)은 이 묶음의 소유 파일 범위 밖(툴바=ui-designer,
// 명령 팔레트=command-palette-developer) 이라 생략했다 — 백엔드 레지스트리 + IPC(menuList/menuRun)
// 는 완성돼 있으니, 다른 묶음이 이 두 채널을 팔레트/툴바에 연결하면 그대로 동작한다.

export interface MenuCommand {
  id: string
  scriptId: string
  scriptName: string
  label: string
  tabId: string // 어느 콘텐츠 탭(webContentsId 아님, 우리 tabId)에 등록됐는지
}

let counter = 0
// tabId 가 바뀔 일 없는 짧은 수명 레지스트리 — 탭이 다른 URL 로 이동하면(=격리 월드가 새로 생기면)
// 그 탭 소속 항목을 비운다. 소유자(index.ts)가 navigate 훅에서 clearForTab 을 호출해야 한다.
const commands = new Map<string, MenuCommand>()

export function registerMenuCommand(scriptId: string, scriptName: string, label: string, tabId: string): string {
  counter += 1
  const id = `mc-${Date.now().toString(36)}-${counter}`
  commands.set(id, { id, scriptId, scriptName, label: String(label).slice(0, 120), tabId })
  return id
}

export function listMenuCommands(tabId?: string): MenuCommand[] {
  const all = Array.from(commands.values())
  return tabId ? all.filter((c) => c.tabId === tabId) : all
}

export function getMenuCommand(id: string): MenuCommand | null {
  return commands.get(id) ?? null
}

export function clearForTab(tabId: string): void {
  for (const [id, c] of commands) {
    if (c.tabId === tabId) commands.delete(id)
  }
}
