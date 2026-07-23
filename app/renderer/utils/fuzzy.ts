const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ']

export function chosung(str: string): string {
  let out = ''
  for (const ch of str) {
    const code = ch.charCodeAt(0)
    if (code >= 0xAC00 && code <= 0xD7A3) {
      const idx = Math.floor((code - 0xAC00) / 588)
      const cho = CHO[idx]
      if (cho) out += cho
      else out += ch
    } else {
      out += ch
    }
  }
  return out
}

export function scoreFuzzy(label: string, query: string): number {
  if (!query) return 0
  if (label === query) return 10
  if (label.startsWith(query)) return 6
  const tokens = label.split(/\s+/)
  if (tokens.some((t) => t.startsWith(query))) return 4
  if (label.includes(query)) return 3
  const ngrams = new Set<string>()
  for (let i = 0; i < label.length - 1; i += 1) ngrams.add(label.slice(i, i + 2))
  let hits = 0
  for (let i = 0; i < query.length - 1; i += 1) {
    if (ngrams.has(query.slice(i, i + 2))) hits += 1
  }
  return (hits / Math.max(query.length - 1, 1)) * 2
}
