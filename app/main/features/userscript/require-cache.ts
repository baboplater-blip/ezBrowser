// @require / @resource 다운로드 + 디스크 캐시. 설치(저장) 시점에 한 번만 내려받아 결과를
// Userscript 레코드에 박아 둔다 — 런타임(매 네비게이션의 동기 IPC 핸들러) 에서는 네트워크/파일
// I/O 가 전혀 없어야 하기 때문(item 5). https 만 허용, 사설망 차단(item 5 + SSRF 방어).

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app, net } from 'electron'
import type { UserscriptResourceCacheEntry } from '../../../shared/types'
import { isSneakyPrivateHost } from './net-guard'

const REQUIRE_MAX_BYTES = 2 * 1024 * 1024 // @require 라이브러리 1개당 2MB
const RESOURCE_MAX_BYTES = 5 * 1024 * 1024 // @resource 1개당 5MB
const FETCH_TIMEOUT_MS = 15_000
const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 캐시 신선도 — 7일 지나면 재다운로드 시도

function dir(): string {
  return path.join(app.getPath('userData'), 'userscripts-require')
}

function hashOf(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 40)
}

async function ensureDir(): Promise<void> {
  await mkdir(dir(), { recursive: true })
}

interface FetchResult { ok: boolean; bytes?: Buffer; contentType?: string; error?: string }

async function fetchBytes(url: string, maxBytes: number): Promise<FetchResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, error: '잘못된 URL 입니다' }
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'https URL 만 허용됩니다' }
  }
  if (await isSneakyPrivateHost(parsed.hostname)) {
    return { ok: false, error: '공인 도메인처럼 보이지만 실제로는 사설망 IP 로 연결됩니다(DNS 리바인딩 의심)' }
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (r: FetchResult): void => { if (!settled) { settled = true; resolve(r) } }
    try {
      const req = net.request({ url, method: 'GET', useSessionCookies: false })
      const chunks: Buffer[] = []
      let total = 0
      const timer = setTimeout(() => {
        try { req.abort() } catch { /* ignore */ }
        finish({ ok: false, error: '시간 초과' })
      }, FETCH_TIMEOUT_MS)
      req.on('response', (resp) => {
        if (resp.statusCode >= 400) {
          clearTimeout(timer)
          try { req.abort() } catch { /* ignore */ }
          finish({ ok: false, error: `http ${resp.statusCode}` })
          return
        }
        const ct = String(resp.headers['content-type'] ?? '')
        resp.on('data', (c: Buffer) => {
          total += c.length
          if (total > maxBytes) {
            clearTimeout(timer)
            try { req.abort() } catch { /* ignore */ }
            finish({ ok: false, error: `크기 상한 초과(최대 ${Math.floor(maxBytes / 1024)}KB)` })
            return
          }
          chunks.push(c)
        })
        resp.on('end', () => {
          clearTimeout(timer)
          finish({ ok: true, bytes: Buffer.concat(chunks), contentType: ct })
        })
      })
      req.on('error', (err) => { clearTimeout(timer); finish({ ok: false, error: err.message }) })
      req.end()
    } catch (err) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  })
}

interface CacheMeta { url: string; fetchedAt: number; contentType: string }

async function readCache(hash: string): Promise<{ bytes: Buffer; meta: CacheMeta } | null> {
  const bin = path.join(dir(), `${hash}.bin`)
  const meta = path.join(dir(), `${hash}.meta.json`)
  if (!existsSync(bin) || !existsSync(meta)) return null
  try {
    const [bytes, metaRaw] = await Promise.all([readFile(bin), readFile(meta, 'utf-8')])
    const parsed = JSON.parse(metaRaw) as CacheMeta
    return { bytes, meta: parsed }
  } catch {
    return null
  }
}

async function writeCache(hash: string, bytes: Buffer, meta: CacheMeta): Promise<void> {
  await ensureDir()
  await Promise.all([
    writeFile(path.join(dir(), `${hash}.bin`), bytes),
    writeFile(path.join(dir(), `${hash}.meta.json`), JSON.stringify(meta), 'utf-8'),
  ])
}

/** @require 하나를 받아 캐시하고 UTF-8 텍스트로 반환한다. 실패 시 error 만 채워진다. */
export async function resolveRequire(url: string): Promise<{ ok: boolean; code?: string; error?: string }> {
  const hash = hashOf(url)
  const cached = await readCache(hash)
  if (cached && Date.now() - cached.meta.fetchedAt < TTL_MS) {
    return { ok: true, code: cached.bytes.toString('utf-8') }
  }
  const r = await fetchBytes(url, REQUIRE_MAX_BYTES)
  if (!r.ok || !r.bytes) {
    // 신선하지 않아도 예전 캐시가 있으면 오프라인/일시 장애 시 그거라도 쓴다.
    if (cached) return { ok: true, code: cached.bytes.toString('utf-8') }
    return { ok: false, error: r.error ?? '다운로드 실패' }
  }
  await writeCache(hash, r.bytes, { url, fetchedAt: Date.now(), contentType: r.contentType ?? '' })
  return { ok: true, code: r.bytes.toString('utf-8') }
}

/** 여러 @require 를 순서대로 내려받아 하나의 코드 문자열로 이어붙인다. */
export async function resolveRequireBundle(urls: readonly string[]): Promise<{ bundle: string; errors: string[] }> {
  const parts: string[] = []
  const errors: string[] = []
  for (const url of urls) {
    const r = await resolveRequire(url)
    if (r.ok && r.code !== undefined) {
      parts.push(`\n;/* @require ${JSON.stringify(url)} */\n${r.code}\n`)
    } else {
      errors.push(`${url}: ${r.error ?? '알 수 없는 오류'}`)
    }
  }
  return { bundle: parts.join('\n'), errors }
}

const TEXT_MIME_RE = /^(text\/|application\/(json|javascript|xml|x-javascript))/i

/** @resource 하나를 받아 GM_getResourceText/URL 이 바로 쓸 수 있는 형태로 만든다. */
export async function resolveResource(url: string): Promise<UserscriptResourceCacheEntry> {
  const r = await fetchBytes(url, RESOURCE_MAX_BYTES)
  if (!r.ok || !r.bytes) {
    return { mime: '', error: r.error ?? '다운로드 실패' }
  }
  const mime = r.contentType?.split(';')[0]?.trim() || 'application/octet-stream'
  const entry: UserscriptResourceCacheEntry = { mime }
  if (TEXT_MIME_RE.test(mime)) {
    try { entry.text = r.bytes.toString('utf-8') } catch { /* ignore */ }
  }
  entry.dataUrl = `data:${mime};base64,${r.bytes.toString('base64')}`
  return entry
}

export async function resolveResources(
  list: readonly { name: string; url: string }[],
): Promise<Record<string, UserscriptResourceCacheEntry>> {
  const out: Record<string, UserscriptResourceCacheEntry> = {}
  for (const res of list) {
    if (!res.name) continue
    out[res.name] = await resolveResource(res.url)
  }
  return out
}
