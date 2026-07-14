// Shape geometry — all coordinates are in grid-cell units, local to the object.
// Every shape renders as a single path `d` so the effect pipeline treats drawn
// shapes exactly like pasted logos (1 shape unit = 1 canvas grid cell).
//
// Parametric shapes (rect / ellipse / poly / star) are sized by the object's
// w×h box. Free shapes (pen / line / raw) carry their own coordinates and
// derive their bbox from geometry — the object's x/y must equal that bbox
// origin so the placed box hugs the shape.
//
// Shape kinds:
//   rect    { type:'rect', radius }                    radius in cells
//   ellipse { type:'ellipse' }
//   poly    { type:'poly', sides }
//   star    { type:'star', points, inner }             inner = ratio 0..1
//   line    { type:'line', pts:[[x,y],[x,y]], t }      filled bar, t = thickness
//   pen     { type:'pen', paths:[{pts, closed}], fillRule? }
//   raw     { type:'raw', polys: MultiPolygon }        boolean-op result
//
// Pen anchor: { x, y, hox, hoy, hix, hiy } — independent out/in bezier handle
// offsets (0/absent = straight on that side). The pen tool creates symmetric
// points (hix = -hox); converted SVG paths use fully independent handles.
// Legacy format ({ pts, closed } with symmetric hx/hy) is normalized by
// penPaths() so old saved boards keep working.

import polygonClipping from 'polygon-clipping'

const r4 = (v) => Math.round(v * 10000) / 10000

export const SHAPE_DEFAULTS = {
  rect: { type: 'rect', radius: 0 },
  ellipse: { type: 'ellipse' },
  poly: { type: 'poly', sides: 3, round: 0 },
  star: { type: 'star', points: 5, inner: 0.4, round: 0 },
}

export const SHAPE_NAMES = {
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  poly: 'Polygon',
  star: 'Star',
  line: 'Line',
  pen: 'Path',
  raw: 'Shape',
}

// ---------------------------------------------------------------------------
// Pen
// ---------------------------------------------------------------------------

// Normalize any pen shape (current or legacy) to [{ pts, closed }].
export function penPaths(shape) {
  const subs = shape.paths || (shape.pts ? [{ pts: shape.pts, closed: shape.closed }] : [])
  return subs.map((sp) => ({
    closed: !!sp.closed,
    pts: sp.pts.map((p) =>
      'hx' in p || 'hy' in p
        ? { x: p.x, y: p.y, hox: p.hx || 0, hoy: p.hy || 0, hix: -(p.hx || 0), hiy: -(p.hy || 0) }
        : { x: p.x, y: p.y, hox: p.hox || 0, hoy: p.hoy || 0, hix: p.hix || 0, hiy: p.hiy || 0 },
    ),
  }))
}

function penSegs(sp) {
  const segs = []
  const n = sp.pts.length
  const last = sp.closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const a = sp.pts[i]
    const b = sp.pts[(i + 1) % n]
    segs.push({
      a, b,
      curved: !!(a.hox || a.hoy || b.hix || b.hiy),
      c1: { x: a.x + (a.hox || 0), y: a.y + (a.hoy || 0) },
      c2: { x: b.x + (b.hix || 0), y: b.y + (b.hiy || 0) },
    })
  }
  return segs
}

// `d` string for normalized paths.
export function penD(paths) {
  let d = ''
  for (const sp of paths) {
    if (sp.pts.length < 2) continue
    d += `${d ? ' ' : ''}M ${r4(sp.pts[0].x)} ${r4(sp.pts[0].y)}`
    for (const s of penSegs(sp)) {
      d += s.curved
        ? ` C ${r4(s.c1.x)} ${r4(s.c1.y)} ${r4(s.c2.x)} ${r4(s.c2.y)} ${r4(s.b.x)} ${r4(s.b.y)}`
        : ` L ${r4(s.b.x)} ${r4(s.b.y)}`
    }
    if (sp.closed) d += ' Z'
  }
  return d
}

