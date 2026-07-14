# LOGOLAB design system

The chrome is an instrument, not a website. Every UI decision serves one goal:
the artwork on the canvas is the brightest, most interesting thing on screen.
Influences: **Linear** (surface depth, hairline borders, restraint), **Figma**
(interaction DNA, the accent blue, panel anatomy), **Apple** (type stack,
tabular numerals, quick unobtrusive motion).

All values live as CSS custom properties in `src/styles.css`. Change tokens
there, never inline.

## Principles

1. **Chrome recedes, canvas is the stage.** Panels are *darker* than the
   canvas (`#171717` vs the fixed `#1E1E1E`), so work reads brighter than
   the tool. Never decorate panels with gradients, glows, or imagery.
2. **One accent.** `--blue #0D99FF` is the only saturated color in the UI and
   it is the same blue as on-canvas selection/handles — chrome and canvas
   always agree. Red (`--danger`) appears only for destructive/warning text.
3. **Hairlines, not walls.** Structure comes from 1px `rgba(255,255,255,…)`
   borders: `--border` (8%) for layout seams, `--border-strong` (14%) for
   interactive edges. No drop shadows on static surfaces; shadows are
   reserved for things that float (toast, future menus).
4. **Dense but breathable.** 11px base UI type, 4px spacing scale, 260px
   panels. Density is a feature — don't pad it away.
5. **Motion is feedback, never theatre.** 120ms ease-out on color/background
   only. Nothing slides, scales, or bounces except the toast entrance.
   `prefers-reduced-motion` disables all of it.

## Tokens

### Surfaces (dark → light = depth)

| Token | Value | Use |
|---|---|---|
| `--panel` | `#171717` | Side panels, top bar |
| `--bg` | `#1E1E1E` | Canvas area (**hard constraint** — dark canvas is always this, or white) |
| `--panel-2` | `#242424` | Raised: inputs, segmented, zoom cluster, hover on flat |
| `--panel-3` | `#2E2E2E` | Hover on raised / active |
| `--border` | `rgba(255,255,255,.08)` | Layout seams |
| `--border-strong` | `rgba(255,255,255,.14)` | Interactive edges, separators |

### Ink

| Token | Value | Use |
|---|---|---|
| `--text` | `#ECECEC` | Primary labels, values |
| `--text-dim` | `#969696` | Secondary: idle tools, control labels, section headers |
| `--text-faint` | `#6A6A6A` | Hints, empty states |

### Accent

| Token | Value | Use |
|---|---|---|
| `--blue` | `#0D99FF` | Active tool, primary button, checkbox on, selection tint, focus ring — and all on-canvas UI overlays (selection box, anchors, handles) |
| `--blue-down` | `#0B87E0` | Primary button hover/pressed |
| `--blue-tint` | `rgba(13,153,255,.16)` | Selected layer row background |
| `--danger` | `#F24822` | Warnings only |

### Shape, type, motion

- **Radii**: `--r-sm 4px` (inputs, small controls) · `--r-md 6px` (buttons,
  tools, segmented) · `--r-lg 8px` (cards, toast). Nothing above 8px.
- **Type**: system stack, Apple-first (`-apple-system, Inter, 'Segoe UI'…`).
  Base 11px. Section headers: 10px / 600 / uppercase / `0.07em` tracking /
  `--text-dim`. All numerals that change (coordinates, zoom, slider values)
  are mono (`--mono`) with `font-variant-numeric: tabular-nums` so they don't
  jitter.
- **Motion**: `--speed 120ms` ease-out, `background-color`/`color`/
  `border-color` only.

## Component rules

- **Buttons** — `.btn` raised surface + hairline border; `.btn-primary` is the
  single blue action per screen (Copy SVG). Verbs, sentence case, say what
  happens: "Edit points", not "Convert".
- **Toolbar tools** — 28px square, transparent idle, `--panel-2` hover, solid
  blue when active. Icons inherit `currentColor`.
- **Number fields** (`.props`/`.num`) — 2-column grid; the unit label (X, W,
  ∠°) sits *inside* the field in `--text-faint`, native spinners hidden,
  border lights up blue on focus-within.
- **Sliders** — 2px track, 12px white thumb with a soft shadow (the one
  "Apple" touch); value readout in the control header, mono.
- **Layer rows** — transparent idle, `--panel-2` hover, `--blue-tint`
  selected. Row actions appear on hover/selection only.
- **Effect cards** — `rgba(255,255,255,.03)` fill + hairline border,
  `--r-lg`. The only "card" surface in the app.
- **Hints** — `--text-faint`, line-height 1.55. Explain the next action, not
  the implementation.
- **Toast** — near-black, floats with border + shadow; the only shadowed,
  animated element.

## Canvas overlays (SVG, not CSS)

On-canvas UI (selection, anchors, handles, marquee, grid) is drawn in SVG with
`data-ui="1"` and stripped at export. Conventions:

- Stroke/fill `#0D99FF`; white fill for idle anchor/corner handles.
- Anchors are **squares**, curve-handle dots are **circles**, both
  `7px / cam.z` so they stay constant on screen.
- Overlay alpha uses 8-digit hex (allowed only because `data-ui` never
  exports).

## Hard constraints (never restyle away)

- Canvas background: `#1E1E1E` or `#FFFFFF` only.
- Exported SVG carries no opacity, no filters — UI polish must never leak
  into export markup (keep `data-ui` on every overlay).
- Class names in `styles.css` are load-bearing for `tests/e2e.mjs`
  (`.btn-primary`, `.add-fx`, `.layer`, …). Restyle values, keep names.
