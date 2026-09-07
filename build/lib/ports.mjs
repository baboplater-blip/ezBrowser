// ports.mjs — 하네스가 쓸 포트를 안전하게 고른다.
//
// 왜 (2026-09-07, 임무 29): 하네스마다 **고정 포트**를 박아 두었더니, 앞선 실행이 남긴
// 프로세스가 그 포트를 쥐고 있으면 다음 실행이 `EADDRINUSE` 로 죽었다(실제로 겪음).
// 죽는 것 자체보다 나쁜 것은 **원인이 앱처럼 보인다**는 점이다 — 로그엔 아무것도 안 남는다.
//
// 두 가지를 제공한다:
//   getFreePort()        OS 에게 빈 포트를 받아 온다(:0 바인딩). 우리가 여는 서버는 이걸 쓴다.
//   describePortOwner()  점유 중이면 어떤 PID 인지 알려 준다 — 실패 메시지에 붙이기 위한 것.
//
// CDP 디버그 포트는 앱을 띄울 때 인자로 줘야 해서 하네스마다 고정값을 유지한다(충돌 시
// waitForPortFree 가 PID 를 찍어 준다). 우리가 여는 HTTP 서버만 동적으로 바꾼다.

import net from 'node:net'
import { execFileSync } from 'node:child_process'

/** OS 에게 지금 비어 있는 포트를 받아 온다. 받은 뒤 바로 닫으므로 아주 짧은 경합 창은 있다. */
export function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/** 서로 다른 빈 포트 n 개. (같은 포트를 두 번 받지 않도록 순차로 잡았다 놓는다.) */
export async function getFreePorts(n) {
  const held = []
  const ports = []
  for (let i = 0; i < n; i++) {
    const srv = net.createServer()
    // 순차로 **동시에 잡고** 있다가 마지막에 모두 놓는다 — 그래야 같은 번호가 두 번 안 나온다.
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '127.0.0.1', () => { ports.push(srv.address().port); held.push(srv); resolve() })
    })
  }
  await Promise.all(held.map((s) => new Promise((r) => s.close(r))))
  return ports
}

/** 그 포트를 쥐고 있는 프로세스 설명(없으면 null). 실패 메시지용이므로 조용히 실패한다. */
export function describePortOwner(port) {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 5000 })
    const line = out.split(/\r?\n/).find((l) => /LISTENING/.test(l) && new RegExp(`[:.]${port}\\s`).test(l))
    if (!line) return null
    const pid = line.trim().split(/\s+/).pop()
    let name = ''
    try {
      const t = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', timeout: 5000 })
      name = (t.split(',')[0] ?? '').replace(/"/g, '').trim()
    } catch { /* 이름은 없어도 된다 */ }
    return name ? `PID ${pid} (${name})` : `PID ${pid}`
  } catch {
    return null
  }
}
