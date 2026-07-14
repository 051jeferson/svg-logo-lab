// Effect engine. Every effect outputs plain SVG geometry (uses, rects, paths,
// clipPaths) — no SVG filters, so pasted output survives Figma import intact.
// HARD RULES:
//  - solid vectors only — never emit opacity or any transparency
//  - the source keeps its original colors; raster-sampled effects (mosaic,
//    lines, speed) pick up the logo's local color per cell/run
//  - everything follows the active canvas grid: strips align to grid lines,
//    offsets are expressed in cells, random offsets snap to half a cell
//
// Effects are chainable: render(ctx) references the previous stage through
// ctx.srcId (an #id in <defs>), so stacking works by feeding one stage's
// output group id into the next stage's ctx.
//
// render(ctx) receives:
//   srcId      '#id' of the input stage (source or previous effect output)
//   uid        unique prefix for generated ids (clipPaths) — object+stage
//   box        placed content bbox {x,y,w,h} in world coords
//   fg, bg     theme contrast color / canvas background color
//   cell       active grid cell size (px)
//   scale      source scale (for stroke-width compensation)
//   rng        seeded PRNG () => [0,1)
//   p          effect params
//   samples    for effects with a `sample` fn: its result (raster-derived)
//
// Effects with `raster: true` get the object rasterized at box size; their
// `sample(data, bw, bh, box, cell, p)` runs on the RGBA pixel data (box-local,
// origin = box top-left) and must return world-coordinate output.

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const snapHalf = (v, cell) => Math.round(v / (cell / 2)) * (cell / 2)

const rgb = (r, g, b) => `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`

const tr = (dx, dy) => `translate(${dx} ${dy})`

const srcUse = (ctx, key = 'src') => <use key={key} href={ctx.srcId} />

// Strips aligned to the global grid, covering the content box along `dir`
// ('v' = vertical columns, 'h' = horizontal rows), spanning the box on the
// other axis (content only exists inside the box).
function gridStrips(ctx, widthCells, dir) {
  const { box, cell } = ctx
  const step = cell * widthCells
  const start = Math.floor((dir === 'v' ? box.x : box.y) / step) * step
  const end = dir === 'v' ? box.x + box.w : box.y + box.h
  const out = []
  for (let c = start; c < end; c += step) {
    out.push(
      dir === 'v'
        ? { x: c, y: box.y, w: step, h: box.h }
        : { x: box.x, y: c, w: box.w, h: step },
    )
  }
  return out
}

// One clipped + transformed copy of the input. The clip is evaluated in the
// untransformed space and the transform applies to the clipped result, so the
// strip travels (or scales) with its content — jagged silhouette, no cropping.
function clippedCopy(ctx, key, strip, transform, inset = 0, dir = 'v') {
  const id = `${ctx.uid}-${key}`
  const r =
    dir === 'v'
      ? { x: strip.x + inset, y: strip.y, w: Math.max(strip.w - inset * 2, 0.01), h: strip.h }
      : { x: strip.x, y: strip.y + inset, w: strip.w, h: Math.max(strip.h - inset * 2, 0.01) }
  return (
    <g key={id} transform={transform}>
      <clipPath id={id}>
        <rect x={r.x} y={r.y} width={r.w} height={r.h} />
      </clipPath>
      <g clipPath={`url(#${id})`}>{srcUse(ctx)}</g>
    </g>
  )
}

// Average coverage + color per grid cell (box-local raster, world output).
function cellSamples(data, bw, bh, box, cell) {
  const out = []
  for (let ly = 0; ly < bh; ly += cell) {
    for (let lx = 0; lx < bw; lx += cell) {
      let a = 0, r = 0, g = 0, b = 0, n = 0, hits = 0
      for (let sy = ly; sy < Math.min(ly + cell, bh); sy += 3) {
        for (let sx = lx; sx < Math.min(lx + cell, bw); sx += 3) {
          const i = (sy * bw + sx) * 4
          const al = data[i + 3]
          a += al
          n++
          if (al > 127) {
            r += data[i]
            g += data[i + 1]
            b += data[i + 2]
            hits++
          }
        }
      }
      if (!n || !hits) continue
      out.push({ x: box.x + lx, y: box.y + ly, cov: a / n / 255, color: rgb(r / hits, g / hits, b / hits) })
    }
  }
  return out
}