const cubicAt = (p0, p1, p2, p3, t) => {
  const u = 1 - t
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

// Interior t values where the cubic's 1D derivative is zero (bbox extrema).
function cubicExtrema(p0, p1, p2, p3) {
  const a = 3 * (p3 - 3 * p2 + 3 * p1 - p0)
  const b = 6 * (p2 - 2 * p1 + p0)
  const c = 3 * (p1 - p0)
  const out = []
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) > 1e-9) {
      const t = -c / b
      if (t > 0 && t < 1) out.push(t)
    }
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const s = Math.sqrt(disc)
      for (const t of [(-b + s) / (2 * a), (-b - s) / (2 * a)]) {
        if (t > 0 && t < 1) out.push(t)
      }
    }
  }
  return out
}

// Exact bbox over all subpaths (anchors + cubic extrema).
export function penBBox(paths) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  const add = (x, y) => {
    x1 = Math.min(x1, x); y1 = Math.min(y1, y)
    x2 = Math.max(x2, x); y2 = Math.max(y2, y)
  }
  for (const sp of paths) {
    for (const p of sp.pts) add(p.x, p.y)
    for (const s of penSegs(sp)) {
      if (!s.curved) continue
      for (const t of cubicExtrema(s.a.x, s.c1.x, s.c2.x, s.b.x)) {
        add(cubicAt(s.a.x, s.c1.x, s.c2.x, s.b.x, t), cubicAt(s.a.y, s.c1.y, s.c2.y, s.b.y, t))
      }
      for (const t of cubicExtrema(s.a.y, s.c1.y, s.c2.y, s.b.y)) {
        add(cubicAt(s.a.x, s.c1.x, s.c2.x, s.b.x, t), cubicAt(s.a.y, s.c1.y, s.c2.y, s.b.y, t))
      }
    }
  }
  if (x1 === Infinity) return { x: 0, y: 0, w: 0.01, h: 0.01 }
  return { x: x1, y: y1, w: Math.max(x2 - x1, 0.01), h: Math.max(y2 - y1, 0.01) }
}

function penRing(sp) {
  if (sp.pts.length < 2) return []
  const ring = [[sp.pts[0].x, sp.pts[0].y]]
  for (const s of penSegs(sp)) {
    if (s.curved) {
      const STEPS = 24
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS
        ring.push([
          cubicAt(s.a.x, s.c1.x, s.c2.x, s.b.x, t),
          cubicAt(s.a.y, s.c1.y, s.c2.y, s.b.y, t),
        ])
      }
    } else {
      ring.push([s.b.x, s.b.y])
    }
  }
  return ring
}

// ---------------------------------------------------------------------------
// SVG path `d` → pen paths (full command set, curves become cubic handles)
// ---------------------------------------------------------------------------

// One ≤90° arc segment → cubic control points (SVG spec F.6.5 style).
function arcCubics(x1, y1, rx, ry, phiDeg, laf, sf, x2, y2) {
  rx = Math.abs(rx); ry = Math.abs(ry)
  if (!rx || !ry) return null // degenerate → straight line
  const phi = (phiDeg * Math.PI) / 180
  const cp = Math.cos(phi), sp = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = cp * dx + sp * dy
  const y1p = -sp * dx + cp * dy
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if (lam > 1) {
    const s = Math.sqrt(lam)
    rx *= s; ry *= s
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let co = Math.sqrt(Math.max(num / den, 0))
  if (laf === sf) co = -co
  const cxp = (co * rx * y1p) / ry
  const cyp = (-co * ry * x1p) / rx
  const cx = cp * cxp - sp * cyp + (x1 + x2) / 2
  const cy = sp * cxp + cp * cyp + (y1 + y2) / 2
  const ang = (ux, uy, vx, vy) => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1
    const dot = Math.min(Math.max((ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy)), -1), 1)
    return sign * Math.acos(dot)
  }
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!sf && dt > 0) dt -= Math.PI * 2
  if (sf && dt < 0) dt += Math.PI * 2
  const nSeg = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)))
  const out = []
  const at = (t) => {
    const c = Math.cos(t), s = Math.sin(t)
    return [cx + rx * cp * c - ry * sp * s, cy + rx * sp * c + ry * cp * s]
  }
  const dAt = (t) => {
    const c = Math.cos(t), s = Math.sin(t)
    return [-rx * cp * s - ry * sp * c, -rx * sp * s + ry * cp * c]
  }
  for (let i = 0; i < nSeg; i++) {
    const ta = t1 + (dt * i) / nSeg
    const tb = t1 + (dt * (i + 1)) / nSeg
    const k = (4 / 3) * Math.tan((tb - ta) / 4)
    const [ax, ay] = at(ta)
    const [bx, by] = at(tb)
    const [dax, day] = dAt(ta)
    const [dbx, dby] = dAt(tb)
    out.push([ax + k * dax, ay + k * day, bx - k * dbx, by - k * dby, bx, by])
  }
  return out
}

