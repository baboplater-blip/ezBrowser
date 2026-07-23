import { app } from 'electron'
import { EventEmitter } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

// AI 메모리 — aside 의 "브라우징을 기억으로" 정신. 편집 가능한 마크다운 하나(userData/ai-memory.md)에
// 사용자가 저장한 개인 컨텍스트를 담고, 챗·에이전트 프롬프트에 자동 주입해 매번 재설명하지 않게 한다.
// 에이전트는 작업 중 배운 것을 remember 액션으로 append 한다("Dreaming").

export const memoryEvents = new EventEmitter()

let cache: string | null = null

function filePath(): string {
  return path.join(app.getPath('userData'), 'ai-memory.md')
}

export function initAiMemory(): void {
  if (cache !== null) return
  try {
    cache = existsSync(filePath()) ? readFileSync(filePath(), 'utf-8') : ''
  } catch (err) {
    console.warn('[ai] memory load failed', err)
    cache = ''
  }
}

export function getMemoryText(): string {
  if (cache === null) initAiMemory()
  return cache ?? ''
}

async function persist(): Promise<void> {
  try {
    await mkdir(path.dirname(filePath()), { recursive: true })
    await writeFile(filePath(), cache ?? '', 'utf-8')
  } catch (err) {
    console.warn('[ai] memory persist failed', err)
  }
}

export async function setMemoryText(text: string): Promise<void> {
  cache = String(text ?? '')
  await persist()
  memoryEvents.emit('changed', cache)
}

const MEMORY_MAX_CHARS = 20000

export async function appendMemory(text: string): Promise<void> {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return
  const cur = getMemoryText().trimEnd()
  let next = (cur ? cur + '\n' : '') + `- ${line}`
  if (next.length > MEMORY_MAX_CHARS) {
    // 무한 성장 방지 — 오래된 앞부분을 잘라내고 온전한 줄부터 유지(새 기억은 tail 이라 보존).
    next = next.slice(next.length - MEMORY_MAX_CHARS)
    const nl = next.indexOf('\n')
    if (nl >= 0) next = next.slice(nl + 1)
  }
  cache = next
  await persist()
  memoryEvents.emit('changed', cache)
}

export async function clearMemory(): Promise<void> {
  cache = ''
  await persist()
  memoryEvents.emit('changed', cache)
}

// 프롬프트 주입용 — 너무 길면 최근(뒷부분)만. append 가 tail 이므로 앞을 자르지 않으면 새 기억이 유실된다.
export function memoryBlock(maxChars = 2000): string {
  const mem = getMemoryText().trim()
  if (!mem) return ''
  const clipped = mem.length > maxChars ? '…(생략)\n' + mem.slice(mem.length - maxChars) : mem
  return '\n\n# 기억 (사용자가 저장한 개인 컨텍스트)\n"""\n' + clipped + '\n"""\n이 정보를 관련 있을 때 활용하되, 관련 없으면 무시하세요.'
}
