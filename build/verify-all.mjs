#!/usr/bin/env node
// verify-all.mjs — 흩어져 있는 검증 하네스를 하나의 게이트로 묶는 통합 러너.
//
// 왜 필요한가 (2026-09-06, auto-dev 임무 A 에서 드러난 구멍):
//   스모크·에이전트 안전·다운로드·확장·성능·스트레스·복원 하네스가 각각 따로 존재해서,
//   라운드마다 "무엇을 돌려야 하는지"를 사람이 기억해야 했다. 실제로 묶음 YTDLP-1 은
//   게이트 0(typecheck·build)만 돌고 끝났고, 그 상태가 미검증으로 남았다.
//   기억에 의존하는 게이트는 게이트가 아니다 — 목록을 코드로 고정한다.
//
// 사용:
//   node build/verify-all.mjs --quick        # 게이트 0 + 스모크 (라운드 기본)
//   node build/verify-all.mjs --full         # 전 하네스 (20~40분, 네트워크 사용)
//   node build/verify-all.mjs --only smoke,perf
//   node build/verify-all.mjs --list         # 등록된 단계 목록만 출력
//   옵션: --skip-build (게이트 0 생략 — 이미 빌드된 상태에서 재실행)
//         --out <dir>  (결과·로그 루트, 기본 verify-out/all)
//         --keep-going (게이트 0 실패해도 남은 단계 계속)
//
// 종료 코드: 0 = 전부 통과 / 1 = 하나 이상 실패·타임아웃 / 2 = 러너 치명적 오류(전제 불충족)
//
// 설계 원칙:
//   - 하네스를 고치지 않고 **감싸기만** 한다. 각 하네스의 종료 코드(0/1/2)가 1차 판정,
//     결과 JSON 이 있으면 PASS/FAIL 개수를 2차로 읽어 표에 채운다.
//   - 하네스는 전부 앱을 spawn 하므로 **순차 실행**한다(포트·프로필·창 포커스 충돌 방지).
//   - 단계마다 **회수 시계**(timeout)를 둔다. 정체된 하네스가 러너 전체를 잡아먹지 않게.

import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const EXE = path.join(REPO_ROOT, 'dist', 'win-unpacked', 'ezBrowser.exe')

// ── 단계 등록부 ─────────────────────────────────────────────────────────
//
// kind: 'cmd'     — 셸 명령 (게이트 0)
//       'harness' — build/*.mjs 하네스 (앱 spawn, exe 필요)
// outArg: true 면 러너가 --out <루트>/<id> 를 넘긴다. false 면 하네스 고정 경로를 읽는다.
// result: 결과 JSON 경로를 돌려주는 함수 (없으면 종료 코드만으로 판정)

