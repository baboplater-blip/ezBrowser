/**
 * 비밀번호 CSV — 크롬/엣지 "비밀번호 내보내기" 형식과 호환.
 *
 * 크롬 계열 CSV 열: `name,url,username,password`(+ 일부는 `note`). 우리는 헤더 이름을
 * 유연하게 인식한다(대소문자 무시, `login_uri`/`website`/`origin` 등 흔한 동의어 허용) —
 * 그래야 크롬·엣지·비트워든 등 어디서 내보낸 파일이든 열린다.
 *
 * 순수 함수 — Electron·파일시스템 의존 없음(main 쪽 IPC 가 파일 읽기/쓰기를 담당).
 */

export interface CsvExportRow {
  name: string
  url: string
  username: string
  password: string
  note: string
}

export interface CsvParsedRow {
  url: string
  username: string
  password: string
  name?: string
}

function toCsvField(v: string): string {
  const s = String(v ?? '')
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

/** 크롬 호환 CSV 문자열을 만든다(헤더 포함, CRLF 개행). */
export function buildCsv(rows: CsvExportRow[]): string {
  const header = 'name,url,username,password,note'
  const lines = rows.map((r) =>
    [r.name, r.url, r.username, r.password, r.note].map(toCsvField).join(','))
  return [header, ...lines].join('\r\n') + '\r\n'
}

/**
 * RFC4180 스타일 CSV 파서 — 따옴표 필드, 이스케이프된 `""`, CRLF/LF 개행을 모두 처리한다.
 * 정규식 split 으로는 따옴표 안의 쉼표·개행을 다루지 못해 직접 상태기계로 짠다.
 */
function parseCsvRows(content: string): string[][] {
  const s = content.replace(/^﻿/, '') // UTF-8 BOM 제거(엑셀·윈도우 메모장이 흔히 붙인다)
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0
  let sawAnyField = false
  while (i < s.length) {
    const c = s[i]
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i += 1; continue
      }
      field += c; i += 1; continue
    }
    if (c === '"') { inQuotes = true; i += 1; sawAnyField = true; continue }
    if (c === ',') { row.push(field); field = ''; i += 1; sawAnyField = true; continue }
    if (c === '\r') { i += 1; continue }
    if (c === '\n') {
      row.push(field)
      if (sawAnyField || field !== '') rows.push(row)
      row = []; field = ''; i += 1; sawAnyField = false
      continue
    }
    field += c; i += 1; sawAnyField = true
  }
  if (sawAnyField || field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => !(r.length === 1 && (r[0] ?? '').trim() === ''))
}

const HEADER_ALIASES = {
  url: ['url', 'login_uri', 'website', 'origin', 'site', 'uri'],
  username: ['username', 'login_username', 'user', 'id', '아이디', '사용자명'],
  password: ['password', 'login_password', 'pw', '비밀번호'],
  name: ['name', 'title', '이름'],
}

function matchHeader(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias)
    if (idx >= 0) return idx
  }
  return -1
}

const MAX_ROWS = 20_000

/**
 * CSV 텍스트를 파싱한다. 헤더 행에서 url/username/password 열을 모두 찾으면 그 순서를 쓰고,
 * 못 찾으면(헤더가 없는 순수 데이터) `name,url,username,password[,note]` 고정 순서로 간주한다.
 */
export function parseCsv(content: string): CsvParsedRow[] {
  const rows = parseCsvRows(content)
  if (rows.length === 0) return []
  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase())
  const idx = {
    url: matchHeader(header, HEADER_ALIASES.url),
    username: matchHeader(header, HEADER_ALIASES.username),
    password: matchHeader(header, HEADER_ALIASES.password),
    name: matchHeader(header, HEADER_ALIASES.name),
  }
  const hasHeader = idx.url >= 0 && idx.username >= 0 && idx.password >= 0
  const dataRows = hasHeader ? rows.slice(1) : rows
  const out: CsvParsedRow[] = []
  for (const cols of dataRows) {
    if (out.length >= MAX_ROWS) break
    const url = (hasHeader ? cols[idx.url] : cols[1]) ?? ''
    const username = (hasHeader ? cols[idx.username] : cols[2]) ?? ''
    const password = (hasHeader ? cols[idx.password] : cols[3]) ?? ''
    const nameRaw = hasHeader ? (idx.name >= 0 ? cols[idx.name] : undefined) : cols[0]
    if (!url.trim() || !username.trim() || !password) continue
    out.push({
      url: url.trim(),
      username: username.trim(),
      password,
      name: nameRaw?.trim() || undefined,
    })
  }
  return out
}
