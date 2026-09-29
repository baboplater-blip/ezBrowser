# ezBrowser Windows 후보 빌드 — 최종 인계

- 작업: usable-windows-20260918 / run-20260918T053054Z-3c840e
- 설치파일: `dist/ezBrowser-0.1.0-win-x64.exe` (121803984 bytes, 2026-09-18 14:53:34 KST)
- SHA256: `5c57081c6dd2f4bfefe7f25a55da7baa92d3779b7e9805b8a1e338b44266689e` (실행층 설치 검증 영수증)
- 즉시 실행: `dist/win-unpacked/ezBrowser.exe` — 폴더 전체가 필요하며 exe만 이동하지 않는다.
- 안내: `docs/QUICKSTART.md`

## 변경 및 근거

API 키 안내에서 막히던 첫 AI 사용을 제공자 자동 탐지와 연결 카드로 개선했다. 온보딩에 건너뛸 수 있는 AI 연결 단계를 추가하고, 다른 화면의 설정 변경이 사이드바에 반영되도록 수정했다.

실행층 결과: 실제 Claude Code 구독 연결을 포함한 AI 연결 12/12, 최종 설치본 설치·탐색·복원·제거 9/9, 최종 npm run verify 9/9(42초). 사용자 실제 프로필 전후 47→47 무변경. 부모는 이 검사를 반복하지 않았으며 산출 경로 실존을 확인했다.

로컬 Windows 후보 빌드까지 준비됐다. 공개 출시 전체 완료는 아니다. 미서명, 외부의 깨끗한 Windows 설치·업데이트 미검증, 실제 웹사이트 전반의 호환성과 verify:full 미실행을 구분한다. 인증서나 다른 기기 없이 이 두 출시 차단을 해결했다고 주장하지 않는다.

## 사용량

| 모델 | 입력(캐시 제외) | 출력 | 캐시 생성 | 캐시 읽기 |
|---|---:|---:|---:|---:|
| gpt-6-astra | 25974 | 6499 | 0 | 6382976 |
| claude-opus-5 | 238 | 96255 | 433639 | 42533846 |
| claude-haiku-4-5-20251001 | 10278 | 20 | 0 | 0 |

GPT는 같은 부모 세션의 2026-09-18 05:30:54~06:06:03 UTC 스냅샷 차분이다. 위임 전 초기 조사와 종료 스냅샷 이후 최종 정리·답변은 포함하지 않는다. Claude는 해당 실행 CLI modelUsage다. 캐시·reasoning 중복 합산 없음. 수신자 요청 모델 gpt-5.6-luna의 실제 해석 ID와 사용량은 별도 원장 미수집으로 미계측이다. 수치는 청구액이나 계정 한도가 아니다.

실행층 경과 2056초(약 34분). 재작업: 설정 변경 동기화 결함을 검증 과정에서 수정. 부모의 반복 대기 안내가 과도했다. 다음 개선은 상태 변화 없는 안내를 줄이고, 제품 검증 카드의 실제 사건만 전달하며, 회귀가 생긴 검사만 재실행하는 것이다. 비교 가능한 이전 제품화 작업 자료가 없어 절감률은 주장하지 않는다.

## 보드

- URL: http://127.0.0.1:8793/
- PID: 12348 — 작업 마감 시 정지 완료.
- 재기동: `python -X utf8 C:/Users/molma/.agents/skills/auto-dev/runtime/orchestrator.py board serve --root C:/Users/molma/Desktop/하네스/browser-build --port 8793`
- 정지: `python -X utf8 C:/Users/molma/.agents/skills/auto-dev/runtime/orchestrator.py board stop --root C:/Users/molma/Desktop/하네스/browser-build`