function steps(outRoot) {
  const at = (id, file) => path.join(outRoot, id, file)
  const fixed = (file) => path.join(REPO_ROOT, 'verify-out', file)
  return [
    {
      id: 'typecheck', kind: 'cmd', modes: ['quick', 'full'], gate0: true,
      cmd: 'npm', args: ['run', 'typecheck'], timeoutMs: 5 * 60000,
      desc: 'tsc --noEmit x3 (main/preload/renderer)',
    },
    {
      id: 'build', kind: 'cmd', modes: ['quick', 'full'], gate0: true,
      cmd: 'npm', args: ['run', 'build'], timeoutMs: 10 * 60000,
      desc: 'tokens/icon/vite/tsc/esbuild',
    },
    {
      id: 'package', kind: 'cmd', modes: ['quick', 'full'], gate0: true,
      cmd: 'npx', args: ['electron-builder', '--win', '--dir'], timeoutMs: 15 * 60000,
      desc: 'win-unpacked (하네스가 구동할 exe)', preflight: preflightPackage,
    },
    {
      id: 'smoke', kind: 'harness', modes: ['quick', 'full'],
      script: 'smoke-cdp.mjs', outArg: true, result: (o) => path.join(o, 'smoke', 'smoke-results.json'),
      timeoutMs: 10 * 60000, desc: '게이트 1 스모크 16종',
    },
    {
      // 정적 검사라 즉시 끝난다. 한글 옆 \b 는 겉보기엔 멀쩡한 채 죽어 있어
      // 사람 눈으로는 안 보인다 — 그래서 매 라운드 기계가 본다.
      id: 'korean-regex', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-korean-regex.mjs', outArg: true,
      result: (o) => path.join(o, 'korean-regex', 'korean-regex-results.json'),
      timeoutMs: 2 * 60000, desc: '한글에서 성립하지 않는 정규식 가정(단어경계·w) K1~K2',
    },
    {
      // 순수 함수 — 발행글이 마크다운 기호로 깨지던 사고의 회귀 검사. 즉시 끝나므로 quick 에도 둔다.
      id: 'editor-text', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-editor-text.mjs', outArg: true,
      result: (o) => path.join(o, 'editor-text', 'editor-text-results.json'),
      timeoutMs: 2 * 60000, desc: '마크다운→에디터 평문 변환(누출 0·내용 보존) M1~M5',
    },
    {
      // 순수 함수 — 같은 글에 두 번 손대지 않는다는 방어. 주소 정규화가 느슨해지면 중복 댓글이,
      // 과해지면 남의 글을 건너뛴다. 양쪽을 다 본다(검출력 확인 2026-09-18: 정규화를 무력화하니 4건 FAIL).
      id: 'engage-ledger', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-engage-ledger.mjs', outArg: false,
      result: (o) => path.join(o, '..', 'engage-ledger', 'results.json'),
      timeoutMs: 2 * 60000, desc: '블로그 참여 중복 방지·주소 정규화·한도/간격/기한 코드가드 54종',
    },
    {
      // 순수 함수 — "사용자가 승인한 범위 안에서만 확인 없이 게시한다" 는 판정. 이게 느슨해지면
      // 승인하지 않은 계정·플랫폼·건수로 **되돌릴 수 없는 게시**가 나간다(양성 대조 포함).
      // 검출력 확인 2026-09-18: 계정 범위·선승인 이전 작업 검사를 무력화하니 3건 FAIL.
      id: 'auto-publish', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-auto-publish.mjs', outArg: false,
      result: (o) => path.join(o, '..', 'auto-publish', 'results.json'),
      timeoutMs: 2 * 60000, desc: '자동 게시 선승인 판정·배선 33종(양성 대조 포함, 공개 API 경로 실행)',
    },
    {
      // 순수 함수 — "만들어 둔 초안을 다시 만들지 않고 게시로 올린다" 의 **게이트 판정**.
      // 그 끝에 있는 것이 되돌릴 수 없는 게시라, 두 가지가 동시에 지켜져야 한다: ①올려도 되는 것만
      // 올린다(이미 게시된 것·게시 중·불확실·계정 없음·이미지 사라짐은 거부) ②사용자가 **확인한
      // 그것**만 올린다(캡션·계정·이미지가 바뀌면 옛 확인은 무효, 확인은 1회용).
      // 검출력 확인 2026-09-19: 계정 검사와 바인딩 지문(캡션·계정)을 무력화하니 7건 FAIL —
      // 그중 2건은 **바뀐 캡션으로 실제 게시가 나가는 것**을 잡았다.
      id: 'draft-promotion', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-draft-promotion.mjs', outArg: false,
      result: (o) => path.join(o, '..', 'draft-promotion-pure', 'results.json'),
      timeoutMs: 2 * 60000, desc: '초안→게시 승격 게이트 80종(거부 20경로·1회용 확인·바인딩·되돌리기·재시작 보존)',
    },
    {
      // 위 판정이 **실제 앱에서 사용자가 누르는 경로로도** 같은 결론을 내는가. 순수 판정만 초록이면
      // 화면이 버튼을 안 보여 주거나, 확정이 게시까지 닿지 못해도 아무도 모른다.
      // 로컬 HTTPS 픽스처(www.instagram.com → 127.0.0.1, --host-resolver-rules)에 **실제로 1건이
      // 도착하는지**를 바이트(sha256)로 확인하고, 취소(0건)와 확정(1건)의 대조를 같은 실행에서 본다.
      // 강제 종료 2회(확정 전 · 발송 후)를 포함하므로 부팅이 3번이다 — 그래서 full 에만 둔다.
      id: 'draft-promotion-e2e', kind: 'harness', modes: ['full'],
      script: 'verify-draft-promotion-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'results.json'),
      timeoutMs: 15 * 60000, desc: '초안→게시 승격 e2e DP1~DP11(실제 UI 클릭·실제 게시 1건·재시작 2회)',
    },
    {
      // 실제 앱 + 실제 UI 클릭 → IPC. 확인 단계에서 계정을 고칠 수 있는가(이미지·캡션을 지키면서),
      // 그리고 **고치면 안 되는 상태에서 거부되는가**. 계정은 "이 글이 내 글인가" 를 가르는 판정
      // 축이라, 게시 뒤에 바뀌면 남의 글을 내 글로 세거나 중복 게시로 이어진다.
      // 영수증 ✅/⚠ 가 **글 본문 낱말**이 아니라 구조화된 상태값으로 갈리는지도 같은 화면에서 본다.
      id: 'social-account', kind: 'harness', modes: ['full'],
      script: 'verify-social-account-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'results.json'),
      timeoutMs: 12 * 60000, desc: '확인 단계 계정 편집·영수증 상태 표시 SA1~SA8(재시작 보존 포함)',
    },
    {
      // 순수 함수(자식 프로세스로 시간대 4곳에서 각각 실행) — 게시 여부 판정의 **시각 축**이
      // 기계의 시간대에 좌우되지 않는가. 오프셋 없는 `<time datetime>` 을 Date.parse 로 읽으면
      // 같은 글이 PC 마다 "새 글"/"지난 글" 로 갈리고, 그 결과는 **중복 게시**나 **안 올라간 글의
      // 완료 처리**다. 옛 방식이 실제로 시간대마다 달랐다는 근거(T1)도 매 실행 함께 찍는다.
      id: 'post-time', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-post-time.mjs', outArg: false,
      result: (o) => path.join(o, '..', 'post-time', 'results.json'),
      timeoutMs: 2 * 60000, desc: '게시 시각 판정 시간대 독립성 34종(시간대 4곳 교차 대조·주입소스 드리프트 포함)',
    },
    {
      // 순수 함수 — 저장이 실패했는데도 **되돌릴 수 없는 게시**가 나가는 것을 막는 경계, 그리고
      // "모델이 게시됐다고 말한 것"과 "런타임이 화면에서 실제로 본 것"을 가르는 근거 판정.
      // 이 둘이 조용히 느슨해지면 ①상황을 설명할 기록 없이 글이 올라가거나 ②안 올라간 글이
      // '완료'로 닫힌다 — 둘 다 사용자가 나중에야 알게 되는 종류의 손실이다.
      id: 'persistence-boundary', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-persistence-boundary.mjs', outArg: true,
      result: (o) => path.join(o, 'persistence-boundary', 'persistence-boundary-results.json'),
      timeoutMs: 2 * 60000, desc: '저장 확정 경계(직렬화·쓰기·rename 실패 주입)와 게시 확인 근거 판정',
    },
    {
      // 순수 함수 — 되돌릴 수 없는 **댓글·좋아요** 의 내구성 경계. 장부를 클릭 **전에** 디스크에
      // 확정하지 못하면 중단 한 번으로 같은 글에 두 번 달리고(좋아요는 다시 누르면 취소된다),
      // 한도 카운터가 0 으로 되돌아간다. 둘 다 사용자가 나중에야 알게 되는 손실이라 quick 에 둔다.
      // (2026-09-19: 여기서 정상 한도 파일이 매 부팅마다 '손상'으로 격리되던 결함도 함께 잡았다.)
      id: 'engage-durability', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-engage-durability.mjs', outArg: true,
      result: (o) => path.join(o, 'engage-durability', 'engage-durability-results.json'),
      timeoutMs: 2 * 60000, desc: '댓글·좋아요 장부/한도의 내구성 경계와 재시작 보존 6종',
    },
    {
      // 위 판정이 **실제 DOM 에서 나온 근거**로도 같은 결론을 내는가. 순수 판정만 초록이면
      // "화면에서 무엇을 읽어 오는가" 가 조용히 틀려도 아무도 모른다 — 특히 대부분의 사이트가
      // 전역 막대에 표시하는 **로그인한 내 계정**이 작성자로 새면, 남의 글이 내 게시 증거가 된다.
      // 앱을 띄워 진짜 브라우저 DOM 위에서 확인한다(로컬 픽스처 · 외부 접속 0).
      id: 'publish-evidence', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-publish-evidence-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'publish-evidence', 'publish-evidence-results.json'),
      timeoutMs: 6 * 60000, desc: '게시 확인 근거를 실제 DOM 에서 읽어 판정(계정·게시시각·전역라벨 배제)',
    },
    {
      // 순수 함수 — 앱 없이 즉시 끝난다. 작업 격리 경계(남의 산출물 업로드 금지)와 HTML 위장 거부는
      // 깨져도 다른 검사가 전부 초록이라, 여기서 자주 보지 않으면 조용히 새어 나간다.
      id: 'artifacts', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-artifacts.mjs', outArg: false,
      result: (o) => path.join(o, '..', 'artifacts', 'results.json'),
      timeoutMs: 2 * 60000, desc: '작업 산출물 저장소(격리 경계·실제 바이트 검증) 15종',
    },
    {
      // 순수 함수라 앱을 띄우지 않고 1초 안에 끝난다 — 마감 게이트(quick)에도 넣는다.
      // 이 판정이 느슨해지면 결제·삭제가 확인 없이 실행되므로 자주 볼수록 좋다.
      id: 'agent-gate', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-agent-gate.mjs', outArg: true,
      result: (o) => path.join(o, 'agent-gate', 'agent-gate-results.json'),
      timeoutMs: 3 * 60000, desc: '에이전트 안전 판정(돈·삭제 확인 / 발행 오탐 0) R1~R8',
    },
    {
      // 순수 함수라 앱을 띄우지 않고 1초 안에 끝난다 — 마감 게이트(quick)에도 넣는다.
      id: 'general-engage', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-general-engage.mjs', outArg: true,
      result: (o) => path.join(o, 'general-engage', 'general-engage-results.json'),
      timeoutMs: 3 * 60000, desc: '일반 작업 댓글·좋아요 구조적 판정(작성창/제출 구분·토글 인식) G1~G8',
    },
    {
      // 위 general-engage(순수 함수)가 "판정 함수가 옳은가" 를 본다면, 이건 **실제 앱**으로
      // 로컬 블로그 픽스처의 댓글·좋아요 카운터가 실제로 중복 없이 늘어나는가를 본다.
      // 응답 유실·크래시+재시작·대상 불명 시 실제 화면(UI)으로 복구까지 — 앱을 두 번 띄운다.
      id: 'general-engage-cdp', kind: 'harness', modes: ['full'],
      script: 'verify-general-engage-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'general-engage-cdp', 'results.json'),
      timeoutMs: 16 * 60000, desc: '일반 작업 댓글·좋아요 중복 방지 e2e GE1~GE9(픽스처 카운터 전후 대조·실제 UI 복구·Enter 제출 경로)',
    },
    {
      // 자연어 지시 → 생산 워크플로 라우팅 판정. 순수 함수라 앱을 안 띄우고 1초 안에 끝난다.
      // 여기가 느슨해지면 질문·금지·인용문에서 게시/댓글 작업 폼이 만들어지므로 quick 에 둔다.
      id: 'intent-routing', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-intent-routing.mjs', outArg: true,
      result: (o) => path.join(o, 'intent-routing', 'results.json'),
      timeoutMs: 3 * 60000, desc: '자연어 → 워크플로 의도 해석(긍정/질문·금지·인용 거부) I1~I8',
    },
    {
      id: 'ai-providers', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-ai-providers.mjs', outArg: true,
      result: (o) => path.join(o, 'ai-providers', 'ai-providers-results.json'),
      timeoutMs: 3 * 60000, desc: 'AI 제공자 4종 요청 형식·스트림 파싱·도구 호출 P1~P4',
    },
    {
      id: 'agent-loop', kind: 'harness', modes: ['full'],
      script: 'verify-agent-loop-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'agent-loop', 'agent-loop-results.json'),
      timeoutMs: 12 * 60000, desc: '에이전트 루프 e2e + 자료폴더 경계 + 취소 경계 L1~L9·F1~F3·CN1~CN8',
    },
    {
      id: 'passkey', kind: 'harness', modes: ['full'],
      script: 'verify-passkey-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'passkey', 'passkey-results.json'),
      timeoutMs: 8 * 60000, desc: '패스키(WebAuthn) 자동 요청 차단·사이트별 허용/차단 P1~P4',
    },
    {
      // 교차 출처 iframe 관찰·조작 + ref 키 세대/프레임 엄격 바인딩 + 로그인/CAPTCHA 사용자 인계.
      // 실측 약 3분(실제 창 구동) — quick 에는 넣지 않는다.
      id: 'frames', kind: 'harness', modes: ['full'],
      script: 'verify-frames-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'frames', 'frames-results.json'),
      timeoutMs: 12 * 60000, desc: '교차출처 iframe 조작·ref 세대 안전·로그인/CAPTCHA 인계 F1~F8·K1~K2·C1~C4',
    },
    {
      // 묶음 C(주소창·단축키): 탭전환 제안 재로드 방지·Ctrl+휠/핀치 배율 배지·표준 단축키
      // (강력새로고침·소스보기·F3/Shift+F3 찾기·Alt+Home 이 콘텐츠 포커스에서도 동작)·
      // Ctrl+D 확인없는 삭제 방지(BookmarkBubble)·bangsEnabled 설정. 로컬 서버만 쓴다.
      id: 'omnibox-shortcuts', kind: 'harness', modes: ['full'],
      script: 'verify-omnibox-shortcuts-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'omnibox-shortcuts', 'omnibox-shortcuts-results.json'),
      timeoutMs: 6 * 60000, desc: '탭전환 제안·줌 배지·콘텐츠 포커스 표준 단축키·북마크 말풍선·bang 설정 B1~R4',
    },
    {
      // 로컬 HTTPS 픽스처(자체 서명 인증서 + --ignore-certificate-errors, 검증 실행 한정)와
      // 더미 자격증명만 쓴다. 실제 사이트에 접속하지 않는다.
      id: 'saved-login', kind: 'harness', modes: ['full'],
      script: 'verify-saved-login-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'saved-login', 'saved-login-results.json'),
      timeoutMs: 15 * 60000, desc: '저장된 계정 자동 로그인 SL1~SL16(선등록·통과·재개 / 유출·오폼·2FA·취소 거부)',
    },
    {
      id: 'sns-publish', kind: 'harness', modes: ['full'],
      script: 'verify-sns-publish-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'sns-publish', 'sns-publish-results.json'),
      timeoutMs: 10 * 60000, desc: 'SNS 게시 레시피(인스타·유튜브·틱톡) + 완료 신호 S1~S6(모의 페이지)',
    },
    {
      // 최소 간격(60초)을 실제로 기다리므로 약 3분 걸린다 - 반복이 멈추는지는 기다려야만 알 수 있다.
      id: 'agent-repeat', kind: 'harness', modes: ['full'],
      script: 'verify-agent-repeat-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'agent-repeat', 'agent-repeat-results.json'),
      timeoutMs: 12 * 60000, desc: '반복 작업 횟수 제한·중단·계정활동 간격 강제 RP1~RP4',
    },
    {
      id: 'feed-collector', kind: 'harness', modes: ['full'],
      script: 'verify-feed-collector-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'feed-collector', 'feed-collector-results.json'),
      timeoutMs: 10 * 60000, desc: '피드 수집·중복 제거·키워드 필터 + 양성대조 C1~C4',
    },
    {
      // 영속 작업 런타임 — 단계 소진이 성공으로 기록되지 않는가, 일시정지가 부작용을 멈추는가,
      // 강제종료 후 이어갈 수 있는가. 강제종료·재기동을 포함하므로 앱을 여러 번 띄운다.
      id: 'task-runtime', kind: 'harness', modes: ['full'],
      script: 'verify-task-runtime-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'task-runtime', 'task-runtime-results.json'),
      timeoutMs: 16 * 60000, desc: '영속 작업: 구간 분할·일시정지·이어가기·복원·예산·중복쓰기 T1~T15',
    },
    {
      // 생성→캡션→게시 워크플로가 **프로세스 재시작을 넘기는가**. 강제종료 뒤 다시 띄워
      // ①생성 기준선이 살아남아 광고가 아니라 생성물을 집는가 ②캡션 중단이 안내·재시도로 이어지는가
      // ③게시 여부가 불확실할 때 중복 게시 없이 멈추는가. 앱을 두 번씩 띄우므로 full 에만 둔다.
      id: 'recovery', kind: 'harness', modes: ['full'],
      script: 'verify-recovery-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'recovery', 'recovery-results.json'),
      timeoutMs: 16 * 60000, desc: '중단 후 복구: 기준선 영속·캡션 재시도·게시 불확실 R1~R3',
    },
    {
      // 네트워크·제공자 오류와 사람 인계를 **실제 앱**으로. recovery(위)가 게시 워크플로의 재시작을
      // 본다면, 여기는 **영속 작업 런타임의 재시도 정책과 대기 사유**를 본다.
      // 지키는 것 둘: ①되돌릴 수 없는 것을 이미 했으면 자동 재시도하지 않고 사람에게 넘긴다
      // ②왜 멈췄는지(로그인·CAPTCHA·승인 대기)가 재시작을 넘어 남고, 이어가기가 승인이 되지 않는다.
      // 양성 대조(읽기 전용·미커밋은 그대로 재시도)를 함께 둬 "재시도를 통째로 꺼서" 통과하는 것을 막는다.
      id: 'interruption-recovery', kind: 'harness', modes: ['full'],
      script: 'verify-interruption-recovery-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'interruption-recovery', 'interruption-recovery-results.json'),
      timeoutMs: 20 * 60000, desc: '중단 복구: 재시도 정책·불확실 보존·대기 사유 IR1~IR6B',
    },
    {
      // 작업 UI 가 화면에서 실제로 동작하는가. IPC 로는 통과하지만 화면에선 버튼이 없거나 전환이 안 되는
      // 결함이 그 사이에 숨는다(기능 하네스 32종이 전부 초록인 채 제품이 못 쓸 상태였던 전례).
      // 자연어 한 줄이 화면을 거쳐 **생산 레시피**(참여 가드 표식이 실린 지시문)로 이어지는지.
      // intent-routing 은 해석만 본다 — "해석은 맞는데 화면에서 아무 일도 안 난다"는 여기서만 잡힌다.
      id: 'intent-ui', kind: 'harness', modes: ['full'],
      script: 'verify-intent-ui-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'intent-ui', 'intent-ui-results.json'),
      timeoutMs: 10 * 60000, desc: '자연어 → 확인 카드 → 생산 워크플로 실제 연결 IU1~IU5',
    },
    {
      id: 'task-ui', kind: 'harness', modes: ['full'],
      script: 'verify-task-ui-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'task-ui', 'task-ui-results.json'),
      timeoutMs: 12 * 60000, desc: '작업 UI DOM 대조: 카드·일시정지/재개·미완료 표시·승인 흐름 UI1~UI9',
    },
    {
      // 범용 조작 — 사이트별 스크립트에 의존하지 않는 조작(iframe·shadow DOM·SPA 재렌더·업로드).
      // cross-origin iframe 은 브라우저 구조 제약일 수 있어 GAP 으로 세고 실패로 보지 않는다.
      id: 'universal-ops', kind: 'harness', modes: ['full'],
      script: 'verify-universal-ops-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'universal-ops', 'universal-ops-results.json'),
      timeoutMs: 12 * 60000, desc: '범용 조작: iframe·shadow DOM·stale ref 거부·업로드 3경로 U1~U10',
    },
    {
      id: 'ai-persist', kind: 'harness', modes: ['full'],
      script: 'verify-ai-persist-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'ai-persist', 'ai-persist-results.json'),
      timeoutMs: 10 * 60000, desc: 'AI 대화·실행이력 재시작 영속화·상한·저장 경합·손상 복구 PS1~PS12',
    },
    {
      // 확장이 **로드만 되는 게 아니라 동작하는지**. scripting API 는 현재 알려진 공백(GAP)이다.
      id: 'extension-behavior', kind: 'harness', modes: ['full'],
      script: 'verify-extension-behavior-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'extension-behavior', 'extension-behavior-results.json'),
      timeoutMs: 8 * 60000, desc: '확장 실동작(차단·주입·헤더·동적룰·저장소·SW) X1~X11',
    },
    {
      id: 'agent-triggers', kind: 'harness', modes: ['full'],
      script: 'verify-agent-triggers-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'agent-triggers', 'agent-triggers-results.json'),
      timeoutMs: 10 * 60000, desc: 'AI 트리거 발화·쿨다운·비활성·삭제 + 양성대조 T1~T5',
    },
    {
      id: 'ai-errors', kind: 'harness', modes: ['full'],
      script: 'verify-ai-errors-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'ai-errors', 'ai-errors-results.json'),
      timeoutMs: 10 * 60000, desc: 'AI 오류 문구(401·429·404·연결·취소·깨진 스트림) E0~E6',
    },
    {
      id: 'agent-safety', kind: 'harness', modes: ['full'],
      script: 'verify-agent-safety-cdp.mjs', outArg: false, result: () => fixed('agent-safety-results.json'),
      timeoutMs: 12 * 60000, desc: 'AI 에이전트 안전·조작 A1~A14',
    },
    {
      id: 'memory-page', kind: 'harness', modes: ['full'],
      script: 'verify-memory-page-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'memory-page', 'memory-page-results.json'),
      timeoutMs: 8 * 60000, desc: 'browser://memory 표시값 실측 대조 M1~M6',
    },
    {
      id: 'newtab-buddy', kind: 'harness', modes: ['full'],
      script: 'verify-newtab-buddy-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'newtab-buddy', 'newtab-buddy-results.json'),
      timeoutMs: 5 * 60000, desc: '새 탭 픽셀 친구 B1~B5 (그림·애니메이션·클릭·숨김 정지·끄기)',
    },
    {
      id: 'settings-welcome', kind: 'harness', modes: ['full'],
      script: 'verify-settings-welcome-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'settings-welcome', 'settings-welcome-results.json'),
      timeoutMs: 10 * 60000, desc: 'browser://settings·welcome 표시·반영 대조 S1~S5·W1~W5',
    },
    {
      // 제품의 첫인상 경로라 매 라운드 지킨다. 모델을 부르지 않으므로(탐지만) 요금·한도 소모 0 —
      // 실제 왕복은 `node build/verify-ai-connect-cdp.mjs --live` 로 사람이 따로 확인한다.
      id: 'ai-connect', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-ai-connect-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'ai-connect', 'results.json'),
      timeoutMs: 8 * 60000, desc: 'AI 첫 사용이 막다른 길로 끝나지 않는가 C1~C9',
    },
    {
      id: 'settings-deep', kind: 'harness', modes: ['full'],
      script: 'verify-settings-deep-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'settings-deep', 'settings-deep-results.json'),
      timeoutMs: 10 * 60000, desc: '설정 되돌릴 수 없는 동작 — 내보내기/가져오기·키맵 D1~D3·K1~K3',
    },
    {
      id: 'corrupt-profile', kind: 'harness', modes: ['full'],
      script: 'verify-corrupt-profile-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'corrupt-profile', 'corrupt-profile-results.json'),
      timeoutMs: 10 * 60000, desc: '프로필 파일이 깨져도 앱이 뜨는가 C0~C3',
    },
    {
      id: 'error-boundary', kind: 'harness', modes: ['full'],
      script: 'verify-error-boundary-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'error-boundary', 'error-boundary-results.json'),
      timeoutMs: 6 * 60000, desc: '외피 오류 경계 — 평소엔 안 뜨고 외피가 정상인가(EB1·EB2)',
    },
    {
      id: 'internal-pages', kind: 'harness', modes: ['full'],
      script: 'verify-internal-pages-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'internal-pages', 'internal-pages-results.json'),
      timeoutMs: 12 * 60000, desc: 'browser:// 내부 페이지 22종이 오류 없이 내용을 보이는가',
    },
    {
      id: 'input-guards', kind: 'harness', modes: ['full'],
      script: 'verify-input-guards-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'input-guards', 'input-guards-results.json'),
      timeoutMs: 8 * 60000, desc: '사용자 입력을 파일에 쓰는 5경로가 잘못된 입력을 거부하는가 G1~G6',
    },
    {
      id: 'fingerprint', kind: 'harness', modes: ['full'],
      script: 'probe-fingerprint-cdp.mjs', outArg: false, result: () => fixed('fingerprint-report.json'),
      timeoutMs: 8 * 60000, desc: '자동화 지문 노출 진단',
    },
    {
      // 순수 로직(앱 없이 1초 미만) — 저장 기한 계산과 스냅샷 모양 검증.
      // "강제 종료 뒤 탭이 사라진다" 의 두 원인이 모두 여기에 있어 마감 게이트에서도 매번 돈다.
      id: 'session-schema', kind: 'harness', modes: ['quick', 'full'],
      script: 'verify-session-schema.mjs', outArg: true,
      result: (o) => path.join(o, 'session-schema', 'results.json'),
      timeoutMs: 2 * 60000, desc: '세션 저장 기한·스냅샷 모양 검증 SS1~SS12',
    },
    {
      id: 'session-durability', kind: 'harness', modes: ['full'],
      script: 'verify-session-durability-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'session-durability', 'results.json'),
      timeoutMs: 15 * 60000, desc: '크래시·재크래시·저장 실패 시 세션 보존 SD1~SD9',
    },
    {
      id: 'session-restore', kind: 'harness', modes: ['full'],
      script: 'session-restore-cdp.mjs', outArg: true, result: (o) => path.join(o, 'session-restore', 'restore-results.json'),
      timeoutMs: 12 * 60000, desc: '강제 kill 후 탭·그룹·분할·스크롤 복원',
    },
    {
      // 다중 창 크래시 복원 + 내구 작업의 정확한 탭 재바인딩(run-20260920T042617Z-732aef).
      // 창·탭 id 가 재시작마다 새로 발급되는데도 내구 작업이 restoreKey 로 "바로 그 탭" 만
      // 조작하는가(호스트 스캔으로 다른 창의 같은 URL 탭을 잘못 집지 않는가) — 발행·결제 작업이면
      // 사고로 이어지는 부류다. 창을 2개 띄우고 강제종료를 반복하므로 앱을 4번(본 시나리오 2회 +
      // 음성 대조 2회) 띄운다.
      id: 'window-tabs', kind: 'harness', modes: ['full'],
      script: 'verify-window-tabs-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'window-tabs', 'results.json'),
      timeoutMs: 20 * 60000, desc: '다중 창 크래시 복원 + 내구 작업 탭 재바인딩 W1~W10',
    },
    {
      // 위 window-tabs 는 같은 기능을 **메인 IPC**(ptaskTargets/ptaskSetTarget)로 검증한다. 그 경로가
      // 통과해도 카드에 버튼이 안 뜨거나 후보가 안 그려지면 사용자는 아무것도 못 한다(이 저장소에서
      // "IPC 는 되는데 화면이 안 바뀌는" 결함이 실제로 있었다). 그래서 이쪽은 **실제 DOM 클릭만**으로
      // 대상 선택 → 이어가기를 구동하고, 무엇이 실행됐는지는 픽스처 서버 카운터로만 판정한다.
      id: 'task-target-ui', kind: 'harness', modes: ['full'],
      script: 'verify-task-target-ui-cdp.mjs', outArg: true,
      result: (o) => path.join(o, 'task-target-ui', 'task-target-ui-results.json'),
      timeoutMs: 15 * 60000, desc: '대상 탭 재선택 UI(실제 DOM 클릭) TG1~TG7',
    },
    {
      id: 'dl-matrix', kind: 'harness', modes: ['full'],
      script: 'dl-matrix.mjs', outArg: true, result: (o) => path.join(o, 'dl-matrix', 'dl-matrix-results.json'),
      timeoutMs: 20 * 60000, desc: '게이트 5 다운로드 11시나리오',
    },
    {
      id: 'ext-matrix', kind: 'harness', modes: ['full'], network: true,
      script: 'ext-matrix.mjs', outArg: true, result: (o) => path.join(o, 'ext-matrix', 'ext-matrix-results.json'),
      timeoutMs: 25 * 60000, desc: '게이트 5 확장 10종 (웹스토어 CRX 다운로드 — 네트워크)',
    },
    {
      // uBO Lite 의 **진짜 룰**로 우리 DNR 엔진을 시험한다. ext-matrix 가 받아 둔 프로필을 읽으므로
      // 반드시 그 뒤에 온다. 없으면 SKIP(게이트를 빨갛게 만들지 않는다).
      id: 'ubo-rules', kind: 'harness', modes: ['full'],
      script: 'verify-ubo-rules.mjs', outArg: true,
      result: (o) => path.join(o, 'ubo-rules', 'ubo-rules-results.json'),
      timeoutMs: 3 * 60000, desc: 'uBO Lite 실제 룰로 DNR 엔진 판정 검증 U1~U4',
    },
    {
      id: 'stress', kind: 'harness', modes: ['full'],
      script: 'stress-cdp.mjs', outArg: true, result: (o) => path.join(o, 'stress', 'stress-results.json'),
      timeoutMs: 30 * 60000, desc: '게이트 3 50탭 스트레스',
    },
    {
      id: 'perf', kind: 'harness', modes: ['full'],
      script: 'perf-measure.mjs', outArg: true, result: (o) => path.join(o, 'perf', 'perf-results.json'),
      timeoutMs: 30 * 60000, desc: '게이트 4 성능 예산 실측',
    },
  ]
}