// Parse a path `d` into pen paths. Returns [{pts, closed}] or null on failure.
export function dToPen(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)
  if (!tokens) return null
  const paths = []
  let cur = null
  let cmd = ''
  let cx = 0, cy = 0, sx = 0, sy = 0
  let pc2 = null // previous C/S second control (for S reflection)
  let pq = null  // previous Q/T control (for T reflection)
  let i = 0
  const isCmd = (t) => /^[a-zA-Z]$/.test(t)
  const num = () => {
    if (i >= tokens.length || isCmd(tokens[i])) throw new Error('bad d')
    return Number(tokens[i++])
  }
  const flush = () => {
    if (cur && cur.pts.length >= 2) paths.push(cur)
    cur = null
  }
  const ensure = () => {
    if (!cur) cur = { pts: [{ x: cx, y: cy, hox: 0, hoy: 0, hix: 0, hiy: 0 }], closed: false }
  }
  const last = () => cur.pts[cur.pts.length - 1]
  const lineTo = (x, y) => {
    ensure()
    cur.pts.push({ x, y, hox: 0, hoy: 0, hix: 0, hiy: 0 })
    cx = x; cy = y
  }
  const cubicTo = (x1, y1, x2, y2, x, y) => {
    ensure()
    const a = last()
    a.hox = r4(x1 - a.x)
    a.hoy = r4(y1 - a.y)
    cur.pts.push({ x, y, hox: 0, hoy: 0, hix: r4(x2 - x), hiy: r4(y2 - y) })
    cx = x; cy = y
  }
  const closeSub = () => {
    if (cur && cur.pts.length >= 2) {
      const f = cur.pts[0]
      const l = cur.pts[cur.pts.length - 1]
      if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) {
        // Closing point coincides with the start: its handles belong to it.
        f.hix = l.hix
        f.hiy = l.hiy
        if (l.hox || l.hoy) { f.hox = l.hox; f.hoy = l.hoy }
        cur.pts.pop()
      }
      cur.closed = true
      paths.push(cur)
    }
    cur = null
    cx = sx; cy = sy
  }
  try {
    while (i < tokens.length) {
      if (isCmd(tokens[i])) cmd = tokens[i++]
      const rel = cmd === cmd.toLowerCase()
      const C = cmd.toUpperCase()
      let keepRefl = false
      switch (C) {
        case 'M': {
          flush()
          const x = num() + (rel ? cx : 0)
          const y = num() + (rel ? cy : 0)
          cx = x; cy = y; sx = x; sy = y
          cur = { pts: [{ x, y, hox: 0, hoy: 0, hix: 0, hiy: 0 }], closed: false }
          cmd = rel ? 'l' : 'L'
          break
        }
        case 'L': lineTo(num() + (rel ? cx : 0), num() + (rel ? cy : 0)); break
        case 'H': lineTo(num() + (rel ? cx : 0), cy); break
        case 'V': lineTo(cx, num() + (rel ? cy : 0)); break
        case 'C': {
          const x1 = num() + (rel ? cx : 0), y1 = num() + (rel ? cy : 0)
          const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0)
          const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
          cubicTo(x1, y1, x2, y2, x, y)
          pc2 = [x2, y2]
          keepRefl = true
          break
        }
        case 'S': {
          const x1 = pc2 ? 2 * cx - pc2[0] : cx
          const y1 = pc2 ? 2 * cy - pc2[1] : cy
          const x2 = num() + (rel ? cx : 0), y2 = num() + (rel ? cy : 0)
          const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
          cubicTo(x1, y1, x2, y2, x, y)
          pc2 = [x2, y2]
          keepRefl = true
          break
        }
        case 'Q': case 'T': {
          let qx, qy
          if (C === 'Q') {
            qx = num() + (rel ? cx : 0)
            qy = num() + (rel ? cy : 0)
          } else {
            qx = pq ? 2 * cx - pq[0] : cx
            qy = pq ? 2 * cy - pq[1] : cy
          }
          const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
          cubicTo(
            cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy),
            x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y),
            x, y,
          )
          pq = [qx, qy]
          keepRefl = true
          break
        }
        case 'A': {
          const rx = num(), ry = num(), rot = num()
          const laf = num() ? 1 : 0, sf = num() ? 1 : 0
          const x = num() + (rel ? cx : 0), y = num() + (rel ? cy : 0)
          const segs = arcCubics(cx, cy, rx, ry, rot, laf, sf, x, y)
          if (!segs) lineTo(x, y)
          else for (const [a1, b1, a2, b2, ax, ay] of segs) cubicTo(a1, b1, a2, b2, ax, ay)
          break
        }
        case 'Z': closeSub(); break
        default: return null
      }
      if (!keepRefl) {
        pc2 = null
        pq = null
      } else if (C === 'Q' || C === 'T') pc2 = null
      else pq = null
    }
    flush()
  } catch {
    return null
  }
  return paths.length ? paths : null
}