// Solid runs along each grid row ('h') or column ('v'), sampled on the line's
// centerline. Run ends snap to half a grid cell; carries average source color.
function lineRuns(data, bw, bh, box, cell, dir) {
  const runs = []
  const horiz = dir === 'h'
  const aMax = horiz ? bh : bw
  const bMax = horiz ? bw : bh
  const aBase = horiz ? box.y : box.x
  const bBase = horiz ? box.x : box.y
  for (let a = 0; a < aMax; a += cell) {
    const center = Math.min(Math.round(a + cell / 2), aMax - 1)
    let run = -1
    let r = 0, g = 0, b = 0, hits = 0
    for (let q = 0; q <= bMax; q += 2) {
      const i = horiz ? (center * bw + q) * 4 : (q * bw + center) * 4
      const on = q < bMax && data[i + 3] > 127
      if (on) {
        r += data[i]
        g += data[i + 1]
        b += data[i + 2]
        hits++
      }
      if (on && run < 0) run = q
      if (!on && run >= 0) {
        const q1 = snapHalf(run, cell)
        const q2 = snapHalf(q, cell)
        if (q2 - q1 >= cell / 2) {
          runs.push({ a: aBase + a, b1: bBase + q1, b2: bBase + q2, color: rgb(r / hits, g / hits, b / hits) })
        }
        run = -1
        r = g = b = hits = 0
      }
    }
  }
  return runs
}