// ── 인자 ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const out = {
    mode: 'quick', only: null, skipBuild: false, list: false, keepGoing: false,
    // --full 은 라운드 종결 절차이므로 결과를 status.md 에 자동 기록한다(--no-record 로 생략).
    // quick·only 실행은 개발 중 수시로 돌리므로 기본은 기록하지 않는다(--record 로 강제).
    record: null,
    outRoot: path.join(REPO_ROOT, 'verify-out', 'all'),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--quick') out.mode = 'quick'
    else if (a === '--full') out.mode = 'full'
    else if (a === '--only') out.only = String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--skip-build') out.skipBuild = true
    else if (a === '--keep-going') out.keepGoing = true
    else if (a === '--record') out.record = true
    else if (a === '--no-record') out.record = false
    else if (a === '--list') out.list = true
    else if (a === '--out') out.outRoot = path.resolve(argv[++i] ?? '')
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0) }
    else console.warn(`[verify-all] 알 수 없는 인자 무시: ${a}`)
  }
  return out
}

function printHelp() {
  console.log([
    'verify-all — 검증 하네스 통합 러너',
    '',
    '  node build/verify-all.mjs --quick                게이트 0 + 스모크 (기본)',
    '  node build/verify-all.mjs --full                 전 하네스 (20~40분, 네트워크 사용)',
    '  node build/verify-all.mjs --only smoke,perf      지정한 단계만',
    '  node build/verify-all.mjs --list                 단계 목록',
    '',
    '옵션: --skip-build  게이트 0(typecheck/build/package) 생략',
    '      --keep-going  게이트 0 실패해도 남은 단계 계속',
    '      --out <dir>   결과 루트 (기본 verify-out/all)',
    '',
    '종료 코드: 0 통과 / 1 실패·타임아웃 / 2 러너 치명적 오류',
  ].join('\n'))
}