// ---------------------------------------------------------------------------
// Live corner rounding (Illustrator-style) — non-destructive: applied at
// render time, the original anchors stay editable. Each straight corner is
// replaced by two anchors offset r along the edges with circular-ish cubic
// handles (k = 0.5523). r is in cells, so the new anchors land on the grid
// for axis-aligned edges.
// ---------------------------------------------------------------------------

const K_ARC = 0.5523

export function ringToPaths(ring) {
  return [{
    closed: true,
    pts: ring.map(([x, y]) => ({ x, y, hox: 0, hoy: 0, hix: 0, hiy: 0 })),
  }]
}

export function roundPen(paths, r) {
  if (!r) return paths
  return paths.map((sp) => {
    const n = sp.pts.length
    if (n < 3) return sp
    const out = []
    for (let i = 0; i < n; i++) {
      const p = sp.pts[i]
      const isEnd = !sp.closed && (i === 0 || i === n - 1)
      const prev = sp.pts[(i - 1 + n) % n]
      const next = sp.pts[(i + 1) % n]
      const straight = !p.hix && !p.hiy && !p.hox && !p.hoy &&
        !prev.hox && !prev.hoy && !next.hix && !next.hiy
      if (isEnd || !straight) {
        out.push({ ...p })
        continue
      }
      const d1 = Math.hypot(prev.x - p.x, prev.y - p.y)
      const d2 = Math.hypot(next.x - p.x, next.y - p.y)
      const rr = Math.min(r, d1 / 2, d2 / 2)
      if (rr < 1e-6 || d1 < 1e-9 || d2 < 1e-9) {
        out.push({ ...p })
        continue
      }
      const v1 = [(prev.x - p.x) / d1, (prev.y - p.y) / d1]
      const v2 = [(next.x - p.x) / d2, (next.y - p.y) / d2]
      if (Math.abs(v1[0] * v2[1] - v1[1] * v2[0]) < 1e-6) {
        out.push({ ...p }) // collinear — nothing to round
        continue
      }
      // On axis-aligned edges the arc handles snap to the quarter-cell grid
      // (skipped when the snap would overshoot the corner offset rr).
      const kLen = (axis) => {
        if (!axis) return rr * K_ARC
        const s = Math.round(rr * K_ARC * 4) / 4
        return s > 0 && s <= rr ? s : rr * K_ARC
      }
      const axis1 = Math.abs(v1[0]) < 1e-9 || Math.abs(v1[1]) < 1e-9
      const axis2 = Math.abs(v2[0]) < 1e-9 || Math.abs(v2[1]) < 1e-9
      const k1 = kLen(axis1), k2 = kLen(axis2)
      out.push({
        x: r4(p.x + v1[0] * rr), y: r4(p.y + v1[1] * rr),
        hix: 0, hiy: 0,
        hox: r4(-v1[0] * k1), hoy: r4(-v1[1] * k1),
      })
      out.push({
        x: r4(p.x + v2[0] * rr), y: r4(p.y + v2[1] * rr),
        hix: r4(-v2[0] * k2), hiy: r4(-v2[1] * k2),
        hox: 0, hoy: 0,
      })
    }
    return { closed: sp.closed, pts: out }
  })
}

