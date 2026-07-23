// bootstrap-userdata.ts — `--user-data-dir=<path>` 지원.
//
// 반드시 index.ts 의 가장 첫 import 여야 한다. electron-store(Conf) 는 프로세스 안에서
// 처음 `new Store(...)` 가 생성되는 시점에 `app.getPath('userData')` 를 1회 캡처해 이후
// 재사용한다(electron-store/index.js 의 initDataListener). 즉, settings.ts 등 다른 모듈이
// import 되어 top-level 에서 Store 를 생성하기 전에 이 경로 오버라이드가 끝나 있어야 한다.
// CommonJS 는 import 문 등장 순서대로 require() 되므로, index.ts 최상단에 두면 보장된다.
//
// 플래그가 없으면 완전히 no-op — 기존 동작과 100% 동일 (실사용자 프로필 그대로 사용).
import { app } from 'electron'
import path from 'node:path'

const PREFIX = '--user-data-dir='
const arg = process.argv.find((a) => a.startsWith(PREFIX))
if (arg) {
  const dir = path.resolve(arg.slice(PREFIX.length))
  app.setPath('userData', dir)
}
