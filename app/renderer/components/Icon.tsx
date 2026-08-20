import type { CSSProperties, ReactNode } from 'react'

// 외피(chrome) 공용 단색 SVG 아이콘.
// - stroke: currentColor → 부모의 color 를 자동 상속 (별도 CSS 불필요)
// - viewBox 16 / stroke 1.6 으로 광학적 굵기 통일 (24-grid 원본을 쓰는 아이콘은
//   scale(0.667) 그룹 안에서 strokeWidth 2.4 로 보정해 시각 굵기를 동일하게 유지)
// - 채움형(star-filled, sparkle, more)은 개별 path 에 fill="currentColor" stroke="none"

export type IconName =
  | 'back' | 'forward' | 'reload' | 'close' | 'plus'
  | 'grid' | 'sparkle' | 'panel-left' | 'panel-right'
  | 'star' | 'star-filled' | 'book' | 'book-open'
  | 'download' | 'command' | 'lock' | 'unlock' | 'warning' | 'gear'
  | 'pin' | 'moon' | 'volume' | 'volume-mute'
  | 'search' | 'more' | 'globe' | 'clock' | 'note' | 'inbox' | 'play'

const ICONS: Record<IconName, ReactNode> = {
  back: <path d="M10 3.2 5.2 8l4.8 4.8" />,
  forward: <path d="M6 3.2 10.8 8 6 12.8" />,
  reload: (
    <>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.52-3.68" />
      <path d="M13.2 2.6v2.8h-2.8" />
    </>
  ),
  close: <path d="M4 4l8 8M12 4l-8 8" />,
  plus: <path d="M8 3v10M3 8h10" />,
  grid: (
    <>
      <rect x="2" y="2" width="4.9" height="4.9" rx="1.1" />
      <rect x="9.1" y="2" width="4.9" height="4.9" rx="1.1" />
      <rect x="2" y="9.1" width="4.9" height="4.9" rx="1.1" />
      <rect x="9.1" y="9.1" width="4.9" height="4.9" rx="1.1" />
    </>
  ),
  sparkle: (
    <path
      d="M8 1.6 9.55 6.45 14.4 8 9.55 9.55 8 14.4 6.45 9.55 1.6 8 6.45 6.45Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  'panel-left': (
    <>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.5" />
      <path d="M6.2 2.8v10.4" />
    </>
  ),
  'panel-right': (
    <>
      <rect x="2" y="2.8" width="12" height="10.4" rx="1.5" />
      <path d="M9.8 2.8v10.4" />
    </>
  ),
  star: (
    <path d="M8 2l1.85 3.76 4.15.6-3 2.92.71 4.13L8 11.46l-3.71 1.95.71-4.13-3-2.92 4.15-.6Z" />
  ),
  'star-filled': (
    <path
      d="M8 2l1.85 3.76 4.15.6-3 2.92.71 4.13L8 11.46l-3.71 1.95.71-4.13-3-2.92 4.15-.6Z"
      fill="currentColor"
      stroke="none"
    />
  ),
  book: (
    <>
      <path d="M3 12.7a1.6 1.6 0 0 1 1.6-1.6H13" />
      <path d="M4.6 1.7H13v12.6H4.6A1.6 1.6 0 0 1 3 12.7V3.3a1.6 1.6 0 0 1 1.6-1.6Z" />
    </>
  ),
  'book-open': (
    <>
      <path d="M1.6 2.6h3.9a2.7 2.7 0 0 1 2.7 2.7v8.7a2 2 0 0 0-2-2H1.6Z" />
      <path d="M14.4 2.6h-3.9a2.7 2.7 0 0 0-2.7 2.7v8.7a2 2 0 0 1 2-2h4.6Z" />
    </>
  ),
  download: (
    <>
      <path d="M8 2.6v7.6" />
      <path d="M4.8 7.2 8 10.4l3.2-3.2" />
      <path d="M3 13.4h10" />
    </>
  ),
  command: (
    <path d="M12 2a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2 2 2 0 0 0 2-2 2 2 0 0 0-2-2H4a2 2 0 0 0-2 2 2 2 0 0 0 2 2 2 2 0 0 0 2-2V4a2 2 0 0 0-2-2 2 2 0 0 0-2 2 2 2 0 0 0 2 2h8a2 2 0 0 0 2-2 2 2 0 0 0-2-2Z" />
  ),
  lock: (
    <>
      <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.5" />
      <path d="M5.4 7V5a2.6 2.6 0 0 1 5.2 0v2" />
    </>
  ),
  unlock: (
    <>
      <rect x="3.2" y="7" width="9.6" height="6.4" rx="1.5" />
      <path d="M5.4 7V5a2.6 2.6 0 0 1 5.1-.7" />
    </>
  ),
  warning: (
    <>
      <path d="M8 2.4 14.2 13H1.8Z" />
      <path d="M8 6.6v2.8" />
      <path d="M8 11.4h.01" />
    </>
  ),
  gear: (
    // Feather 'settings' 24-grid — scale 보정으로 시각 굵기 1.6 유지
    <g transform="scale(0.667)" strokeWidth={2.4}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </g>
  ),
  pin: (
    // 푸시핀 24-grid — scale 보정
    <g transform="scale(0.667)" strokeWidth={2.4}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z" />
    </g>
  ),
  moon: <path d="M14 8.53A6 6 0 1 1 7.47 2 4.67 4.67 0 0 0 14 8.53Z" />,
  volume: (
    <>
      <path d="M7.3 3.4 4.2 6H1.9v4h2.3l3.1 2.6Z" />
      <path d="M9.8 5.8a3.1 3.1 0 0 1 0 4.4" />
      <path d="M11.9 3.9a6 6 0 0 1 0 8.2" />
    </>
  ),
  'volume-mute': (
    <>
      <path d="M7.3 3.4 4.2 6H1.9v4h2.3l3.1 2.6Z" />
      <path d="M10.6 6.2l3.6 3.6" />
      <path d="M14.2 6.2l-3.6 3.6" />
    </>
  ),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.4" />
      <path d="M10.4 10.4 13.8 13.8" />
    </>
  ),
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="3.2" cy="8" r="1.2" />
      <circle cx="8" cy="8" r="1.2" />
      <circle cx="12.8" cy="8" r="1.2" />
    </g>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M2.6 8h10.8" />
      <path d="M8 2.6c1.9 2.1 1.9 8.7 0 10.8-1.9-2.1-1.9-8.7 0-10.8Z" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.4" />
      <path d="M8 4.8V8l2.1 1.3" />
    </>
  ),
  note: (
    <>
      <path d="M4 1.9h5.4L13 5.5v7.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.9a1 1 0 0 1 1-1Z" />
      <path d="M9.4 1.9v3.6H13" />
      <path d="M5.4 8.6h5.2M5.4 11h3.4" />
    </>
  ),
  inbox: (
    <>
      <path d="M2.3 8.4h3.2l1.2 1.9h2.6l1.2-1.9h3.2" />
      <path d="M4.9 3.4h6.2a1 1 0 0 1 .93.64L13.7 8.4V12a1.3 1.3 0 0 1-1.3 1.3H3.6A1.3 1.3 0 0 1 2.3 12V8.4l1.67-4.36a1 1 0 0 1 .93-.64Z" />
    </>
  ),
  play: <path d="M5 3.2 12.2 8 5 12.8Z" />,
}

interface IconProps {
  name: IconName
  size?: number
  className?: string
  style?: CSSProperties
  title?: string
}

export function Icon({ name, size = 16, className, style, title }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      // inline-block + vertical-align: flex 버튼과 텍스트 센터링 버튼(.tab-new 등)
      // 양쪽에서 별도 CSS 없이 정렬되도록. flexShrink 0 은 flex row 축소 방지.
      style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0, ...style }}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      {ICONS[name]}
    </svg>
  )
}