// Nearest point on the outline of normalized pen paths (local coords).
// Cubics are flattened; t is remapped so it can drive insertAnchor directly.
// → { pi, si, t, x, y, dist } or null.
export function nearestOnPen(paths, x, y) {
  let best = null
  const consider = (pi, si, t, px, py) => {
    const d = Math.hypot(px - x, py - y)
    if (!best || d < best.dist) best = { pi, si, t, x: px, y: py, dist: d }
  }
  const project = (pi, si, t0, t1, ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay
    const len2 = dx * dx + dy * dy
    const u = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2))
    consider(pi, si, t0 + (t1 - t0) * u, ax + dx * u, ay + dy * u)
  }
  paths.forEach((sp, pi) => {
    penSegs(sp).forEach((s, si) => {
      if (!s.curved) {
        project(pi, si, 0, 1, s.a.x, s.a.y, s.b.x, s.b.y)
        return
      }
      const STEPS = 32
      let px = s.a.x, py = s.a.y
      for (let i = 1; i <= STEPS; i++) {
        const t = i / STEPS
        const qx = cubicAt(s.a.x, s.c1.x, s.c2.x, s.b.x, t)
        const qy = cubicAt(s.a.y, s.c1.y, s.c2.y, s.b.y, t)
        project(pi, si, (i - 1) / STEPS, t, px, py, qx, qy)
        px = qx
        py = qy
      }
    })
  })
  return best
}

// Insert an anchor at parameter t of segment si (after point si). Straight
// segments get a corner anchor; curves split via de Casteljau, so the
// outline is unchanged.
export function insertAnchor(paths, pi, si, t) {
  return paths.map((sp, a) => {
    if (a !== pi) return sp
    const s = penSegs(sp)[si]
    if (!s) return sp
    const pts = sp.pts.map((p) => ({ ...p }))
    const n = pts.length
    const ia = si, ib = (si + 1) % n
    let np
    if (!s.curved) {
      np = {
        x: r4(s.a.x + (s.b.x - s.a.x) * t), y: r4(s.a.y + (s.b.y - s.a.y) * t),
        hix: 0, hiy: 0, hox: 0, hoy: 0,
      }
    } else {
      const lerp = (p, q) => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t })
      const q0 = lerp(s.a, s.c1), q1 = lerp(s.c1, s.c2), q2 = lerp(s.c2, s.b)
      const r0 = lerp(q0, q1), r1 = lerp(q1, q2)
      const m = lerp(r0, r1)
      pts[ia] = { ...pts[ia], hox: r4(q0.x - s.a.x), hoy: r4(q0.y - s.a.y) }
      pts[ib] = { ...pts[ib], hix: r4(q2.x - s.b.x), hiy: r4(q2.y - s.b.y) }
      np = {
        x: r4(m.x), y: r4(m.y),
        hix: r4(r0.x - m.x), hiy: r4(r0.y - m.y),
        hox: r4(r1.x - m.x), hoy: r4(r1.y - m.y),
      }
    }
    pts.splice(si + 1, 0, np)
    return { ...sp, pts }
  })
}

