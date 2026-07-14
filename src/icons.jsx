// Minimal 16×16 line icons for the toolbar / panels (stroke = currentColor).

const base = {
  width: 15,
  height: 15,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.2,
  'aria-hidden': true,
}

export const IcSelect = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <path d="M4.2 1.8l8.4 6.3-4.1 1-1.9 4.3z" />
  </svg>
)

export const IcHand = () => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.4 8.6V4.4a.9.9 0 0 1 1.8 0V7.5M7.2 7.5V3.3a.9.9 0 0 1 1.8 0v4.2M9 7.5V4.2a.9.9 0 0 1 1.8 0v5.2c0 2.7-1.5 4.5-3.8 4.5-1.9 0-2.8-.9-3.6-2.6L2.5 9.2c-.3-.8.7-1.5 1.3-.9l1.6 1.7" />
  </svg>
)

export const IcRect = () => (
  <svg {...base}>
    <rect x="2.5" y="3.5" width="11" height="9" rx="0.5" />
  </svg>
)

export const IcEllipse = () => (
  <svg {...base}>
    <circle cx="8" cy="8" r="5.5" />
  </svg>
)

export const IcPoly = () => (
  <svg {...base} strokeLinejoin="round">
    <path d="M8 2.2l5.6 4.1-2.2 6.6H4.6L2.4 6.3z" />
  </svg>
)

export const IcStar = () => (
  <svg {...base} strokeLinejoin="round">
    <path d="M8 1.9l1.9 3.8 4.2.6-3 3 .7 4.2L8 11.5l-3.8 2 .7-4.2-3-3 4.2-.6z" />
  </svg>
)

export const IcLine = () => (
  <svg {...base} strokeLinecap="round">
    <path d="M3 13L13 3" />
  </svg>
)

export const IcPen = () => (
  <svg {...base} strokeLinejoin="round">
    <path d="M9.7 2.6l3.7 3.7L6.5 13.2 2 14l.8-4.5zM8.3 4l3.7 3.7" />
  </svg>
)

export const IcUndo = () => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round">
    <path d="M5.5 3.5L2.5 6.5l3 3M2.5 6.5H10a3.5 3.5 0 0 1 0 7H6" />
  </svg>
)

export const IcRedo = () => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round">
    <path d="M10.5 3.5l3 3-3 3M13.5 6.5H6a3.5 3.5 0 0 0 0 7h4" />
  </svg>
)

// Boolean ops — two overlapping squares.
export const IcUnion = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <path d="M2.5 2.5h7v4h4v7h-7v-4h-4z" />
  </svg>
)

export const IcSubtract = () => (
  <svg {...base}>
    <path d="M2.5 2.5h7v4h-3v3h-4z" fill="currentColor" stroke="none" />
    <rect x="6.5" y="6.5" width="7" height="7" />
  </svg>
)

export const IcIntersect = () => (
  <svg {...base}>
    <rect x="2.5" y="2.5" width="7" height="7" />
    <rect x="6.5" y="6.5" width="7" height="7" />
    <path d="M6.5 6.5h3v3h-3z" fill="currentColor" stroke="none" />
  </svg>
)

export const IcExclude = () => (
  <svg {...base} fill="currentColor" stroke="none">
    <path fillRule="evenodd" d="M2.5 2.5h7v7h-7zM6.5 6.5h7v7h-7zM6.5 6.5v3h3v-3z" />
  </svg>
)

// Alignment.
export const IcAlignL = () => (
  <svg {...base}>
    <path d="M3 2v12" />
    <rect x="4.5" y="4" width="6" height="2.6" fill="currentColor" stroke="none" />
    <rect x="4.5" y="9.4" width="9" height="2.6" fill="currentColor" stroke="none" />
  </svg>
)

export const IcAlignCX = () => (
  <svg {...base}>
    <path d="M8 2v12" />
    <rect x="5" y="4" width="6" height="2.6" fill="currentColor" stroke="none" />
    <rect x="3.5" y="9.4" width="9" height="2.6" fill="currentColor" stroke="none" />
  </svg>
)

export const IcAlignR = () => (
  <svg {...base}>
    <path d="M13 2v12" />
    <rect x="5.5" y="4" width="6" height="2.6" fill="currentColor" stroke="none" />
    <rect x="2.5" y="9.4" width="9" height="2.6" fill="currentColor" stroke="none" />
  </svg>
)

export const IcAlignT = () => (
  <svg {...base}>
    <path d="M2 3h12" />
    <rect x="4" y="4.5" width="2.6" height="6" fill="currentColor" stroke="none" />
    <rect x="9.4" y="4.5" width="2.6" height="9" fill="currentColor" stroke="none" />
  </svg>
)

export const IcAlignCY = () => (
  <svg {...base}>
    <path d="M2 8h12" />
    <rect x="4" y="5" width="2.6" height="6" fill="currentColor" stroke="none" />
    <rect x="9.4" y="3.5" width="2.6" height="9" fill="currentColor" stroke="none" />
  </svg>
)

export const IcAlignB = () => (
  <svg {...base}>
    <path d="M2 13h12" />
    <rect x="4" y="5.5" width="2.6" height="6" fill="currentColor" stroke="none" />
    <rect x="9.4" y="2.5" width="2.6" height="9" fill="currentColor" stroke="none" />
  </svg>
)

// Flip + distribute.
export const IcFlipH = () => (
  <svg {...base}>
    <path d="M8 2v12" strokeDasharray="1.5 1.5" />
    <path d="M6.5 4.5L2.5 8l4 3.5M9.5 4.5l4 3.5-4 3.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const IcFlipV = () => (
  <svg {...base}>
    <path d="M2 8h12" strokeDasharray="1.5 1.5" />
    <path d="M4.5 6.5L8 2.5l3.5 4M4.5 9.5L8 13.5l3.5-4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const IcDistH = () => (
  <svg {...base}>
    <path d="M2.5 2v12M13.5 2v12" />
    <rect x="4.5" y="5" width="2" height="6" fill="currentColor" stroke="none" />
    <rect x="9.5" y="5" width="2" height="6" fill="currentColor" stroke="none" />
  </svg>
)

export const IcDistV = () => (
  <svg {...base}>
    <path d="M2 2.5h12M2 13.5h12" />
    <rect x="5" y="4.5" width="6" height="2" fill="currentColor" stroke="none" />
    <rect x="5" y="9.5" width="6" height="2" fill="currentColor" stroke="none" />
  </svg>
)

export const IcLock = () => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="7" width="9" height="7" rx="1" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7" />
  </svg>
)

export const IcUnlock = () => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round">
    <rect x="3.5" y="7" width="9" height="7" rx="1" />
    <path d="M5.5 7V5.2a2.5 2.5 0 0 1 4.8-.8" />
  </svg>
)