export const EFFECTS = {
  echo: {
    label: 'Echo',
    params: [
      { key: 'copies', label: 'Copies', type: 'range', min: 1, max: 24, step: 1, def: 6 },
      { key: 'dx', label: 'Offset X (cells)', type: 'range', min: -4, max: 4, step: 0.5, def: 0.5 },
      { key: 'dy', label: 'Offset Y (cells)', type: 'range', min: -4, max: 4, step: 0.5, def: 0 },
    ],
    render: (ctx) => {
      const { p, cell } = ctx
      const out = []
      for (let i = p.copies; i >= 1; i--) {
        out.push(
          <use key={i} href={ctx.srcId}
            transform={tr(p.dx * cell * i, p.dy * cell * i)} />,
        )
      }
      out.push(srcUse(ctx, 'front'))
      return out
    },
  },

  repeat: {
    label: 'Repeat',
    params: [
      { key: 'steps', label: 'Steps', type: 'range', min: 1, max: 4, step: 1, def: 2 },
      { key: 'gap', label: 'Gap (cells)', type: 'range', min: -1, max: 3, step: 0.25, def: 0.25 },
      { key: 'dir', label: 'Direction', type: 'select', def: 'left', options: [
        { v: 'left', label: 'Left' },
        { v: 'right', label: 'Right' },
        { v: 'up', label: 'Up' },
        { v: 'down', label: 'Down' },
      ] },
    ],
    // Fractal repeater: clip the leading half of the shape (then half of that
    // half, …) and butt each piece against the previous one, gap in cells.
    // Piece sizes snap to whole grid cells.
    render: (ctx) => {
      const { p, cell, box } = ctx
      const horiz = p.dir === 'left' || p.dir === 'right'
      const total = horiz ? box.w : box.h
      const gap = p.gap * cell
      const out = []
      let size = total
      let frontier = 0
      for (let i = 1; i <= p.steps; i++) {
        size = Math.max(Math.round(size / 2 / cell) * cell, cell)
        let strip
        let dx = 0
        let dy = 0
        if (p.dir === 'left') {
          strip = { x: box.x, y: box.y, w: size, h: box.h }
          dx = -(frontier + gap + size)
        } else if (p.dir === 'right') {
          strip = { x: box.x + box.w - size, y: box.y, w: size, h: box.h }
          dx = frontier + gap + size
        } else if (p.dir === 'up') {
          strip = { x: box.x, y: box.y, w: box.w, h: size }
          dy = -(frontier + gap + size)
        } else {
          strip = { x: box.x, y: box.y + box.h - size, w: box.w, h: size }
          dy = frontier + gap + size
        }
        frontier += gap + size
        out.push(clippedCopy(ctx, `rep-${i}`, strip, tr(dx, dy), 0, horiz ? 'v' : 'h'))
      }
      out.push(srcUse(ctx, 'front'))
      return out
    },
  },

  shred: {
    label: 'Shred',
    params: [
      { key: 'width', label: 'Strip width (cells)', type: 'range', min: 1, max: 4, step: 1, def: 1 },
      { key: 'teeth', label: 'Teeth period', type: 'range', min: 2, max: 16, step: 1, def: 2 },
      { key: 'amp', label: 'Amplitude (cells)', type: 'range', min: 0, max: 6, step: 0.5, def: 2 },
      { key: 'dir', label: 'Direction', type: 'select', def: 'v', options: [
        { v: 'v', label: 'Vertical strips' },
        { v: 'h', label: 'Horizontal strips' },
      ] },
    ],
    render: (ctx) => {
      const { p, cell } = ctx
      const strips = gridStrips(ctx, p.width, p.dir)
      return strips.map((s, i) => {
        const off = snapHalf(cell * p.amp * ((i % p.teeth) / p.teeth), cell)
        const [dx, dy] = p.dir === 'v' ? [0, off] : [off, 0]
        return clippedCopy(ctx, `shred-${i}`, s, tr(dx, dy), 0, p.dir)
      })
    },
  },

  slice: {
    label: 'Barcode',
    seeded: true,
    params: [
      { key: 'vary', label: 'Width variety (cells)', type: 'range', min: 1, max: 4, step: 1, def: 2 },
      { key: 'gap', label: 'Gap', type: 'range', min: 0, max: 0.8, step: 0.05, def: 0.3 },
      { key: 'shift', label: 'Shift (cells)', type: 'range', min: 0, max: 3, step: 0.5, def: 0 },
      { key: 'dir', label: 'Direction', type: 'select', def: 'v', options: [
        { v: 'v', label: 'Vertical bars' },
        { v: 'h', label: 'Horizontal bars' },
      ] },
    ],
    render: (ctx) => {
      const { p, rng, cell, box } = ctx
      const out = []
      const end = p.dir === 'v' ? box.x + box.w : box.y + box.h
      let c = Math.floor((p.dir === 'v' ? box.x : box.y) / cell) * cell
      let i = 0
      while (c < end) {
        const size = (1 + Math.floor(rng() * p.vary)) * cell
        const strip = p.dir === 'v'
          ? { x: c, y: box.y, w: size, h: box.h }
          : { x: box.x, y: c, w: box.w, h: size }
        const off = p.shift ? snapHalf((rng() * 2 - 1) * p.shift * cell, cell) : 0
        const [dx, dy] = p.dir === 'v' ? [0, off] : [off, 0]
        out.push(clippedCopy(ctx, `slice-${i}`, strip, tr(dx, dy), (size * p.gap) / 2, p.dir))
        c += size
        i++
      }
      return out
    },
  },

  wave: {
    label: 'Wave',
    params: [
      { key: 'width', label: 'Strip width (cells)', type: 'range', min: 1, max: 4, step: 1, def: 1 },
      { key: 'amp', label: 'Amplitude (cells)', type: 'range', min: 0, max: 4, step: 0.25, def: 1 },
      { key: 'freq', label: 'Frequency', type: 'range', min: 0.5, max: 6, step: 0.25, def: 1.5 },
      { key: 'phase', label: 'Phase', type: 'range', min: 0, max: 360, step: 5, def: 0 },
      { key: 'dir', label: 'Direction', type: 'select', def: 'v', options: [
        { v: 'v', label: 'Vertical strips' },
        { v: 'h', label: 'Horizontal strips' },
      ] },
    ],
    render: (ctx) => {
      const { p, cell } = ctx
      const strips = gridStrips(ctx, p.width, p.dir)
      return strips.map((s, i) => {
        const t = i / strips.length
        const off = cell * p.amp * Math.sin(Math.PI * 2 * p.freq * t + (p.phase * Math.PI) / 180)
        const [dx, dy] = p.dir === 'v' ? [0, off] : [off, 0]
        return clippedCopy(ctx, `wave-${i}`, s, tr(dx, dy), 0, p.dir)
      })
    },
  },

  glitch: {
    label: 'Glitch',
    seeded: true,
    params: [
      { key: 'width', label: 'Strip width (cells)', type: 'range', min: 1, max: 4, step: 1, def: 1 },
      { key: 'amp', label: 'Amplitude (cells)', type: 'range', min: 0, max: 4, step: 0.5, def: 1.5 },
      { key: 'density', label: 'Density', type: 'range', min: 0, max: 1, step: 0.05, def: 0.5 },
      { key: 'ghost', label: 'Ghost copy', type: 'toggle', def: false },
      { key: 'dir', label: 'Direction', type: 'select', def: 'h', options: [
        { v: 'h', label: 'Horizontal cuts' },
        { v: 'v', label: 'Vertical cuts' },
      ] },
    ],
    render: (ctx) => {
      const { p, rng, cell } = ctx
      const strips = gridStrips(ctx, p.width, p.dir)
      const out = []
      if (p.ghost) {
        out.push(
          <use key="ghost" href={ctx.srcId}
            transform={tr(cell / 2, p.dir === 'h' ? cell / 2 : -cell / 2)} />,
        )
      }
      strips.forEach((s, i) => {
        const hit = rng() < p.density
        const off = hit ? snapHalf((rng() * 2 - 1) * p.amp * cell, cell) : 0
        const [dx, dy] = p.dir === 'h' ? [off, 0] : [0, off]
        out.push(clippedCopy(ctx, `glitch-${i}`, s, tr(dx, dy), 0, p.dir))
      })
      return out
    },
  },

  ripple: {
    label: 'Melt',
    params: [
      { key: 'width', label: 'Strip width (cells)', type: 'range', min: 1, max: 4, step: 1, def: 1 },
      { key: 'amp', label: 'Bulge', type: 'range', min: 0, max: 0.6, step: 0.05, def: 0.3 },
      { key: 'freq', label: 'Frequency', type: 'range', min: 0.5, max: 6, step: 0.25, def: 2 },
      { key: 'phase', label: 'Phase', type: 'range', min: 0, max: 360, step: 5, def: 0 },
      { key: 'dir', label: 'Direction', type: 'select', def: 'v', options: [
        { v: 'v', label: 'Vertical strips' },
        { v: 'h', label: 'Horizontal strips' },
      ] },
    ],
    render: (ctx) => {
      const { p, box } = ctx
      const strips = gridStrips(ctx, p.width, p.dir)
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      return strips.map((s, i) => {
        const t = i / strips.length
        const k = 1 + p.amp * Math.sin(Math.PI * 2 * p.freq * t + (p.phase * Math.PI) / 180)
        const transform = p.dir === 'v'
          ? `translate(0 ${cy * (1 - k)}) scale(1 ${k})`
          : `translate(${cx * (1 - k)} 0) scale(${k} 1)`
        return clippedCopy(ctx, `ripple-${i}`, s, transform, 0, p.dir)
      })
    },
  },

  lines: {
    label: 'Lines',
    raster: true,
    params: [
      { key: 'dir', label: 'Direction', type: 'select', def: 'h', options: [
        { v: 'h', label: 'Horizontal lines' },
        { v: 'v', label: 'Vertical lines' },
      ] },
      { key: 'weight', label: 'Line weight', type: 'range', min: 0.1, max: 1, step: 0.05, def: 0.5 },
      { key: 'ramp', label: 'Weight ramp (center → edges)', type: 'range', min: 0, max: 1, step: 0.05, def: 0 },
      { key: 'caps', label: 'Caps', type: 'select', def: 'round', options: [
        { v: 'round', label: 'Round' },
        { v: 'square', label: 'Square' },
      ] },
      { key: 'dash', label: 'Dash (cells, 0 = solid)', type: 'range', min: 0, max: 6, step: 0.5, def: 0 },
      { key: 'dashGap', label: 'Dash gap (cells)', type: 'range', min: 0.5, max: 3, step: 0.5, def: 0.5 },
    ],
    sample: (data, bw, bh, box, cell, p) => lineRuns(data, bw, bh, box, cell, p.dir),
    render: (ctx) => {
      const { p, cell, samples, box } = ctx
      if (!samples) return []
      const centerA = p.dir === 'h' ? box.y + box.h / 2 : box.x + box.w / 2
      const halfSpan = (p.dir === 'h' ? box.h : box.w) / 2 || 1
      const out = []
      const pieces = (s) => {
        if (!p.dash) return [[s.b1, s.b2]]
        const seg = []
        const step = (p.dash + p.dashGap) * cell
        for (let q = s.b1; q < s.b2; q += step) {
          seg.push([q, Math.min(q + p.dash * cell, s.b2)])
        }
        return seg
      }
      samples.forEach((s, i) => {
        // Ramp: thickest line at the box center, linearly thinner toward edges.
        const d = Math.min(Math.abs(s.a + cell / 2 - centerA) / halfSpan, 1)
        const w = Math.max(cell * p.weight * (1 - p.ramp * d), 1)
        const rx = p.caps === 'round' ? w / 2 : 0
        const pad = (cell - w) / 2
        pieces(s).forEach(([q1, q2], j) => {
          if (q2 - q1 < 1) return
          out.push(
            p.dir === 'h' ? (
              <rect key={`${i}-${j}`} x={q1} y={s.a + pad} width={q2 - q1} height={w}
                rx={rx} fill={s.color} />
            ) : (
              <rect key={`${i}-${j}`} x={s.a + pad} y={q1} width={w} height={q2 - q1}
                rx={rx} fill={s.color} />
            ),
          )
        })
      })
      return out
    },
  },

  taper: {
    label: 'Speed',
    raster: true,
    params: [
      { key: 'dir', label: 'Direction', type: 'select', def: 'h', options: [
        { v: 'h', label: 'Horizontal lines' },
        { v: 'v', label: 'Vertical lines' },
      ] },
      { key: 'weight', label: 'Line weight', type: 'range', min: 0.1, max: 1, step: 0.05, def: 0.8 },
      { key: 'tip', label: 'Tip weight', type: 'range', min: 0, max: 0.9, step: 0.05, def: 0.1 },
      { key: 'flip', label: 'Flip taper', type: 'toggle', def: false },
    ],
    sample: (data, bw, bh, box, cell, p) => lineRuns(data, bw, bh, box, cell, p.dir),
    render: (ctx) => {
      const { p, cell, samples } = ctx
      if (!samples) return []
      const w = cell * p.weight
      return samples.map((s, i) => {
        const w1 = (w * (p.flip ? 1 : p.tip)) / 2
        const w2 = (w * (p.flip ? p.tip : 1)) / 2
        const c = s.a + cell / 2
        const pts = p.dir === 'h'
          ? `${s.b1},${c - w1} ${s.b2},${c - w2} ${s.b2},${c + w2} ${s.b1},${c + w1}`
          : `${c - w1},${s.b1} ${c - w2},${s.b2} ${c + w2},${s.b2} ${c + w1},${s.b1}`
        return <polygon key={i} points={pts} fill={s.color} />
      })
    },
  },

  mosaic: {
    label: 'Mosaic',
    raster: true,
    params: [
      { key: 'threshold', label: 'Threshold', type: 'range', min: 0.05, max: 0.9, step: 0.05, def: 0.35 },
      { key: 'gap', label: 'Inset', type: 'range', min: 0, max: 0.6, step: 0.05, def: 0.1 },
      { key: 'halftone', label: 'Scale by coverage (halftone)', type: 'toggle', def: false },
      { key: 'dot', label: 'Cell shape', type: 'select', def: 'square', options: [
        { v: 'square', label: 'Square' },
        { v: 'circle', label: 'Circle' },
        { v: 'diamond', label: 'Diamond' },
      ] },
    ],
    sample: (data, bw, bh, box, cell) => cellSamples(data, bw, bh, box, cell),
    render: (ctx) => {
      const { p, cell, samples } = ctx
      if (!samples) return []
      const out = []
      samples.forEach((s, i) => {
        if (s.cov <= p.threshold) return
        let size = cell * (1 - p.gap)
        if (p.halftone) size *= Math.min(1, s.cov * 1.15)
        if (size < 1) return
        const pad = (cell - size) / 2
        if (p.dot === 'circle') {
          out.push(
            <circle key={i} cx={s.x + cell / 2} cy={s.y + cell / 2} r={size / 2} fill={s.color} />,
          )
        } else if (p.dot === 'diamond') {
          const c = cell / 2
          out.push(
            <rect key={i} x={s.x + pad} y={s.y + pad} width={size} height={size}
              transform={`rotate(45 ${s.x + c} ${s.y + c})`} fill={s.color} />,
          )
        } else {
          out.push(
            <rect key={i} x={s.x + pad} y={s.y + pad} width={size} height={size} fill={s.color} />,
          )
        }
      })
      return out
    },
  },

  radial: {
    label: 'Radial',
    params: [
      { key: 'copies', label: 'Copies', type: 'range', min: 2, max: 24, step: 1, def: 8 },
      { key: 'spread', label: 'Spread°', type: 'range', min: 10, max: 360, step: 5, def: 360 },
    ],
    render: (ctx) => {
      const { p, box } = ctx
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      const out = []
      const full = p.spread === 360
      for (let i = p.copies - 1; i >= 1; i--) {
        const a = (p.spread / (full ? p.copies : p.copies - 1)) * i
        out.push(
          <use key={i} href={ctx.srcId} transform={`rotate(${a} ${cx} ${cy})`} />,
        )
      }
      out.push(srcUse(ctx, 'front'))
      return out
    },
  },

  extrude: {
    label: 'Extrude',
    params: [
      { key: 'depth', label: 'Depth (copies)', type: 'range', min: 1, max: 40, step: 1, def: 10 },
      { key: 'angle', label: 'Angle°', type: 'range', min: 0, max: 360, step: 5, def: 45 },
      { key: 'step', label: 'Step', type: 'select', def: '0.5', options: [
        { v: '0.25', label: '¼ cell' },
        { v: '0.5', label: '½ cell' },
        { v: '1', label: '1 cell' },
      ] },
    ],
    render: (ctx) => {
      const { p, cell } = ctx
      const rad = (p.angle * Math.PI) / 180
      const step = cell * Number(p.step)
      const out = []
      for (let i = p.depth; i >= 1; i--) {
        out.push(
          <use key={i} href={ctx.srcId}
            transform={tr(Math.cos(rad) * step * i, Math.sin(rad) * step * i)} />,
        )
      }
      out.push(srcUse(ctx, 'front'))
      return out
    },
  },

  skew: {
    label: 'Skew',
    params: [
      { key: 'sx', label: 'Shear X (cells)', type: 'range', min: -6, max: 6, step: 0.5, def: 2 },
      { key: 'sy', label: 'Shear Y (cells)', type: 'range', min: -6, max: 6, step: 0.5, def: 0 },
      { key: 'stepped', label: 'Stepped (follow grid)', type: 'toggle', def: true },
    ],
    render: (ctx) => {
      const { p, cell, box } = ctx
      // Stepped: shear as a staircase — 1-cell strips, each offset snapped to
      // half a cell, total spread = N cells. Uses X shear; falls back to Y.
      if (p.stepped && (p.sx !== 0 || p.sy !== 0)) {
        const useX = p.sx !== 0
        const strips = gridStrips(ctx, 1, useX ? 'h' : 'v')
        const n = Math.max(strips.length - 1, 1)
        return strips.map((s, i) => {
          const off = snapHalf((i / n - 0.5) * (useX ? p.sx : p.sy) * cell, cell)
          const [dx, dy] = useX ? [off, 0] : [0, off]
          return clippedCopy(ctx, `skew-${i}`, s, tr(dx, dy), 0, useX ? 'h' : 'v')
        })
      }
      const cx = box.x + box.w / 2
      const cy = box.y + box.h / 2
      // Smooth shear: the far edge shifts by exactly N cells across the box.
      const tx = box.h ? (p.sx * cell) / box.h : 0
      const ty = box.w ? (p.sy * cell) / box.w : 0
      return [
        <g key="skew"
          transform={`translate(${cx} ${cy}) matrix(1 ${ty} ${tx} 1 0 0) translate(${-cx} ${-cy})`}>
          {srcUse(ctx)}
        </g>,
      ]
    },
  },

  outline: {
    label: 'Rings',
    params: [
      { key: 'rings', label: 'Rings', type: 'range', min: 1, max: 8, step: 1, def: 4 },
      { key: 'gap', label: 'Ring width (cells)', type: 'range', min: 0.125, max: 1, step: 0.125, def: 0.25 },
    ],
    render: (ctx) => {
      const { p, fg, bg, scale, cell } = ctx
      const out = []
      for (let i = p.rings; i >= 1; i--) {
        const color = i % 2 === 1 ? fg : bg
        out.push(
          <use key={i} href={ctx.srcId} fill={color} stroke={color}
            strokeWidth={(i * p.gap * cell * 2) / scale} strokeLinejoin="miter" />,
        )
      }
      out.push(srcUse(ctx, 'front'))
      return out
    },
  },

  // Solid monochrome silhouette (logo mark / stamp plate).
  cutout: {
    label: 'Cutout',
    params: [
      { key: 'pad', label: 'Expand (cells)', type: 'range', min: 0, max: 3, step: 0.25, def: 0.5 },
      { key: 'invert', label: 'Knockout (bg fill)', type: 'toggle', def: false },
    ],
    render: (ctx) => {
      const { p, fg, bg, scale, cell } = ctx
      const sw = (p.pad * cell * 2) / scale
      if (p.invert) {
        return [
          <use key="k" href={ctx.srcId} fill={bg} stroke={bg}
            strokeWidth={sw} strokeLinejoin="round" />,
        ]
      }
      return [
        <use key="c" href={ctx.srcId} fill={fg} stroke={fg}
          strokeWidth={sw} strokeLinejoin="round" />,
      ]
    },
  },

  // Circular halftone from raster samples (grid-aligned dots).
  halftone: {
    label: 'Halftone',
    raster: true,
    params: [
      { key: 'min', label: 'Min coverage', type: 'range', min: 0.05, max: 0.6, step: 0.05, def: 0.15 },
      { key: 'scale', label: 'Dot scale', type: 'range', min: 0.3, max: 1.2, step: 0.05, def: 0.9 },
    ],
    sample: (data, bw, bh, box, cell, p) =>
      cellSamples(data, bw, bh, box, cell).filter((s) => s.cov >= p.min),
    render: (ctx) => {
      const { samples, cell, p } = ctx
      if (!samples?.length) return null
      return samples.map((s, i) => {
        const r = Math.max(cell * 0.12, (cell / 2) * s.cov * p.scale)
        return (
          <circle key={i} cx={s.x + cell / 2} cy={s.y + cell / 2} r={r} fill={s.color} />
        )
      })
    },
  },

  // Grid of offset stamps (poster / identity system look).
  stamp: {
    label: 'Stamp grid',
    params: [
      { key: 'cols', label: 'Columns', type: 'range', min: 1, max: 6, step: 1, def: 3 },
      { key: 'rows', label: 'Rows', type: 'range', min: 1, max: 6, step: 1, def: 2 },
      { key: 'gap', label: 'Gap (cells)', type: 'range', min: 0, max: 4, step: 0.25, def: 0.5 },
    ],
    render: (ctx) => {
      const { p, box, cell } = ctx
      const out = []
      const stepX = box.w + p.gap * cell
      const stepY = box.h + p.gap * cell
      const ox = -((p.cols - 1) * stepX) / 2
      const oy = -((p.rows - 1) * stepY) / 2
      for (let r = 0; r < p.rows; r++) {
        for (let c = 0; c < p.cols; c++) {
          if (r === 0 && c === 0) continue // origin copy comes last as front
          out.push(
            <use key={`${r}-${c}`} href={ctx.srcId}
              transform={tr(ox + c * stepX, oy + r * stepY)} />,
          )
        }
      }
      out.push(
        <use key="front" href={ctx.srcId} transform={tr(ox, oy)} />,
      )
      return out
    },
  },

  // Rectangular frame around the mark (badge / lockup). Solid vectors only.
  frame: {
    label: 'Frame',
    params: [
      { key: 'pad', label: 'Padding (cells)', type: 'range', min: 0.25, max: 4, step: 0.25, def: 1 },
      { key: 'weight', label: 'Stroke (cells)', type: 'range', min: 0.125, max: 1.5, step: 0.125, def: 0.25 },
      { key: 'plate', label: 'Solid plate behind', type: 'toggle', def: false },
    ],
    render: (ctx) => {
      const { p, box, cell, fg } = ctx
      const pad = p.pad * cell
      const sw = p.weight * cell
      const x = box.x - pad
      const y = box.y - pad
      const w = box.w + pad * 2
      const h = box.h + pad * 2
      return [
        p.plate
          ? <rect key="plate" x={x} y={y} width={w} height={h} fill={fg} />
          : <rect key="stroke" x={x} y={y} width={w} height={h} fill="none" stroke={fg} strokeWidth={sw} />,
        srcUse(ctx, 'front'),
      ]
    },
  },
}

export function defaultParamsFor(type) {
  return Object.fromEntries(EFFECTS[type].params.map((p) => [p.key, p.def]))
}