// Remove one anchor; subpaths that degenerate below 2 points are dropped.
// May return an empty array (caller deletes the object).
export function removeAnchor(paths, pi, i) {
  const out = []
  paths.forEach((sp, a) => {
    if (a !== pi) {
      out.push(sp)
      return
    }
    const pts = sp.pts.filter((_, b) => b !== i)
    if (pts.length >= 2) out.push({ ...sp, pts })
  })
  return out
}

// ---------------------------------------------------------------------------
// Parametric outlines
// ---------------------------------------------------------------------------

function polyPoints(sides, w, h) {
  const cx = w / 2, cy = h / 2
  const pts = []
  for (let i = 0; i < sides; i++) {
    const a = -Math.PI / 2 + (Math.PI * 2 * i) / sides
    pts.push([cx + (w / 2) * Math.cos(a), cy + (h / 2) * Math.sin(a)])
  }
  return pts
}

function starPoints(points, inner, w, h) {
  const cx = w / 2, cy = h / 2
  const pts = []
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / points
    const k = i % 2 === 0 ? 1 : inner
    pts.push([cx + (w / 2) * k * Math.cos(a), cy + (h / 2) * k * Math.sin(a)])
  }
  return pts
}

const clampRadius = (r, w, h) => Math.max(0, Math.min(r || 0, w / 2, h / 2))

function rectPath(w, h, radius) {
  const r = clampRadius(radius, w, h)
  if (!r) return `M 0 0 H ${r4(w)} V ${r4(h)} H 0 Z`
  return (
    `M ${r4(r)} 0 H ${r4(w - r)} A ${r4(r)} ${r4(r)} 0 0 1 ${r4(w)} ${r4(r)} ` +
    `V ${r4(h - r)} A ${r4(r)} ${r4(r)} 0 0 1 ${r4(w - r)} ${r4(h)} ` +
    `H ${r4(r)} A ${r4(r)} ${r4(r)} 0 0 1 0 ${r4(h - r)} ` +
    `V ${r4(r)} A ${r4(r)} ${r4(r)} 0 0 1 ${r4(r)} 0 Z`
  )
}

function rectRing(w, h, radius) {
  const r = clampRadius(radius, w, h)
  if (!r) return [[0, 0], [w, 0], [w, h], [0, h]]
  const ring = []
  const corner = (cx, cy, a0) => {
    const STEPS = 8
    for (let i = 0; i <= STEPS; i++) {
      const a = a0 + (Math.PI / 2) * (i / STEPS)
      ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  corner(w - r, r, -Math.PI / 2)
  corner(w - r, h - r, 0)
  corner(r, h - r, Math.PI / 2)
  corner(r, r, Math.PI)
  return ring
}

function ellipsePath(w, h) {
  const rx = w / 2, ry = h / 2
  return (
    `M 0 ${r4(ry)} A ${r4(rx)} ${r4(ry)} 0 1 0 ${r4(w)} ${r4(ry)} ` +
    `A ${r4(rx)} ${r4(ry)} 0 1 0 0 ${r4(ry)} Z`
  )
}

function ellipseRing(w, h) {
  const cx = w / 2, cy = h / 2
  const ring = []
  const N = 96
  for (let i = 0; i < N; i++) {
    const a = (Math.PI * 2 * i) / N
    ring.push([cx + cx * Math.cos(a), cy + cy * Math.sin(a)])
  }
  return ring
}

// Line = filled bar between two points, thickness t (cells).
function lineRing(pts, t) {
  const [a, b] = pts
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) || 1
  const nx = (-dy / len) * (t / 2)
  const ny = (dx / len) * (t / 2)
  return [
    [a[0] + nx, a[1] + ny],
    [b[0] + nx, b[1] + ny],
    [b[0] - nx, b[1] - ny],
    [a[0] - nx, a[1] - ny],
  ]
}

// ---------------------------------------------------------------------------
// MultiPolygon helpers ([polygon: [ring: [[x,y],…]]] — polygon-clipping format)
// ---------------------------------------------------------------------------

const ringPath = (ring) =>
  `M ${ring.map(([x, y]) => `${r4(x)} ${r4(y)}`).join(' L ')} Z`

export function polysToPath(mp) {
  return mp.map((poly) => poly.map(ringPath).join(' ')).join(' ')
}

export function polysBBox(mp) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const poly of mp) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        x1 = Math.min(x1, x); y1 = Math.min(y1, y)
        x2 = Math.max(x2, x); y2 = Math.max(y2, y)
      }
    }
  }
  if (x1 === Infinity) return { x: 0, y: 0, w: 0.01, h: 0.01 }
  return { x: x1, y: y1, w: Math.max(x2 - x1, 0.01), h: Math.max(y2 - y1, 0.01) }
}

