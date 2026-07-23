// 브랜드 원본 이미지(resources/brand/*)를 화면 표시 크기로 축소·압축해 각 페이지 폴더에 넣는다.
// Electron nativeImage 사용(외부 이미지 라이브러리 불필요). 한 번 실행하면 pages/* 에 최적화본이 생성된다.
//   실행:  electron build/optimize-assets.mjs   (또는 npm run gen:assets)
import { app, nativeImage } from 'electron'
import { writeFileSync, statSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')
const brand = path.join(root, 'resources', 'brand')

function resize(srcName, dstPath, width) {
  const img = nativeImage.createFromPath(path.join(brand, srcName))
  const sz = img.getSize()
  if (!sz.width) { console.error(`[assets] load 실패: ${srcName}`); return }
  const out = img.resize({ width, height: Math.round((sz.height * width) / sz.width), quality: 'best' })
  mkdirSync(path.dirname(dstPath), { recursive: true })
  writeFileSync(dstPath, out.toPNG())
  const kb = Math.round(statSync(dstPath).size / 1024)
  console.log(`[assets] ${srcName} ${sz.width}x${sz.height} → ${path.relative(root, dstPath)} @${width}w (${kb}KB)`)
}

const jobs = [
  // 온보딩 일러스트 (welcome 페이지, ~440px 표시 → 2x)
  ['onboarding-1.png', 'pages/welcome/onboarding-1.png', 880],
  ['onboarding-2.png', 'pages/welcome/onboarding-2.png', 880],
  ['onboarding-3.png', 'pages/welcome/onboarding-3.png', 880],
  ['onboarding-4.png', 'pages/welcome/onboarding-4.png', 880],
  ['onboarding-5.png', 'pages/welcome/onboarding-5.png', 880],
  // 빈 상태 일러스트 (각 내부 페이지, ~280px 표시 → 2x)
  ['empty-newtab.png', 'pages/newtab/empty.png', 560],
  ['empty-bookmarks.png', 'pages/bookmarks/empty.png', 560],
  ['empty-history.png', 'pages/history/empty.png', 560],
  ['empty-downloads.png', 'pages/downloads/empty.png', 560],
  // 파비콘 폴백 (renderer 에서 import — assets 폴더로)
  ['favicon-fallback.png', 'app/renderer/assets/favicon-fallback.png', 64],
  // 마스코트 (welcome 환영 단계용, 투명 배경)
  ['mascot.png', 'pages/welcome/mascot.png', 320],
]

app.whenReady().then(() => {
  for (const [src, dst, w] of jobs) {
    try { resize(src, path.join(root, dst), w) } catch (e) { console.error(`[assets] ${src} 실패`, e.message) }
  }
  app.quit()
}).catch((e) => { console.error(e); app.quit() })
