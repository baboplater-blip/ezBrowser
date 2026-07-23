// 앱 아이콘 생성기 — 외부 의존성 없이 1024x1024 PNG 를 직접 인코딩한다.
// electron-builder 는 build/icon.png(고해상도) 하나만 있으면 win(.ico)/mac(.icns)/linux 아이콘을
// 자동 변환하므로, 브랜드 아이콘을 코드로 그려 build/icon.png 와 resources/icon.png 에 쓴다.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SIZE = 1024

// ---- CRC32 (PNG 청크용) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}
function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  // 각 스캔라인 앞에 필터 바이트(0) 추가
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
  }
  const idat = deflateSync(raw, { level: 9 })
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
}

// ---- 합성 헬퍼 ----
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }
function mix(a, b, t) { return a + (b - a) * t }
function blend(dst, i, r, g, b, a) {
  // dst 위에 (r,g,b,a) 알파 합성 (a: 0..1)
  const dr = dst[i], dg = dst[i + 1], db = dst[i + 2], da = dst[i + 3] / 255
  const oa = a + da * (1 - a)
  if (oa <= 0) { dst[i] = dst[i + 1] = dst[i + 2] = dst[i + 3] = 0; return }
  dst[i] = Math.round((r * a + dr * da * (1 - a)) / oa)
  dst[i + 1] = Math.round((g * a + dg * da * (1 - a)) / oa)
  dst[i + 2] = Math.round((b * a + db * da * (1 - a)) / oa)
  dst[i + 3] = Math.round(oa * 255)
}

// 둥근 사각형 내부 거리 기반 커버리지 (AA)
function roundedRectCoverage(x, y, w, h, radius) {
  const cx = Math.min(Math.max(x, radius), w - radius)
  const cy = Math.min(Math.max(y, radius), h - radius)
  const dx = x - cx, dy = y - cy
  const dist = Math.hypot(dx, dy)
  return clamp01(radius - dist + 0.5)
}

function render() {
  const buf = Buffer.alloc(SIZE * SIZE * 4) // 전부 투명(0)으로 시작
  const margin = 64
  const inner = SIZE - margin * 2
  const radius = 220
  const cxc = SIZE / 2, cyc = SIZE / 2

  // 그라데이션 색 (상단 → 하단)
  const top = [76, 141, 255]   // #4C8DFF
  const bot = [122, 92, 255]   // #7A5CFF

  // 링(글로브) 파라미터
  const ringOuter = 330, ringInner = 238
  // 위도/경도 곡선 대용: 가로 띠 두 개
  const meridian = 60 // 가로 곡선 반두께

  for (let py = 0; py < SIZE; py += 1) {
    for (let px = 0; px < SIZE; px += 1) {
      const i = (py * SIZE + px) * 4
      // 1) 둥근 사각형 배경
      const cov = roundedRectCoverage(px - margin, py - margin, inner, inner, radius)
      if (cov <= 0) continue
      const t = clamp01((py - margin) / inner)
      const r = Math.round(mix(top[0], bot[0], t))
      const g = Math.round(mix(top[1], bot[1], t))
      const b = Math.round(mix(top[2], bot[2], t))
      blend(buf, i, r, g, b, cov)

      // 2) 흰색 링
      const d = Math.hypot(px - cxc, py - cyc)
      const ringCov = clamp01(ringOuter - d + 0.5) * clamp01(d - ringInner + 0.5)
      if (ringCov > 0) {
        blend(buf, i, 255, 255, 255, ringCov * cov)
      }
      // 3) 링 안쪽 가로 위선 두 줄 (글로브 느낌)
      if (d < ringInner) {
        const bandTop = clamp01(meridian / 2 - Math.abs((py - cyc) - 110) + 0.5)
        const bandBot = clamp01(meridian / 2 - Math.abs((py - cyc) + 110) + 0.5)
        const band = Math.max(bandTop, bandBot)
        if (band > 0) blend(buf, i, 255, 255, 255, band * 0.85 * cov)
      }
    }
  }
  return buf
}

const buildIcon = path.join(__dirname, 'icon.png')
const resourcesDir = path.join(__dirname, '..', 'resources')
const brandIcon = path.join(resourcesDir, 'brand', 'icon-1024.png')
mkdirSync(resourcesDir, { recursive: true })

// 사용자가 직접 만든 브랜드 아이콘이 있으면 그것을 사용한다 — 자동 생성 placeholder 가 덮어쓰지 않도록.
// 드롭 경로: resources/brand/icon-1024.png (1024x1024 PNG). 자세한 사양은 assets.md 참고.
if (existsSync(brandIcon)) {
  const custom = readFileSync(brandIcon)
  writeFileSync(buildIcon, custom)
  writeFileSync(path.join(resourcesDir, 'icon.png'), custom)
  console.log(`[gen-icon] 사용자 브랜드 아이콘 적용 → build/icon.png, resources/icon.png (${custom.length} bytes)`)
} else {
  const png = encodePng(render(), SIZE, SIZE)
  writeFileSync(buildIcon, png)
  writeFileSync(path.join(resourcesDir, 'icon.png'), png)
  console.log(`[gen-icon] placeholder ${SIZE}x${SIZE} 생성 → build/icon.png (커스텀을 쓰려면 resources/brand/icon-1024.png 에 두세요)`)
}