const ringsBBox = (ring) => polysBBox([[ring]])

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Rounded (or plain) outline paths for poly/star rings.
const roundedRing = (ring, round) =>
  round ? roundPen(ringToPaths(ring), round) : ringToPaths(ring)

// Convert any shape into an editable pen shape: real anchors with bezier
// handles, corner rounding baked into extra anchor pairs (roundPen). All
// coords stay in cell units so anchors and handles live on the canvas grid.
export function toPen(shape, w, h) {
  const closedRing = (ring) => {
    const pts = ring.map(([x, y]) => [r4(x), r4(y)])
    const f = pts[0], l = pts[pts.length - 1]
    if (pts.length > 1 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-9) pts.pop()
    return ringToPaths(pts)
  }
  switch (shape.type) {
    case 'rect': {
      const r = clampRadius(shape.radius, w, h)
      const base = closedRing([[0, 0], [w, 0], [w, h], [0, h]])
      return { type: 'pen', paths: roundPen(base, r), round: 0 }
    }
    case 'ellipse': {
      // Kappa handles snap to the quarter-cell grid (max deviation from the
      // true circle ≈ 0.04 cells — invisible, and everything stays on grid).
      const rx = r4(w / 2), ry = r4(h / 2)
      const snapK = (v) => Math.max(0.25, Math.round(v * 4) / 4)
      const kx = snapK((w / 2) * K_ARC), ky = snapK((h / 2) * K_ARC)
      return {
        type: 'pen',
        round: 0,
        paths: [{
          closed: true,
          pts: [
            { x: rx, y: 0, hix: -kx, hiy: 0, hox: kx, hoy: 0 },
            { x: r4(w), y: ry, hix: 0, hiy: -ky, hox: 0, hoy: ky },
            { x: rx, y: r4(h), hix: kx, hiy: 0, hox: -kx, hoy: 0 },
            { x: 0, y: ry, hix: 0, hiy: ky, hox: 0, hoy: -ky },
          ],
        }],
      }
    }
    case 'poly':
      return { type: 'pen', paths: roundPen(closedRing(polyPoints(shape.sides, w, h)), shape.round || 0), round: 0 }
    case 'star':
      return { type: 'pen', paths: roundPen(closedRing(starPoints(shape.points, shape.inner, w, h)), shape.round || 0), round: 0 }
    case 'line':
      return { type: 'pen', paths: closedRing(lineRing(shape.pts, shape.t)), round: 0 }
    case 'pen':
      return {
        ...shape,
        pts: undefined,
        closed: undefined,
        paths: roundPen(penPaths(shape), shape.round || 0),
        round: 0,
      }
    case 'raw':
      return {
        type: 'pen',
        fillRule: 'evenodd',
        round: 0,
        paths: shape.polys.flatMap((poly) => poly.map((ring) => closedRing(ring)[0])),
      }
    default:
      return null
  }
}

