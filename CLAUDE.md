# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Vite dev server on port 5173
npm run build     # Production build
npm run preview   # Serve the production build
npm test          # Geometry + boolean smoke tests (plain node assert, no framework)
npm run test:e2e  # Headless-browser E2E (needs dev server running + a one-time
                  #   `node node_modules/playwright-core/cli.js install chromium-headless-shell`)
```

No linter is configured.

## What this is

LOGOLAB — a single-page React app (Vite, no backend): a lean Figma-like editor focused on logo development. Infinite canvas, drawing tools (shapes, pen, shape builder), and an experimental SVG effect engine; everything exports as SVG markup that pastes cleanly into Figma.

**Hard constraints (verified by tests/e2e.mjs):**
- Effects emit plain SVG geometry only (`use`, `rect`, `path`, `clipPath`, transforms) — never SVG filters. Pasted output must survive Figma import intact.
- Solid vectors only — no `opacity`/`fill-opacity` in exported content. Opacity (attributes *and* `style=""`) plus filters are stripped from pasted SVG. UI-only overlays (grid, drafts, marquee) may use 8-digit-hex alpha because they carry `data-ui` and are removed at export.
- Pasted logos always keep their original colors (no recolor UI). Drawn shapes have a solid fill picker. Effect tinting is limited to stroke-based chrome (Rings) and inherit-fallback fills (Mosaic).
- Canvas background is dark (`#1E1E1E`) or white only. UI chrome is Figma-style dark — tokens, component rules, and styling conventions live in `DESIGN.md`; follow it for any UI change.

## Architecture

Files: `src/App.jsx` (state, canvas, interactions, export), `src/effects.jsx` (effect engine), `src/shapes.js` (pure shape geometry — node-testable, no DOM), `src/icons.jsx` (toolbar icons), `src/font.js` (pixel wordmark).

### Objects & sources

The board holds `objects` (z-ordered array; position `x/y` in **grid cells**). Two kinds:
- **Pasted logos** — `o.code` (full `<svg>` markup or raw path `d`), sanitized/measured by `parseSvgMarkup` → `{ items, x, y, w, h, grid }`; `detectGrid` finds the symbol's base unit via float-tolerant GCD of straight-edge vertex coords (curves/transforms disable detection). With a grid, 1 symbol unit maps to 1 canvas cell; otherwise `sizeCells` sets height.
- **Drawn shapes** — `o.shape` (see `src/shapes.js`: poly/star parametric via `o.w/o.h`; line/pen/raw carry own coords). **Rect/ellipse are born as pen paths** (`toPen` at commit) so their anchors are editable immediately; poly/star/line stay parametric (sides/points/thickness sliders) until converted via the "Edit points" button or canvas double-click. `buildShapeSrc` turns them into a normal source with `grid = { unit: 1 }`, so **placement, effects, raster sampling, and export need zero special cases for shapes**. Free shapes (pen/line/raw) derive their bbox from geometry; the object's `x/y` must track that bbox origin (see the anchor-drag compensation in App.jsx).

Both go through `parseCache` keyed by `srcKey(o)` (code, or shape JSON + size + fill).

### Editor interactions (App.jsx)

- Tools: select (V), hand (H/Space), rect (R), ellipse (O), poly, star, line (L), pen (P). Drag-to-draw snaps to whole cells (line: half; Alt disables snap, Shift constrains square/45°). Click without drag = default 4×4 shape.
- Pen: click = corner anchor, click-drag = symmetric bezier handles; click first anchor to close, Enter/double-click for open, Esc cancels. Selected pen paths expose draggable anchors on canvas.
- Node editing (select tool): double-click a pasted logo → `convertToPaths`; double-click a parametric shape (or a pen with live rounding) → `convertShapeToPen`; double-click a pen outline → insert anchor at that point (`nearestOnPen` + `insertAnchor`, de Casteljau split); Delete with a selected anchor removes it (`removeAnchor`; empty path deletes the object). All double-clicks resolve in `onBoardDoubleClick` via `elementFromPoint` — pointer capture retargets `dblclick` to the board, so child `onDoubleClick` handlers never fire.
- **Grid snapping contract**: anchors snap to the half-cell grid in *absolute world coords* (drag, straight-segment insert); handle tips snap to the quarter-cell grid, also absolute; Alt disables snapping for anchor drags only. Generated handles obey the same grid — ellipse/rounding kappa handles snap to quarter-cell (skipped when snapping would overshoot the radius), smooth-toggle handles likewise. Curve splits keep the exact `t` (outline fidelity beats grid there; the first drag re-snaps).
- Selection: multi via Shift+click / marquee / Ctrl+A. Single resizable selection gets corner handles (`applyResize`; free shapes scale via `scaleShape`, grid-detected logos are size-locked).
- Shape builder: boolean union/subtract/intersect/exclude via `polygon-clipping` on `shapePolys` output (curves flattened; subtract = bottom minus above, Figma-style). Result is a `raw` shape (MultiPolygon, evenodd).
- Undo/redo: `record(tag?)` snapshots the objects array **before** each mutation (immutable updates make by-reference snapshots safe); same-tag calls within 600ms coalesce (slider drags = one step). Every mutation path must call `record` first.
- Board (objects, bg, grid cell, camera) autosaves to localStorage (`logolab-board-v1`).

### Effect engine (`src/effects.jsx`)

`EFFECTS` is a registry: `{ label, params: [...], render(ctx) }`. To add an effect, add one entry — the control panel UI is generated from the declarative `params` array (`type: 'range' | 'toggle' | 'select'`, each with a `def` default). Effects chain: each stage renders into `<defs>` and the next stage references it via `ctx.srcId`.

- **Everything follows the canvas grid**: `ctx.cell` is the cell size; strips align to grid lines (`gridStrips`), offsets are in cells, random offsets snap to half a cell (`snapHalf`).
- Randomness goes through `ctx.rng` (seeded mulberry32); set `seeded: true` on the effect so the reroll button appears.
- Strip effects (shred, slice, wave, glitch) share `gridStrips` + `clippedCopy`; the offset applies *outside* the clip so strips travel with content.
- Raster effects (`mosaic`, `lines`, `taper`) set `raster: true` + a `sample(data, bw, bh, box, cell, p)` fn: App.jsx rasterizes the placed source once via `<img>` → offscreen canvas, the result arrives as `ctx.samples`. Samples carry the logo's local average color so output stays true to original colors.
- `outline` divides stroke-width by `ctx.scale` to compensate for the source group's scale transform.
- `refs/` holds visual reference images that motivated the effect set.

### Export

`buildExport` clones the live board `<svg>`, removes every `[data-ui]` node (grid, hit targets, selection, drafts), keeps only selected `[data-obj]` groups when exporting a selection, and adds the background rect only for whole-board export. Anything that must never export **must** carry `data-ui="1"`.

Per-effect params live on each effect instance, so switching/stacking effects preserves settings per layer.