// ── 실행 ────────────────────────────────────────────────────────────────

/**
 * 패키징 전제 점검 — 실행 중인 ezBrowser 가 dist/win-unpacked 의 exe 를 잠그면
 * electron-builder 는 ERR_ELECTRON_BUILDER_CANNOT_EXECUTE 라는 원인 불명 오류만 뱉는다
 * (CLAUDE.md 에 기록된 알려진 함정). 여기서 미리 잡아 무엇을 종료해야 하는지 알려준다.
 *
 * 죽이지는 않는다 — 사용자가 지금 쓰고 있는 창일 수 있다. 판단은 사람이 한다.
 */
function preflightPackage() {
  if (process.platform !== 'win32') return { ok: true }
  const distPrefix = path.join(REPO_ROOT, 'dist').replace(/'/g, "''")
  const ps = [
    `Get-CimInstance Win32_Process -Filter "Name='ezBrowser.exe'"`,
    "| Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('" + distPrefix + "') }",
    "| Where-Object { $_.CommandLine -notlike '*--type=*' }",
    '| Select-Object -ExpandProperty ProcessId',
  ].join(' ')
  let out = ''
  try {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    out = String(res.stdout || '')
  } catch {
    return { ok: true } // 점검 자체가 실패하면 막지 않는다(점검은 편의지 관문이 아니다)
  }
  const pids = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  if (!pids.length) return { ok: true }
  return {
    ok: false,
    message: [
      '  실행 중인 ezBrowser 가 exe 를 잠그고 있습니다 (PID ' + pids.join(', ') + ').',
      '  패키징하려면 먼저 그 인스턴스를 닫으세요 — 사용자가 쓰는 창일 수 있어 러너는 종료하지 않습니다.',
      '  강제 종료: taskkill /PID ' + pids[0] + ' /T /F',
      '  이미 빌드된 exe 로 하네스만 돌리려면: --skip-build',
    ].join('\n'),
  }
}

/**
 * 지정 시각 이후에 시작된 dist/ 소속 ezBrowser 프로세스를 정리하고 죽인 PID 목록을 반환.
 * 시각 조건이 안전장치다 — 사용자가 그 전부터 열어둔 창은 절대 건드리지 않는다.
 */
function killAppsStartedAfter(sinceMs) {
  if (process.platform !== 'win32') return []
  const distPrefix = path.join(REPO_ROOT, 'dist').replace(/'/g, "''")
  const ps = [
    `Get-CimInstance Win32_Process -Filter "Name='ezBrowser.exe'"`,
    "| Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('" + distPrefix + "') }",
    // CreationDate 를 ISO 문자열로 강제 — ConvertTo-Json 기본 출력(/Date(…)/)은 JS 가 못 읽는다.
    "| Select-Object ProcessId,@{n='Created';e={ $_.CreationDate.ToString('o') }} | ConvertTo-Json -Compress",
  ].join(' ')
  let list = []
  try {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' })
    const raw = String(res.stdout || '').trim()
    if (!raw) return []
    const parsed = JSON.parse(raw)
    list = Array.isArray(parsed) ? parsed : [parsed]
  } catch { return [] }

  const killed = []
  const survivors = []
  for (const p0 of list) {
    const pid = p0?.ProcessId
    const created = new Date(p0?.Created ?? 0).getTime()
    if (!pid || !Number.isFinite(created)) continue
    if (created < sinceMs - 5000) continue // 단계 시작 전부터 있던 것 = 우리 것이 아님
    // taskkill 은 성공을 보장하지 않는다 — 커널 대기 중인 프로세스는 명령을 받고도 한동안
    // 살아 남아 **디버그 포트를 계속 쥔다**. 그러면 다음 하네스가 죽은 좀비의 CDP 타깃에
    // 붙어 무한 대기한다(2026-09-06 실측: "정리했다"고 보고한 PID 가 그대로 포트를 물고 있었다).
    // 그러므로 죽었는지 **확인**하고, 안 죽으면 재시도하고, 끝내 못 죽이면 그렇게 보고한다.
    let gone = false
    for (let attempt = 0; attempt < 3 && !gone; attempt++) {
      try { spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
      const check = spawnSync('powershell', ['-NoProfile', '-Command',
        `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
      ], { encoding: 'utf8' })
      gone = String(check.stdout || '').includes('gone')
      if (!gone) spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 700'], { stdio: 'ignore' })
    }
    if (gone) killed.push(pid)
    else survivors.push(pid)
  }
  if (survivors.length) {
    console.log(`  ⚠ 종료되지 않은 앱 PID ${survivors.join(', ')} — 디버그 포트를 쥐고 있으면 다음 단계가 실패할 수 있습니다.`)
  }
  return killed
}

/**
 * 검증 결과를 status.md 의 전용 섹션에 기록한다(마커 사이를 통째로 교체 — 멱등).
 *
 * 왜: test.md 는 "기록 없는 검증은 안 한 것으로 친다"고 정하고 있지만, 사람이 표를 옮겨 적는
 * 한 그 단계는 언젠가 생략된다. 손으로 쓰는 라운드 로그와 **분리된 섹션**에 자동으로 남겨,
 * 최소한 "언제 무엇이 통과했는지"는 항상 남게 한다.
 */
function recordToStatus(summaryMd, rows, ms, modeLabel, startedAt) {
  const statusPath = path.join(REPO_ROOT, 'status.md')
  const BEGIN = '<!-- verify-all:begin -->'
  const END = '<!-- verify-all:end -->'
  let text
  try { text = fs.readFileSync(statusPath, 'utf8') } catch { return null }

  const passCount = rows.filter((r) => r.status === 'PASS').length
  const when = new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')
  const line = `- ${when} · \`${modeLabel}\` · **${passCount}/${rows.length} PASS** · ${fmtDuration(ms)}`

  // 기존 섹션에서 이력 줄만 추려 이어 붙인다(최근 10개).
  let history = []
  const prev = text.indexOf(BEGIN)
  if (prev >= 0) {
    const block = text.slice(prev, text.indexOf(END) + END.length)
    history = block.split('\n').filter((l) => /^- \d{4}-\d{2}-\d{2} /.test(l))
  }
  history = [line, ...history.filter((l) => l !== line)].slice(0, 10)

  const section = [
    BEGIN,
    '## 검증 실행 기록 (자동 — `verify-all` 이 갱신)',
    '',
    '> 이 섹션은 `npm run verify:full` 이 자동으로 덮어쓴다. 손으로 고치지 말 것.',
    '> 라운드의 해석·판단은 아래 "최근 라운드 로그"에 사람이 쓴다.',
    '',
    '### 최신 실행',
    '',
    summaryMd.split('\n').filter((l) => !/^─/.test(l)).join('\n').trim(),
    '',
    '### 최근 10회',
    '',
    ...history,
    '',
    END,
  ].join('\n')

  if (prev >= 0) {
    const endIdx = text.indexOf(END) + END.length
    text = text.slice(0, prev) + section + text.slice(endIdx)
  } else {
    const anchor = '## 최근 라운드 로그'
    const at = text.indexOf(anchor)
    text = at >= 0
      ? text.slice(0, at) + section + '\n\n---\n\n' + text.slice(at)
      : text.trimEnd() + '\n\n' + section + '\n'
  }
  fs.writeFileSync(statusPath, text)
  return statusPath
}

function fmtDuration(ms) {
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

/** 한 단계를 실행하고 {code, timedOut, ms, tail} 반환. 로그는 파일로, 꼬리는 메모리로. */
function runStep(step, { outRoot, logPath }) {
  return new Promise((resolve) => {
    // cmd 단계는 shell 에 **문자열 한 줄**로 넘긴다 — shell:true 에 args 배열을 함께 주면
    // Node 가 DEP0190(인자 미이스케이프) 경고를 낸다. 하네스 단계는 shell 없이 직접 spawn.
    const isCmd = step.kind === 'cmd'
    const cmd = isCmd
      ? [step.cmd, ...step.args].join(' ')
      : process.execPath
    const args = isCmd
      ? []
      : [path.join(__dirname, step.script), ...(step.outArg ? ['--out', path.join(outRoot, step.id)] : [])]

    fs.mkdirSync(path.dirname(logPath), { recursive: true })
    const logStream = fs.createWriteStream(logPath)
    const tail = []
    const pushTail = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (!line.trim()) continue
        tail.push(line)
        if (tail.length > 40) tail.shift()
      }
    }

    const started = Date.now()
    const child = spawn(cmd, args, {
      cwd: REPO_ROOT,
      shell: step.kind === 'cmd', // npm/npx 는 Windows 에서 셸 경유 필요
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (b) => { logStream.write(b); pushTail(b) })
    child.stderr?.on('data', (b) => { logStream.write(b); pushTail(b) })

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // 회수 시계: 정체된 하네스는 트리째 종료(자기가 띄운 앱도 함께 정리되도록)
      try { child.kill() } catch { /* ignore */ }
      if (process.platform === 'win32' && child.pid) {
        try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
      }
    }, step.timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      logStream.end()
      resolve({ code: 2, timedOut: false, ms: Date.now() - started, tail: [...tail, `spawn 실패: ${err.message}`] })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      logStream.end()
      resolve({ code: timedOut ? 124 : (code ?? 1), timedOut, ms: Date.now() - started, tail })
    })
  })
}

/** 결과 JSON 에서 PASS/FAIL/SKIP 개수를 최대한 일반적으로 읽어낸다. */
function summarizeResult(file, notBefore = 0) {
  if (!file || !fs.existsSync(file)) return null
  // 낡은 산출물에 속지 않는다 — 이번 단계가 시작된 뒤에 쓰인 파일만 읽는다.
  // (하네스가 부팅 단계에서 죽으면 결과 JSON 을 새로 쓰지 않으므로, 이전 실행의 성공 기록을
  //  그대로 읽어 "PASS 14" 같은 거짓 통과를 보고하게 된다 — 2026-09-06 실측.)
  if (notBefore) {
    try {
      if (fs.statSync(file).mtimeMs < notBefore - 2000) return null
    } catch { return null }
  }
  let json
  try { json = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }

  const countArr = (arr) => {
    const c = { pass: 0, fail: 0, skip: 0, other: 0 }
    for (const r of arr) {
      const st = String(r?.status ?? r?.판정 ?? '').toUpperCase()
      if (st.includes('FAIL')) c.fail += 1
      else if (st.includes('PASS') || st === 'OK') c.pass += 1
      else if (st.includes('SKIP')) c.skip += 1
      else c.other += 1
    }
    return (c.pass + c.fail + c.skip) > 0 ? c : null
  }

  if (Array.isArray(json)) return countArr(json)
  if (json && typeof json === 'object') {
    for (const key of ['findings', 'results', 'rows', 'scenarios', 'budget', 'extensions']) {
      if (Array.isArray(json[key])) {
        const c = countArr(json[key])
        if (c) return c
      }
    }
    // fingerprint 처럼 판정 배열이 없는 진단 보고서: 문제 목록만 세어 준다.
    if (Array.isArray(json.problems)) {
      return { pass: json.problems.length === 0 ? 1 : 0, fail: json.problems.length, skip: 0, other: 0 }
    }
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const all = steps(args.outRoot)

  if (args.list) {
    console.table(all.map((s) => ({
      id: s.id, 모드: s.modes.join('+'), 종류: s.kind,
      제한시간: fmtDuration(s.timeoutMs), 설명: s.desc,
    })))
    return 0
  }

  if (args.only) {
    const unknown = args.only.filter((id) => !all.some((s) => s.id === id))
    if (unknown.length) { console.error(`[verify-all] 알 수 없는 단계: ${unknown.join(', ')}`); return 2 }
  }

  let selected = args.only
    ? all.filter((s) => args.only.includes(s.id))
    : all.filter((s) => s.modes.includes(args.mode))
  if (args.skipBuild) selected = selected.filter((s) => !s.gate0)
  if (!selected.length) { console.error('[verify-all] 실행할 단계가 없습니다.'); return 2 }

  // 전제: 하네스 단계가 있는데 exe 가 없고 package 단계도 안 도는 경우 → 치명적으로 중단.
  const needsExe = selected.some((s) => s.kind === 'harness')
  const willPackage = selected.some((s) => s.id === 'package')
  if (needsExe && !willPackage && !fs.existsSync(EXE)) {
    console.error(`[verify-all] 하네스가 구동할 exe 가 없습니다: ${EXE}`)
    console.error('  → --skip-build 를 빼고 실행하거나, 먼저 npx electron-builder --win --dir 를 돌리세요.')
    return 2
  }

  fs.mkdirSync(args.outRoot, { recursive: true })
  const startedAt = Date.now()
  const modeLabel = args.only ? `only(${args.only.join(',')})` : args.mode
  console.log(`[verify-all] 모드=${modeLabel} · 단계 ${selected.length}개 · 결과 ${args.outRoot}`)
  if (args.mode === 'full' && !args.only) {
    console.log('[verify-all] 전체 검증은 **실제 창을 여러 번 띄우고 약 10분** 걸립니다(50탭 스트레스·성능 측정 포함).')
    console.log('[verify-all] 화면을 쓰셔야 하면 `npm run verify`(약 30초, 창 1개)로 충분합니다.')
  }
  if (selected.some((s) => s.network)) {
    console.log('[verify-all] 네트워크를 쓰는 단계 포함 (ext-matrix: 웹스토어 CRX 다운로드).')
  }

  const rows = []
  for (const [i, step] of selected.entries()) {
    const logPath = path.join(args.outRoot, `${step.id}.log`)
    process.stdout.write(`\n[${i + 1}/${selected.length}] ${step.id} — ${step.desc} … `)
    // 전제 점검이 있는 단계는 먼저 확인 — 실패를 원인 불명 오류로 만들지 않는다.
    const pre = step.preflight ? step.preflight() : { ok: true }
    if (!pre.ok) {
      console.log('BLOCKED')
      console.log(pre.message)
      rows.push({ id: step.id, status: 'BLOCKED', ms: 0, code: -1, detail: '전제 불충족', log: null })
      if (!args.keepGoing) {
        console.log('\n[verify-all] 전제 불충족(' + step.id + ') — 중단합니다.')
        break
      }
      continue
    }

    // 앞 단계가 남긴 앱을 먼저 치운다. 남은 인스턴스는 디버그 포트를 선점해, 다음 하네스가
    // **죽은 좀비의 CDP 타깃에 붙어** 무한 대기하게 만든다(2026-09-06 실측: 이것이 INFRA
    // 간헐 실패의 진짜 원인이었다). 이 실행이 시작된 뒤에 뜬 것만 죽인다.
    if (step.kind === 'harness') {
      const pre2 = killAppsStartedAfter(startedAt)
      if (pre2.length) console.log(`(앞 단계 잔재 앱 ${pre2.length}개 정리) `)
    }

    const stepStartedAt = Date.now()
    const r = await runStep(step, { outRoot: args.outRoot, logPath })
    const counts = step.result ? summarizeResult(step.result(args.outRoot), stepStartedAt) : null

    // 잔재 정리: 하네스가 타임아웃·비정상 종료로 죽으면 자기가 띄운 앱을 남긴다.
    // 남은 앱은 다음 하네스의 포트·프로필·exe 잠금을 망가뜨려 **연쇄 실패**를 만든다
    // (2026-09-06 실측: 스모크 타임아웃 후 앱 9개가 남아 이후 4개 하네스가 전부 실패).
    // 이 단계가 시작된 뒤에 뜬 것만 죽인다 — 사용자가 미리 열어둔 창은 건드리지 않는다.
    if (step.kind === 'harness') {
      const cleaned = killAppsStartedAfter(stepStartedAt)
      if (cleaned.length) console.log(`  ↳ 잔재 앱 ${cleaned.length}개 정리 (PID ${cleaned.join(', ')})`)
    }

    // 판정: 종료 코드가 1차. 결과 JSON 의 FAIL 개수가 있으면 그것도 실패로 본다.
    // 종료 코드 해석: 하네스는 0=통과/1=실패/2=치명 규약을 따르지만, cmd 단계(tsc 등)는
    // 자기 나름의 코드를 쓴다(tsc 는 타입 오류에 2). cmd 는 non-zero 를 전부 FAIL 로 본다.
    let status = 'PASS'
    if (r.timedOut) status = 'TIMEOUT'
    else if (step.kind === 'harness' && r.code === 2) status = 'ERROR'
    else if (r.code !== 0) status = 'FAIL'
    else if (counts && counts.fail > 0) status = 'FAIL'

    const detail = counts
      ? `PASS ${counts.pass}${counts.fail ? ` · FAIL ${counts.fail}` : ''}${counts.skip ? ` · SKIP ${counts.skip}` : ''}`
      : (status === 'PASS' ? '종료코드 0' : `종료코드 ${r.code}`)
    console.log(`${status} (${fmtDuration(r.ms)}) ${detail}`)

    if (status !== 'PASS') {
      console.log(`  ↳ 로그: ${logPath}`)
      for (const line of r.tail.slice(-12)) console.log(`    | ${line}`)
    }

    rows.push({ id: step.id, status, ms: r.ms, code: r.code, detail, log: logPath })

    if (status !== 'PASS' && step.gate0 && !args.keepGoing) {
      console.log(`\n[verify-all] 게이트 0 단계(${step.id}) 실패 — 이후 단계는 의미가 없어 중단합니다.`)
      break
    }
  }

  const notRun = selected.length - rows.length
  const summary = {
    startedAt: new Date(startedAt).toISOString(),
    ms: Date.now() - startedAt,
    mode: modeLabel,
    notRun,
    rows,
  }
  fs.writeFileSync(path.join(args.outRoot, 'verify-all-results.json'), JSON.stringify(summary, null, 2))

  console.log('\n===== verify-all 결과 =====')
  console.table(rows.map((r) => ({ 단계: r.id, 상태: r.status, 소요: fmtDuration(r.ms), 상세: r.detail })))
  const failed = rows.filter((r) => r.status !== 'PASS')
  console.log(`통과 ${rows.length - failed.length}/${rows.length}${notRun ? ` (중단으로 미실행 ${notRun})` : ''} · 총 ${fmtDuration(summary.ms)}`)
  console.log(`결과: ${path.join(args.outRoot, 'verify-all-results.json')}`)

  // ── 보고서용 요약 블록 ──────────────────────────────────────────────────
  // 라운드 종결 절차(CLAUDE.md 품질 게이트)는 "돌리고 결과를 보고서에 붙인다"이다.
  // 사람이 표를 손으로 옮겨 적게 하면 그 단계가 조용히 생략된다 — 붙여넣을 수 있는 형태로 준다.
  const icon = (st) => (st === 'PASS' ? '✅' : st === 'TIMEOUT' ? '⏱️' : st === 'BLOCKED' ? '⛔' : '❌')
  const md = [
    '',
    '── 보고서에 붙일 요약 (마크다운) ' + '─'.repeat(28),
    '',
    `**\`npm run verify${modeLabel === 'full' ? ':full' : ''}\` — ${rows.length - failed.length}/${rows.length} PASS · ${fmtDuration(summary.ms)}** (${new Date(startedAt).toISOString().slice(0, 16).replace('T', ' ')})`,
    '',
    '| 단계 | 상태 | 소요 | 상세 |',
    '|------|------|------|------|',
    ...rows.map((r) => `| ${r.id} | ${icon(r.status)} ${r.status} | ${fmtDuration(r.ms)} | ${r.detail} |`),
    ...(notRun ? ['', `> 중단으로 미실행: ${notRun}단계`] : []),
    ...(failed.length ? ['', `> 실패: ${failed.map((f) => `\`${f.id}\`(${f.status})`).join(', ')} — 로그: \`${args.outRoot}\``] : []),
    '─'.repeat(60),
    '',
  ].join('\n')
  console.log(md)
  try {
    fs.writeFileSync(path.join(args.outRoot, 'verify-all-summary.md'), md)
    console.log(`요약 파일: ${path.join(args.outRoot, 'verify-all-summary.md')}`)
  } catch { /* best-effort */ }

  // 기록 조건(2026-09-07, 사용자 선택 B): 라운드 종결은 quick 이 맡으므로 **완전한 게이트 실행**이면
  // 기록한다(--only 나 --skip-build 가 붙은 개발 중 실행은 제외 — status.md 가 매번 흔들리면 안 된다).
  const shouldRecord = args.record === null
    ? (!args.only && !args.skipBuild)
    : args.record === true
  if (shouldRecord) {
    const written = recordToStatus(md, rows, summary.ms, modeLabel, startedAt)
    if (written) console.log(`status.md 검증 기록 갱신: ${written}`)
  }
  if (failed.length) console.log(`실패 단계: ${failed.map((f) => `${f.id}(${f.status})`).join(', ')}`)

  return (failed.length || notRun) ? 1 : 0
}

main().then((code) => process.exit(code ?? 0)).catch((err) => {
  console.error('[verify-all] 치명적 오류:', err)
  process.exit(2)
})