// → { d, x, y, w, h, fillRule? } — bbox in cell units.
export function shapeSource(shape, w, h) {
  switch (shape.type) {
    case 'rect':
      return { d: rectPath(w, h, shape.radius), x: 0, y: 0, w, h }
    case 'ellipse':
      return { d: ellipsePath(w, h), x: 0, y: 0, w, h }
    case 'poly':
      return { d: penD(roundedRing(polyPoints(shape.sides, w, h), shape.round)), x: 0, y: 0, w, h }
    case 'star':
      return { d: penD(roundedRing(starPoints(shape.points, shape.inner, w, h), shape.round)), x: 0, y: 0, w, h }
    case 'line': {
      const ring = lineRing(shape.pts, shape.t)
      return { d: ringPath(ring), ...ringsBBox(ring) }
    }
    case 'pen': {
      const paths = roundPen(penPaths(shape), shape.round || 0)
      return { d: penD(paths), ...penBBox(paths), fillRule: shape.fillRule || 'evenodd' }
    }
    case 'raw':
      return { d: polysToPath(shape.polys), ...polysBBox(shape.polys), fillRule: 'evenodd' }
    default:
      return null
  }
}

// Flattened outline(s) for boolean ops, same coordinate space as shapeSource.
// Multi-subpath pens combine rings with XOR — the polygon equivalent of
// evenodd fill, so holes stay holes.
export function shapePolys(shape, w, h) {
  switch (shape.type) {
    case 'rect': return [[rectRing(w, h, shape.radius)]]
    case 'ellipse': return [[ellipseRing(w, h)]]
    case 'poly':
      return [[penRing(roundedRing(polyPoints(shape.sides, w, h), shape.round)[0])]]
    case 'star':
      return [[penRing(roundedRing(starPoints(shape.points, shape.inner, w, h), shape.round)[0])]]
    case 'line': return [[lineRing(shape.pts, shape.t)]]
    case 'pen': {
      const rings = roundPen(penPaths(shape), shape.round || 0)
        .map(penRing).filter((r) => r.length >= 3)
      if (!rings.length) return []
      if (rings.length === 1) return [[rings[0]]]
      try {
        return polygonClipping.xor(...rings.map((r) => [[r]]))
      } catch {
        return rings.map((r) => [r])
      }
    }
    case 'raw': return shape.polys
    default: return []
  }
}

// Resize a free shape's geometry so its bbox scales by (sx, sy) around the
// bbox origin (ox, oy). Bezier geometry scales exactly (linear in controls).
export function scaleShape(shape, ox, oy, sx, sy) {
  if (shape.type === 'pen') {
    return {
      ...shape,
      pts: undefined,
      closed: undefined,
      paths: penPaths(shape).map((sp) => ({
        closed: sp.closed,
        pts: sp.pts.map((p) => ({
          x: r4(ox + (p.x - ox) * sx),
          y: r4(oy + (p.y - oy) * sy),
          hox: r4(p.hox * sx), hoy: r4(p.hoy * sy),
          hix: r4(p.hix * sx), hiy: r4(p.hiy * sy),
        })),
      })),
    }
  }
  if (shape.type === 'line') {
    return {
      ...shape,
      pts: shape.pts.map(([x, y]) => [r4(ox + (x - ox) * sx), r4(oy + (y - oy) * sy)]),
    }
  }
  if (shape.type === 'raw') {
    return {
      ...shape,
      polys: shape.polys.map((poly) =>
        poly.map((ring) => ring.map(([x, y]) => [r4(ox + (x - ox) * sx), r4(oy + (y - oy) * sy)])),
      ),
    }
  }
  return shape
}

export const FREE_SHAPE = (type) => type === 'pen' || type === 'line' || type === 'raw'
