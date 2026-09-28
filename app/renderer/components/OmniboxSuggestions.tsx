import type { OmniboxSuggestion } from '../../shared/types'
import { useI18nT } from '../i18n'

interface Props {
  items: OmniboxSuggestion[]
  highlight: number
  onSelect: (item: OmniboxSuggestion) => void
}

const SOURCE_LABEL: Record<OmniboxSuggestion['source'], string> = {
  url: 'URL',
  history: '이력',
  bookmark: '북마크',
  tab: '열린 탭',
  search: '검색',
  action: '명령',
}

export function OmniboxSuggestions({ items, highlight, onSelect }: Props) {
  const tr = useI18nT()
  return (
    <div className="omnibox-suggestions" role="listbox">
      {items.map((item, i) => (
        <button
          key={item.id}
          role="option"
          aria-selected={i === highlight}
          className={`omnibox-suggestion ${i === highlight ? 'active' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onSelect(item) }}
        >
          <span className={`source source-${item.source}`}>{tr(`ui.omnibox.source.${item.source}`, SOURCE_LABEL[item.source])}</span>
          <span className="text">{item.text}</span>
          {item.detail && <span className="detail">{item.detail}</span>}
        </button>
      ))}
    </div>
  )
}
