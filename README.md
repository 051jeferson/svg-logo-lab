# LOGOLAB

Experimental SVG logo editor — a lean, Figma-like canvas for drawing shapes, stacking geometry effects, and exporting clean SVG that pastes into Figma without filters or soft opacity.

**Stack:** React 18 · Vite 5 · pure SVG (no backend)

## Features

- **Infinite canvas** with grid snap, pan, zoom, multi-select, and undo/redo
- **Drawing tools** — rectangle, ellipse, polygon, star, line, pen (bezier anchors)
- **Shape builder** — boolean union / subtract / intersect / exclude
- **Paste logos** — drop SVG markup or path data; grid unit detection when possible
- **Effect stack** — chain stages such as Echo, Shred, Wave, Glitch, Mosaic, Halftone, Extrude, Rings, and more
- **Export** — copy SVG or download PNG; board state autosaves in `localStorage`

### Export rules (by design)

Exported output is Figma-friendly:

- Plain SVG geometry only (`path`, `rect`, `use`, `clipPath`, transforms) — **no SVG filters**
- Solid vectors only — no opacity / fill-opacity in content
- Pasted logos keep original colors

## Quick start

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

### Scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev server on port 5173 |
| `npm run build` | Production build → `dist/` |
| `npm run preview` | Serve the production build |
| `npm test` | Geometry + boolean smoke tests |
| `npm run test:e2e` | Headless browser E2E (needs dev server + Playwright Chromium once) |

E2E browser (one-time):

```bash
node node_modules/playwright-core/cli.js install chromium-headless-shell
```

## Project layout

```
src/
  App.jsx      # State, canvas, tools, export
  effects.jsx  # Effect registry + renderers
  shapes.js    # Pure geometry (node-testable)
  icons.jsx    # Toolbar icons
  font.js      # Pixel wordmark
  styles.css   # Design tokens + UI chrome
tests/         # Geometry unit tests + Playwright e2e
DESIGN.md      # UI design system
```

## Privacy

Everything runs in the browser. Board data is stored only in your browser’s `localStorage` (`logolab-board-v1`). There is no server, auth, or telemetry in this app.

## License

No license file is included yet. Add one (e.g. MIT) if you want others to reuse the code under clear terms.
