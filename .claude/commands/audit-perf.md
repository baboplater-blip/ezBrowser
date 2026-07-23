---
description: 가벼움 예산 측정 — 시작 시간, 메모리, 번들 크기, LCP. 4원칙 #1 회귀 차단
---

# /audit-perf

가벼움 예산을 측정하고 회귀 여부를 보고한다.

## 측정 항목 (CLAUDE.md 의 가벼움 예산)

| 항목 | 한도 | 측정 |
|------|-----|------|
| 콜드 스타트 (창 표시까지) | ≤ 2.0s | `app.whenReady()` → `BaseWindow.show()` |
| 빈 창 RSS (newtab 1개) | ≤ 250MB | process.getProcessMemoryInfo() 합 |
| 탭 추가당 RSS 증가 | ≤ 80MB | about:blank 10탭 후 평균 |
| 외피 초기 JS | ≤ 500KB gzip | Vite `--report` |
| 외피 LCP | ≤ 300ms | Performance API |
| 디스크 (설치 후) | ≤ 250MB | NSIS 산출물 + 첫 실행 userData |
| 휴식 CPU | ≤ 0.5% | 5분 idle 평균 |

## 절차

1. **클린 환경** — userData 임시 폴더 (`--user-data-dir=tmp/perf`)
2. **콜드 스타트 측정** — 3회 평균
3. **메모리 베이스라인** — 빈 newtab 1개, 10초 안정화 후 측정
   - **실시간 확인**: `browser://memory` 페이지 — 프로세스별 RSS·CPU·탭별 슬립 상태 즉시 표시 (1초 갱신)
   - 또는 명령 팔레트 → "메모리·성능 보기"
4. **탭 부하** — 10개 about:blank 추가, 각 추가 후 5초 대기
5. **번들 분석** — `vite build --mode analyze`
6. **LCP** — 외피 렌더 후 Performance API
7. **디스크** — `dist/*.exe` 크기 + 첫 실행 후 userData
8. **CPU 휴식** — 5분 idle, `ps`/Get-Process 1초 샘플링
9. **백그라운드 슬립 검증** — `browser://memory` 의 "지금 비활성 탭 슬립" 버튼 + 슬립 후 RSS 재측정 (탭당 ~80MB → ~5MB 절감 확인)

## 출력 형식

```
⚡ Performance Audit — 2026-05-25 (vs. 마지막 측정 2026-05-22)
✅ 콜드 스타트: 1.6s (예산 2.0s, 마지막 1.7s — 6% 개선)
✅ 빈 창 RSS: 214 MB (예산 250 MB, 마지막 209 MB — 2% 증가)
⚠️  탭당 RSS: 91 MB (예산 80 MB, 마지막 75 MB — 21% 회귀)
    → 원인 의심: 광고차단 엔진의 탭별 인스턴스 캐싱? 또는 다크 모드 CSS 주입
✅ 외피 JS: 412 KB gzip (예산 500 KB, 마지막 405 KB)
✅ LCP: 240ms (예산 300ms)
✅ 디스크: 187 MB (예산 250 MB)
✅ 휴식 CPU: 0.3% (예산 0.5%)

⚠️  회귀 발견: 탭당 RSS. 다음 커밋 차단 검토 권장.
리포트: perf-report-2026-05-25.json (시계열 누적)
```

## 회귀 정책

- 가벼움 예산 초과 = 빌드 차단(`/build` 자동 실패)
- 마지막 측정 대비 15% 이상 회귀 = 경고 (차단 아님)
- 시계열 저장 `perf-history.json` — 그래프 가능

## 절대 피할 것

- 매 빌드마다 자동 실행 시 5분 idle 측정 — CI 부담. main 머지 시만
- 측정 환경 변경 (다른 OS, 다른 NVMe) 비교 — 절대값 의미 없음
- 개발 모드 측정 — 항상 production 빌드로
- 한 번 측정 후 평균 — 최소 3회
