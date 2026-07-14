import { useEffect, useMemo, useRef, useState } from 'react'
import polygonClipping from 'polygon-clipping'
import { textToRects } from './font.js'
import { EFFECTS, mulberry32, defaultParamsFor } from './effects.jsx'
import {
  SHAPE_DEFAULTS, SHAPE_NAMES, FREE_SHAPE,
  shapeSource, shapePolys, scaleShape, penD, penBBox, penPaths, dToPen, polysBBox, toPen,
  nearestOnPen, insertAnchor, removeAnchor,
} from './shapes.js'
import {
  IcSelect, IcHand, IcRect, IcEllipse, IcPoly, IcStar, IcLine, IcPen,
  IcUndo, IcRedo, IcUnion, IcSubtract, IcIntersect, IcExclude,
  IcAlignL, IcAlignCX, IcAlignR, IcAlignT, IcAlignCY, IcAlignB,
  IcFlipH, IcFlipV, IcDistH, IcDistV, IcLock, IcUnlock,
} from './icons.jsx'

// Canvas background is always dark or white — never custom, never transparent.
const BG_DARK = '#1E1E1E'
const BG_WHITE = '#FFFFFF'

const MIN_ZOOM = 0.05
const MAX_ZOOM = 8
const STORE_KEY = 'logolab-board-v1'
const GUIDE = '#F24822' // smart-guide red

const r4 = (v) => Math.round(v * 10000) / 10000

const ROTATE_CURSOR = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18">' +
  '<path d="M9 3.2a5.8 5.8 0 1 1-5.5 4" fill="none" stroke="#000" stroke-width="3.6"/>' +
  '<path d="M9 3.2a5.8 5.8 0 1 1-5.5 4" fill="none" stroke="#fff" stroke-width="1.6"/>' +
  '<path d="M9.4 0.4l4 2.8-4 2.8z" fill="#000"/><path d="M10.2 1.9l1.9 1.3-1.9 1.3z" fill="#fff"/>' +
  '</svg>',
)}") 9 9, pointer`

function rotatePt(x, y, cx, cy, deg) {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = x - cx
  const dy = y - cy
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c }
}

// Axis-aligned bbox of a rectangle rotated by `deg` about its center.
// Used for marquee hit-testing rotated objects (the stored box is pre-rotation).
function rotatedAABB(box, deg) {
  if (!deg) return box
  const a = (deg * Math.PI) / 180
  const c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a))
  const nw = box.w * c + box.h * s
  const nh = box.w * s + box.h * c
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2
  return { x: cx - nw / 2, y: cy - nh / 2, w: nw, h: nh }
}

const normDeg = (v) => {
  const n = ((v + 180) % 360 + 360) % 360 - 180
  return n === -180 ? 180 : r4(n)
}

// ---------------------------------------------------------------------------
// SVG parsing + grid detection (per pasted logo)
// ---------------------------------------------------------------------------

// Measure a raw path `d` via a throwaway off-screen SVG.
function measurePath(d) {
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    svg.appendChild(path)
    svg.style.position = 'absolute'
    svg.style.visibility = 'hidden'
    document.body.appendChild(svg)
    const b = path.getBBox()
    document.body.removeChild(svg)
    if (!b.width || !b.height) return null
    return { x: b.x, y: b.y, w: b.width, h: b.height }
  } catch {
    return null
  }
}

// Extract absolute vertex coords from a path `d`. Straight-line commands only
// (M/L/H/V/Z) — curves mean the symbol has no detectable grid, returns null.
function pathCoords(d) {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d*\.\d+|\d+\.?\d*)(?:[eE][-+]?\d+)?/g)
  if (!tokens) return null
  const xs = []
  const ys = []
  let cmd = ''
  let x = 0, y = 0, sx = 0, sy = 0
  let i = 0
  const isCmd = (t) => /^[a-zA-Z]$/.test(t)
  const need = (n) => i + n <= tokens.length && !tokens.slice(i, i + n).some(isCmd)
  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++]
    switch (cmd) {
      case 'M': case 'm': case 'L': case 'l': {
        if (!need(2)) return null
        const nx = Number(tokens[i++])
        const ny = Number(tokens[i++])
        const rel = cmd === 'm' || cmd === 'l'
        x = rel ? x + nx : nx
        y = rel ? y + ny : ny
        if (cmd === 'M' || cmd === 'm') {
          sx = x
          sy = y
          cmd = cmd === 'm' ? 'l' : 'L'
        }
        xs.push(x)
        ys.push(y)
        break
      }
      case 'H': case 'h': {
        if (!need(1)) return null
        const n = Number(tokens[i++])
        x = cmd === 'h' ? x + n : n
        xs.push(x)
        break
      }
      case 'V': case 'v': {
        if (!need(1)) return null
        const n = Number(tokens[i++])
        y = cmd === 'v' ? y + n : n
        ys.push(y)
        break
      }
      case 'Z': case 'z':
        x = sx
        y = sy
        if (i < tokens.length && !isCmd(tokens[i])) return null
        break
      default:
        return null
    }
  }
  return { xs, ys }
}

// Gather vertex coords from straight-edge geometry. Any transform, curve, or
// unsupported element disables grid detection (returns null).
function collectCoords(container) {
  const xs = []
  const ys = []
  const containers = ['g', 'defs', 'title', 'desc', 'metadata', 'clippath', 'mask',
    'lineargradient', 'radialgradient', 'stop', 'filter', 'pattern', 'symbol', 'style']
  for (const el of container.querySelectorAll('*')) {
    if (el.getAttribute('transform')) return null
    if (el.closest('defs')) continue
    const tag = el.tagName.toLowerCase()
    if (containers.includes(tag)) continue
    if (tag === 'rect') {
      const rx = Number(el.getAttribute('x') || 0)
      const ry = Number(el.getAttribute('y') || 0)
      const rw = Number(el.getAttribute('width') || 0)
      const rh = Number(el.getAttribute('height') || 0)
      xs.push(rx, rx + rw)
      ys.push(ry, ry + rh)
    } else if (tag === 'path') {
      const c = pathCoords(el.getAttribute('d') || '')
      if (!c) return null
      xs.push(...c.xs)
      ys.push(...c.ys)
    } else if (tag === 'polygon' || tag === 'polyline') {
      const nums = (el.getAttribute('points') || '').match(/-?\d*\.?\d+/g)
      if (!nums) continue
      for (let j = 0; j + 1 < nums.length; j += 2) {
        xs.push(Number(nums[j]))
        ys.push(Number(nums[j + 1]))
      }
    } else if (tag === 'line') {
      xs.push(Number(el.getAttribute('x1') || 0), Number(el.getAttribute('x2') || 0))
      ys.push(Number(el.getAttribute('y1') || 0), Number(el.getAttribute('y2') || 0))
    } else {
      return null
    }
  }
  return xs.length ? { xs, ys } : null
}

// Detect the symbol's own grid from vertex coords relative to the bbox origin.
// Candidate units come from gaps between neighboring distinct coordinates (plus
// pairwise tolerant GCDs of those gaps); the largest candidate that every
// coordinate fits as an integer multiple wins. A chained float GCD is NOT used —
// export rounding noise (e.g. 143.603 vs 143.604) poisons it.
// Returns { unit, cols, rows } or null.
function detectGrid(coords, bbox) {
  if (!coords || !bbox.w || !bbox.h) return null
  const maxDim = Math.max(bbox.w, bbox.h)
  const tol = maxDim / 1000
  const rel = []
  for (const v of coords.xs) {
    if (!Number.isFinite(v)) return null
    rel.push(v - bbox.x)
  }
  for (const v of coords.ys) {
    if (!Number.isFinite(v)) return null
    rel.push(v - bbox.y)
  }
  const uniq = [...rel].sort((a, b) => a - b).filter((v, i, arr) => i === 0 || v - arr[i - 1] > tol)
  const cand = []
  const addCand = (v) => {
    if (v < maxDim / 256 || v > maxDim) return
    if (!cand.some((c) => Math.abs(c - v) <= tol)) cand.push(v)
  }
  for (let i = 1; i < uniq.length; i++) addCand(uniq[i] - uniq[i - 1])
  if (uniq[0] > tol) addCand(uniq[0])
  const n0 = Math.min(cand.length, 24)
  for (let i = 0; i < n0; i++) {
    for (let j = i + 1; j < n0; j++) {
      let a = Math.max(cand[i], cand[j])
      let b = Math.min(cand[i], cand[j])
      while (b > tol) {
        const t = a % b
        a = b
        b = t
      }
      addCand(a)
    }
  }
  cand.sort((a, b) => b - a)
  for (let g of cand) {
    // Least-squares refine: each coord ≈ n·g for integer n, so export rounding
    // noise averages out instead of accumulating.
    let num = 0
    let den = 0
    for (const v of rel) {
      const n = Math.round(v / g)
      num += n * v
      den += n * n
    }
    if (!den) continue
    g = num / den
    const cols = Math.round(bbox.w / g)
    const rows = Math.round(bbox.h / g)
    if (cols < 1 || rows < 1 || cols > 256 || rows > 256 || (cols < 2 && rows < 2)) continue
    if (Math.abs(bbox.w - cols * g) > tol || Math.abs(bbox.h - rows * g) > tol) continue
    let ok = true
    for (const v of rel) {
      if (Math.abs(v - Math.round(v / g) * g) > tol) {
        ok = false
        break
      }
    }
    if (ok) return { unit: g, cols, rows }
  }
  return null
}

// Parse full pasted <svg> markup: sanitize, strip opacity (vectors must stay
// solid — original colors are always kept), measure the real content bbox.
function parseSvgMarkup(code) {
  try {
    const doc = new DOMParser().parseFromString(code, 'image/svg+xml')
    if (doc.querySelector('parsererror')) return null
    const root = doc.documentElement
    if (root.tagName.toLowerCase() !== 'svg') return null
    root.querySelectorAll('script, foreignObject, filter').forEach((n) => n.remove())
    for (const el of root.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
        else if (/href$/i.test(attr.name) && /^\s*(javascript|https?):/i.test(attr.value)) {
          el.removeAttribute(attr.name)
        }
      }
    }
    for (const el of root.querySelectorAll('*')) {
      for (const a of ['opacity', 'fill-opacity', 'stroke-opacity', 'filter']) el.removeAttribute(a)
      // Opacity smuggled in via style="" must die too — solid vectors only.
      const st = el.getAttribute('style')
      if (st) {
        const cleaned = st.replace(/(?:^|;)\s*(?:fill-|stroke-)?opacity\s*:[^;]*/gi, '')
        if (cleaned.replace(/[\s;]/g, '')) el.setAttribute('style', cleaned)
        else el.removeAttribute('style')
      }
    }
    const markup = root.innerHTML
    if (!markup.trim()) return null
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    svg.appendChild(g)
    g.innerHTML = markup
    svg.style.position = 'absolute'
    svg.style.visibility = 'hidden'
    document.body.appendChild(svg)
    let b
    let grid
    try {
      b = g.getBBox()
      grid = detectGrid(collectCoords(g), { x: b.x, y: b.y, w: b.width, h: b.height })
    } finally {
      document.body.removeChild(svg)
    }
    if (!b.width || !b.height) return null
    return { items: [{ kind: 'svg', markup }], x: b.x, y: b.y, w: b.width, h: b.height, grid }
  } catch {
    return null
  }
}

function buildSource(svgCode) {
  const code = (svgCode || '').trim()
  if (!code) return null
  if (code.startsWith('<')) return parseSvgMarkup(code)
  // Fallback: raw path `d` data.
  const b = measurePath(code)
  if (!b) return null
  return { items: [{ kind: 'path', d: code }], ...b, grid: detectGrid(pathCoords(code), b) }
}

// Drawn shapes become regular sources: 1 shape unit = 1 canvas grid cell, so
// placement snapping and every effect work on them with zero special cases.
// `outlined` swaps fill for stroke (Shift+X) — stroke width is in cells, which
// equals source units for shapes (grid.unit = 1), so it stays crisp at any zoom.
function buildShapeSrc(o) {
  const s = shapeSource(o.shape, o.w, o.h)
  if (!s || !s.d) return null
  const item = { kind: 'path', d: s.d, fillRule: s.fillRule }
  if (o.outlined) {
    item.fill = 'none'
    item.stroke = o.fill || '#FFFFFF'
    item.strokeWidth = o.strokeWidth || 1
  } else {
    item.fill = o.fill
  }
  return {
    items: [item],
    x: s.x, y: s.y, w: s.w, h: s.h,
    grid: { unit: 1, cols: Math.max(1, Math.round(s.w)), rows: Math.max(1, Math.round(s.h)) },
  }
}

const srcKey = (o) => (o.shape
  ? `s:${JSON.stringify([o.shape, o.w, o.h, o.fill, o.outlined, o.strokeWidth])}`
  : `c:${o.code}`)

function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

function renderItems(items) {
  return items.map((it, i) => {
    if (it.kind === 'rect') return <rect key={i} x={it.x} y={it.y} width={it.w} height={it.h} />
    if (it.kind === 'path') {
      return (
        <path key={i} d={it.d} fill={it.fill} fillRule={it.fillRule}
          stroke={it.stroke} strokeWidth={it.strokeWidth} />
      )
    }
    return <g key={i} dangerouslySetInnerHTML={{ __html: it.markup }} />
  })
}

function itemsToMarkup(items) {
  return items
    .map((it) => {
      if (it.kind === 'rect') return `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}"/>`
      if (it.kind === 'path') {
        let s = `<path d="${it.d}"`
        if (it.fill) s += ` fill="${it.fill}"`
        if (it.fillRule) s += ` fill-rule="${it.fillRule}"`
        if (it.stroke) s += ` stroke="${it.stroke}" stroke-width="${it.strokeWidth}"`
        return `${s}/>`
      }
      return it.markup
    })
    .join('')
}

// Rasterize a source at box size via an <img> (handles arbitrary pasted SVG
// markup, which Path2D cannot). Resolves to {data, bw, bh} RGBA pixel data
// that raster effects sample for coverage and local color. Fill-less elements
// inherit `fg` (matches on-canvas render) — otherwise they'd sample as black.
function rasterize(src, boxW, boxH, fg) {
  return new Promise((resolve) => {
    const bw = Math.max(1, Math.round(boxW))
    const bh = Math.max(1, Math.round(boxH))
    const svgStr =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${src.x} ${src.y} ${src.w} ${src.h}" ` +
      `width="${bw}" height="${bh}"><g fill="${fg}">` +
      itemsToMarkup(src.items) +
      '</g></svg>'
    const url = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml' }))
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = bw
      canvas.height = bh
      const c = canvas.getContext('2d')
      c.drawImage(img, 0, 0, bw, bh)
      resolve({ data: c.getImageData(0, 0, bw, bh).data, bw, bh })
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

// ---------------------------------------------------------------------------
// Convert pasted SVG geometry to editable pen paths
// ---------------------------------------------------------------------------

// Per-tag geometry → path `d` (in the element's own coordinates).
function elToD(el) {
  const n = (a, def = 0) => Number(el.getAttribute(a) || def)
  switch (el.tagName.toLowerCase()) {
    case 'path':
      return el.getAttribute('d') || null
    case 'rect': {
      const x = n('x'), y = n('y'), w = n('width'), h = n('height')
      if (!w || !h) return null
      let rx = el.hasAttribute('rx') ? n('rx') : (el.hasAttribute('ry') ? n('ry') : 0)
      let ry = el.hasAttribute('ry') ? n('ry') : rx
      rx = Math.min(Math.abs(rx), w / 2)
      ry = Math.min(Math.abs(ry), h / 2)
      if (!rx || !ry) return `M ${x} ${y} H ${x + w} V ${y + h} H ${x} Z`
      return (
        `M ${x + rx} ${y} H ${x + w - rx} A ${rx} ${ry} 0 0 1 ${x + w} ${y + ry} ` +
        `V ${y + h - ry} A ${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h} ` +
        `H ${x + rx} A ${rx} ${ry} 0 0 1 ${x} ${y + h - ry} ` +
        `V ${y + ry} A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
      )
    }
    case 'circle': {
      const cx = n('cx'), cy = n('cy'), r = n('r')
      if (!r) return null
      return `M ${cx - r} ${cy} A ${r} ${r} 0 1 0 ${cx + r} ${cy} A ${r} ${r} 0 1 0 ${cx - r} ${cy} Z`
    }
    case 'ellipse': {
      const cx = n('cx'), cy = n('cy'), rx = n('rx'), ry = n('ry')
      if (!rx || !ry) return null
      return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`
    }
    case 'polygon': case 'polyline': {
      const nums = (el.getAttribute('points') || '').match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/g)
      if (!nums || nums.length < 4) return null
      let d = `M ${nums[0]} ${nums[1]}`
      for (let i = 2; i + 1 < nums.length; i += 2) d += ` L ${nums[i]} ${nums[i + 1]}`
      return el.tagName.toLowerCase() === 'polygon' ? `${d} Z` : d
    }
    default:
      return null
  }
}

const matIdentity = (m) =>
  Math.abs(m.a - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9 &&
  Math.abs(m.d - 1) < 1e-9 && Math.abs(m.e) < 1e-9 && Math.abs(m.f) < 1e-9

function transformPaths(paths, m) {
  return paths.map((sp) => ({
    closed: sp.closed,
    pts: sp.pts.map((p) => ({
      x: m.a * p.x + m.c * p.y + m.e,
      y: m.b * p.x + m.d * p.y + m.f,
      hox: m.a * p.hox + m.c * p.hoy,
      hoy: m.b * p.hox + m.d * p.hoy,
      hix: m.a * p.hix + m.c * p.hiy,
      hiy: m.b * p.hix + m.d * p.hiy,
    })),
  }))
}

// Walk the sanitized pasted markup and extract per-element pen paths with
// baked transforms and resolved solid fills. Coordinates stay in source units.
function extractEditablePaths(markup) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  svg.appendChild(g)
  g.innerHTML = markup
  svg.style.position = 'absolute'
  svg.style.visibility = 'hidden'
  document.body.appendChild(svg)
  const out = []
  try {
    const inv = svg.getScreenCTM()?.inverse()
    for (const el of svg.querySelectorAll('path,rect,circle,ellipse,polygon,polyline')) {
      if (el.closest('defs,clipPath,mask,symbol,pattern')) continue
      const cs = getComputedStyle(el)
      if (cs.display === 'none' || cs.visibility === 'hidden') continue
      let fill = cs.fill
      if (fill === 'none') continue // stroke-only geometry can't become a solid shape
      if (!fill || fill.startsWith('url')) fill = null // gradient/pattern → caller falls back
      const d = elToD(el)
      if (!d) continue
      let paths = dToPen(d)
      if (!paths) continue
      if (inv) {
        const m = inv.multiply(el.getScreenCTM())
        if (!matIdentity(m)) paths = transformPaths(paths, m)
      }
      out.push({ paths, fill, fillRule: cs.fillRule === 'evenodd' ? 'evenodd' : 'nonzero' })
    }
  } catch {
    /* fall through with what we have */
  } finally {
    document.body.removeChild(svg)
  }
  return out
}

// ---------------------------------------------------------------------------
// Smart guides
// ---------------------------------------------------------------------------

const edgesOf = (b) => ({
  xs: [b.x, b.x + b.w / 2, b.x + b.w],
  ys: [b.y, b.y + b.h / 2, b.y + b.h],
})

// Best alignment correction (px) for a moving bbox against other boxes.
function smartDelta(mb, others, thr) {
  const me = edgesOf(mb)
  let dx = null, dxd = thr
  let dy = null, dyd = thr
  for (const b of others) {
    const oe = edgesOf(b)
    for (const mv of me.xs) {
      for (const ov of oe.xs) {
        const d = ov - mv
        if (Math.abs(d) < dxd) { dxd = Math.abs(d); dx = d }
      }
    }
    for (const mv of me.ys) {
      for (const ov of oe.ys) {
        const d = ov - mv
        if (Math.abs(d) < dyd) { dyd = Math.abs(d); dy = d }
      }
    }
  }
  return { dx, dy }
}

// Guide lines to draw at the snapped position (edges/centers that align).
function guideLines(mb, others, eps) {
  const me = edgesOf(mb)
  const out = []
  const seen = new Set()
  for (const b of others) {
    const oe = edgesOf(b)
    for (const gv of oe.xs) {
      if (me.xs.some((mv) => Math.abs(mv - gv) < eps)) {
        const k = `v${Math.round(gv * 4)}`
        if (!seen.has(k)) {
          seen.add(k)
          out.push({ axis: 'v', pos: gv, a: Math.min(mb.y, b.y), b: Math.max(mb.y + mb.h, b.y + b.h) })
        }
      }
    }
    for (const gv of oe.ys) {
      if (me.ys.some((mv) => Math.abs(mv - gv) < eps)) {
        const k = `h${Math.round(gv * 4)}`
        if (!seen.has(k)) {
          seen.add(k)
          out.push({ axis: 'h', pos: gv, a: Math.min(mb.x, b.x), b: Math.max(mb.x + mb.w, b.x + b.w) })
        }
      }
    }
  }
  return out
}

// Distance labels between a moving bbox and neighbors (cells), when ranges
// overlap on the perpendicular axis and a positive gap exists.
function gapLabels(mb, others, cell) {
  const out = []
  const maxGap = cell * 12
  for (const b of others) {
    const yOv = Math.min(mb.y + mb.h, b.y + b.h) - Math.max(mb.y, b.y)
    if (yOv > 0) {
      let gap = 0, x1 = 0, x2 = 0
      if (mb.x + mb.w <= b.x + 0.5) {
        gap = b.x - (mb.x + mb.w)
        x1 = mb.x + mb.w
        x2 = b.x
      } else if (b.x + b.w <= mb.x + 0.5) {
        gap = mb.x - (b.x + b.w)
        x1 = b.x + b.w
        x2 = mb.x
      }
      if (gap > 0.5 && gap < maxGap) {
        const midY = (Math.max(mb.y, b.y) + Math.min(mb.y + mb.h, b.y + b.h)) / 2
        out.push({ kind: 'h', x1, x2, y: midY, text: String(Math.round((gap / cell) * 100) / 100) })
      }
    }
    const xOv = Math.min(mb.x + mb.w, b.x + b.w) - Math.max(mb.x, b.x)
    if (xOv > 0) {
      let gap = 0, y1 = 0, y2 = 0
      if (mb.y + mb.h <= b.y + 0.5) {
        gap = b.y - (mb.y + mb.h)
        y1 = mb.y + mb.h
        y2 = b.y
      } else if (b.y + b.h <= mb.y + 0.5) {
        gap = mb.y - (b.y + b.h)
        y1 = b.y + b.h
        y2 = mb.y
      }
      if (gap > 0.5 && gap < maxGap) {
        const midX = (Math.max(mb.x, b.x) + Math.min(mb.x + mb.w, b.x + b.w)) / 2
        out.push({ kind: 'v', y1, y2, x: midX, text: String(Math.round((gap / cell) * 100) / 100) })
      }
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Small UI bits
// ---------------------------------------------------------------------------

function PixelWord({ text, height = 14, color = 'currentColor' }) {
  const { rects, w, h } = useMemo(() => textToRects(text), [text])
  const s = height / h
  return (
    <svg width={w * s} height={height} viewBox={`0 0 ${w} ${h}`} aria-label={text} role="img">
      <g fill={color}>
        {rects.map((r, i) => (
          <rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} />
        ))}
      </g>
    </svg>
  )
}

function Slider({ def, value, onChange }) {
  return (
    <label className="ctl">
      <span className="ctl-head">
        <span>{def.label}</span>
        <span className="ctl-val">{value}</span>
      </span>
      <input
        type="range"
        min={def.min}
        max={def.max}
        step={def.step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

function NumField({ label, value, onCommit, disabled = false, step = 0.5 }) {
  const [draft, setDraft] = useState(null)
  const shown = draft !== null ? draft : String(Math.round((value ?? 0) * 100) / 100)
  return (
    <label className="num">
      <span>{label}</span>
      <input
        type="number"
        step={step}
        disabled={disabled}
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const v = parseFloat(draft)
            if (Number.isFinite(v)) onCommit(v)
            setDraft(null)
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.target.blur()
          if (e.key === 'Escape') {
            setDraft(null)
            e.target.blur()
          }
        }} />
    </label>
  )
}

function FxParams({ def, params, onParam }) {
  return def.params.map((pd) => {
    if (pd.type === 'range') {
      return <Slider key={pd.key} def={pd} value={params[pd.key]} onChange={(v) => onParam(pd.key, v)} />
    }
    if (pd.type === 'toggle') {
      return (
        <label key={pd.key} className="ctl row">
          <input type="checkbox" checked={params[pd.key]}
            onChange={(e) => onParam(pd.key, e.target.checked)} />
          <span>{pd.label}</span>
        </label>
      )
    }
    return (
      <label key={pd.key} className="ctl">
        <span className="ctl-head"><span>{pd.label}</span></span>
        <select value={params[pd.key]} onChange={(e) => onParam(pd.key, e.target.value)}>
          {pd.options.map((o) => (
            <option key={o.v} value={o.v}>{o.label}</option>
          ))}
        </select>
      </label>
    )
  })
}

let idCounter = 1
const newId = (prefix) => `${prefix}${Date.now().toString(36)}${idCounter++}`
const newSeed = () => Math.floor(Math.random() * 9999) + 1

function loadSaved() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY))
    if (s && s.v === 1 && Array.isArray(s.objects)) return s
  } catch { /* corrupted store — start fresh */ }
  return null
}
const SAVED = loadSaved()

const DRAW_TOOLS = ['rect', 'ellipse', 'poly', 'star', 'line']

const TOOLBAR = [
  { id: 'select', title: 'Move (V) — move, resize, rotate (no point edit)', Icon: IcSelect },
  { id: 'hand', title: 'Hand (H, hold Space)', Icon: IcHand },
  { id: 'rect', title: 'Rectangle (R)', Icon: IcRect },
  { id: 'ellipse', title: 'Ellipse (O)', Icon: IcEllipse },
  { id: 'poly', title: 'Polygon (N)', Icon: IcPoly },
  { id: 'star', title: 'Star (S)', Icon: IcStar },
  { id: 'line', title: 'Line (L)', Icon: IcLine },
  { id: 'pen', title: 'Pen (P) — draw paths or edit points (no resize)', Icon: IcPen },
]

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [objects, setObjects] = useState(() => SAVED?.objects ?? [])
  const [selIds, setSelIds] = useState([])
  const [tool, setTool] = useState('select')
  const [cam, setCam] = useState(() => SAVED?.cam ?? { x: -600, y: -400, z: 1 })
  const [vp, setVp] = useState({ w: 1200, h: 800 })
  const [bgWhite, setBgWhite] = useState(() => SAVED?.bgWhite ?? false)
  const [showGrid, setShowGrid] = useState(true)
  const [gridCell, setGridCell] = useState(() => SAVED?.gridCell ?? 32)
  const [toast, setToast] = useState(null)
  const [spaceHeld, setSpaceHeld] = useState(false)
  const [rasters, setRasters] = useState({})
  const [draft, setDraft] = useState(null)      // in-progress shape drag
  const [pen, setPen] = useState(null)          // in-progress pen path
  const [marquee, setMarquee] = useState(null)  // rubber-band rect (world px)
  const [guides, setGuides] = useState(null)    // smart-guide lines (world px)
  const [selAnchor, setSelAnchor] = useState(null) // {objId, pi, i}
  const [editName, setEditName] = useState(null)
  const [dragHud, setDragHud] = useState(null) // {x,y,text} world px readout while resizing/rotating
  const [gapHud, setGapHud] = useState(null) // distance labels while moving
  const [showKeys, setShowKeys] = useState(false)
  const [snaps, setSnaps] = useState(() => {
    try { return JSON.parse(localStorage.getItem('logolab-snaps-v1')) || [] } catch { return [] }
  })

  const boardRef = useRef(null)
  const wrapRef = useRef(null)
  const dragRef = useRef(null)
  const toastTimer = useRef(null)
  const parseCache = useRef(new Map())
  const histRef = useRef({ past: [], future: [], tag: null, t: 0 })
  // Internal clipboard for Ctrl+F (Paste in Front) — stores full object
  // snapshots at Ctrl+C time so a duplicate lands at the exact same position.
  const clipboardRef = useRef(null)

  const objectsRef = useRef(objects)
  objectsRef.current = objects
  const selIdsRef = useRef(selIds)
  selIdsRef.current = selIds

  const cell = gridCell
  const bg = bgWhite ? BG_WHITE : BG_DARK
  const fg = bgWhite ? '#111111' : '#FFFFFF'
  const selId = selIds.length === 1 ? selIds[0] : null
  const selObj = objects.find((o) => o.id === selId) || null

  function notify(msg) {
    setToast(msg)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2200)
  }

  // Expand selection to full groups (same groupId). Alt bypasses at call sites.
  function expandGroup(ids) {
    const objs = objectsRef.current
    const out = new Set(ids)
    for (const id of ids) {
      const g = objs.find((o) => o.id === id)?.groupId
      if (!g) continue
      for (const o of objs) if (o.groupId === g) out.add(o.id)
    }
    return [...out]
  }

  // ---- undo / redo ----------------------------------------------------------

  // Snapshot the current objects array (all mutations are immutable, so
  // by-reference snapshots are safe). Same-tag calls within 600ms coalesce —
  // one undo step per slider drag, not per tick.
  function record(tag = null) {
    const h = histRef.current
    const now = Date.now()
    if (tag && h.tag === tag && now - h.t < 600) {
      h.t = now
      return
    }
    h.past.push(objectsRef.current)
    if (h.past.length > 100) h.past.shift()
    h.future = []
    h.tag = tag
    h.t = now
  }

  function undo() {
    const h = histRef.current
    if (!h.past.length) return
    h.future.push(objectsRef.current)
    const prev = h.past.pop()
    h.tag = null
    setObjects(prev)
    setSelIds((ids) => ids.filter((id) => prev.some((o) => o.id === id)))
    setSelAnchor(null) // anchor indices may not exist in the restored paths
  }

  function redo() {
    const h = histRef.current
    if (!h.future.length) return
    h.past.push(objectsRef.current)
    const next = h.future.pop()
    h.tag = null
    setObjects(next)
    setSelIds((ids) => ids.filter((id) => next.some((o) => o.id === id)))
    setSelAnchor(null)
  }

  // ---- persistence ----------------------------------------------------------

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify({ v: 1, objects, bgWhite, gridCell, cam }))
      } catch { /* quota — skip */ }
    }, 300)
    return () => clearTimeout(t)
  }, [objects, bgWhite, gridCell, cam])

  useEffect(() => {
    setSelAnchor(null)
  }, [selId])

  // ---- parsing + placement --------------------------------------------------

  const parsed = useMemo(() => {
    if (parseCache.current.size > 300) parseCache.current.clear()
    const m = {}
    for (const o of objects) {
      const k = srcKey(o)
      if (!parseCache.current.has(k)) {
        parseCache.current.set(k, o.shape ? buildShapeSrc(o) : buildSource(o.code))
      }
      m[o.id] = parseCache.current.get(k)
    }
    return m
  }, [objects])

  // Placement: object position is stored in grid cells. With a detected grid
  // (drawn shapes always have one — unit 1), one symbol unit maps to one canvas
  // cell; otherwise `sizeCells` sets height. Rotation is applied *after*
  // effects, at final placement, so effects and boxes stay axis-aligned.
  const boxes = useMemo(() => {
    const m = {}
    for (const o of objects) {
      const src = parsed[o.id]
      if (!src) continue
      const scale = src.grid ? cell / src.grid.unit : (o.sizeCells * cell) / src.h
      const x = o.x * cell
      const y = o.y * cell
      m[o.id] = { src, scale, box: { x, y, w: src.w * scale, h: src.h * scale } }
    }
    return m
  }, [objects, parsed, cell])

  // Placement transform: rotate first (rightmost in SVG list), then flip around
  // the box center so flipX/flipY mirror the final rendered artwork.
  function placeTransform(o, box) {
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    const parts = []
    // Leftmost is applied last — flip after rotate so mirrors stay axis-aligned.
    if (o.flipX || o.flipY) {
      parts.push(
        `translate(${cx} ${cy}) scale(${o.flipX ? -1 : 1} ${o.flipY ? -1 : 1}) translate(${-cx} ${-cy})`,
      )
    }
    if (o.rot) parts.push(`rotate(${o.rot} ${cx} ${cy})`)
    return parts.length ? parts.join(' ') : undefined
  }

  // Inverse of placeTransform: world px → un-flipped / un-rotated world px.
  function unplacePoint(wx, wy, o, box) {
    const cx = box.x + box.w / 2
    const cy = box.y + box.h / 2
    let x = wx
    let y = wy
    if (o.flipX) x = 2 * cx - x
    if (o.flipY) y = 2 * cy - y
    if (o.rot) {
      const p = rotatePt(x, y, cx, cy, -o.rot)
      x = p.x
      y = p.y
    }
    return { x, y }
  }

  // ---- raster sampling for mosaic/lines/speed -------------------------------

  const rasterSig = objects
    .filter((o) => o.effects.some((fx) => EFFECTS[fx.type]?.raster))
    .map((o) => {
      const pb = boxes[o.id]
      return pb
        ? `${o.id}:${hashStr(srcKey(o))}:${Math.round(pb.box.w)}x${Math.round(pb.box.h)}`
        : o.id
    })
    .join(';') + `|${fg}`

  useEffect(() => {
    let stale = false
    ;(async () => {
      const next = {}
      for (const o of objectsRef.current) {
        if (!o.effects.some((fx) => EFFECTS[fx.type]?.raster)) continue
        const pb = boxes[o.id]
        if (!pb) continue
        const r = await rasterize(pb.src, pb.box.w, pb.box.h, fg)
        if (r) next[o.id] = r
      }
      if (!stale) setRasters(next)
    })()
    return () => {
      stale = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rasterSig])

  const samplesMap = useMemo(() => {
    const m = {}
    for (const o of objects) {
      const r = rasters[o.id]
      const pb = boxes[o.id]
      if (!r || !pb) continue
      for (const fx of o.effects) {
        const def = EFFECTS[fx.type]
        if (def?.sample) m[fx.id] = def.sample(r.data, r.bw, r.bh, pb.box, cell, fx.params)
      }
    }
    return m
  }, [objects, rasters, boxes, cell])

  // ---- effect chain rendering -----------------------------------------------

  const rendered = useMemo(() => {
    return objects
      .filter((o) => o.visible)
      .map((o) => {
        const pb = boxes[o.id]
        if (!pb) return null
        const srcId = `src-${o.id}`
        const defsNodes = []
        let prev = srcId
        o.effects.forEach((fx, k) => {
          const def = EFFECTS[fx.type]
          if (!def) return
          const ctx = {
            srcId: `#${prev}`,
            uid: `${o.id}-${k}`,
            box: pb.box,
            cell,
            fg,
            bg,
            scale: pb.scale,
            rng: mulberry32(fx.seed || 1),
            p: fx.params,
            samples: samplesMap[fx.id],
          }
          const gid = `fx-${o.id}-${k}`
          defsNodes.push(<g key={gid} id={gid}>{def.render(ctx)}</g>)
          prev = gid
        })
        return { obj: o, pb, srcId, defsNodes, finalId: prev }
      })
      .filter(Boolean)
  }, [objects, boxes, cell, fg, bg, samplesMap])

  // ---- viewport + camera ----------------------------------------------------

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect
      setVp({ w: Math.max(r.width, 1), h: Math.max(r.height, 1) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  function toWorld(e) {
    const r = boardRef.current.getBoundingClientRect()
    return { x: cam.x + (e.clientX - r.left) / cam.z, y: cam.y + (e.clientY - r.top) / cam.z }
  }

  // World point → cell coords, snapped to `step` cells (0 = free).
  function toCells(e, step) {
    const w = toWorld(e)
    let x = w.x / cell
    let y = w.y / cell
    if (step) {
      x = Math.round(x / step) * step
      y = Math.round(y / step) * step
    }
    return { x, y }
  }

  // Wheel: plain = pan (shift = horizontal), ctrl/cmd = zoom to cursor.
  useEffect(() => {
    const el = boardRef.current
    if (!el) return
    function onWheel(e) {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        setCam((c) => {
          const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1
          const z = Math.min(Math.max(c.z * factor, MIN_ZOOM), MAX_ZOOM)
          const r = el.getBoundingClientRect()
          const px = (e.clientX - r.left)
          const py = (e.clientY - r.top)
          return {
            x: c.x + px / c.z - px / z,
            y: c.y + py / c.z - py / z,
            z,
          }
        })
      } else {
        let dx = e.deltaX
        let dy = e.deltaY
        if (e.shiftKey && !dx) {
          dx = dy
          dy = 0
        }
        setCam((c) => ({ ...c, x: c.x + dx / c.z, y: c.y + dy / c.z }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  function zoomBy(factor) {
    setCam((c) => {
      const z = Math.min(Math.max(c.z * factor, MIN_ZOOM), MAX_ZOOM)
      const cx = c.x + vp.w / c.z / 2
      const cy = c.y + vp.h / c.z / 2
      return { x: cx - vp.w / z / 2, y: cy - vp.h / z / 2, z }
    })
  }

  function zoomTo(z) {
    setCam((c) => {
      const cx = c.x + vp.w / c.z / 2
      const cy = c.y + vp.h / c.z / 2
      return { x: cx - vp.w / z / 2, y: cy - vp.h / z / 2, z }
    })
  }

  function zoomFit() {
    const bs = Object.values(boxes)
    if (!bs.length) {
      setCam({ x: -vp.w / 2, y: -vp.h / 2, z: 1 })
      return
    }
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const o of objectsRef.current) {
      const pb = boxes[o.id]
      if (!pb || !o.visible) continue
      const rb = rotatedAABB(pb.box, o.rot)
      x1 = Math.min(x1, rb.x)
      y1 = Math.min(y1, rb.y)
      x2 = Math.max(x2, rb.x + rb.w)
      y2 = Math.max(y2, rb.y + rb.h)
    }
    if (x1 === Infinity) {
      setCam({ x: -vp.w / 2, y: -vp.h / 2, z: 1 })
      return
    }
    const pad = cell * 4
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad
    const z = Math.min(Math.max(Math.min(vp.w / (x2 - x1), vp.h / (y2 - y1)), MIN_ZOOM), MAX_ZOOM)
    setCam({ x: (x1 + x2) / 2 - vp.w / z / 2, y: (y1 + y2) / 2 - vp.h / z / 2, z })
  }

  // ---- object creation ------------------------------------------------------

  function shapeName(type) {
    const n = objectsRef.current.filter((o) => o.shape?.type === type).length + 1
    return `${SHAPE_NAMES[type]} ${n}`
  }

  function addShapeObj(o, { keepTool = false } = {}) {
    record()
    setObjects((objs) => [...objs, o])
    setSelIds([o.id])
    // Drawing tools return to Move for resize; Pen stays so you can edit nodes.
    if (!keepTool) setTool('select')
  }

  function commitDraw(d) {
    if (d.tool === 'line') {
      const len = Math.hypot(d.bx - d.ax, d.by - d.ay)
      if (len < 0.25) return
      const shape = { type: 'line', pts: [[d.ax, d.ay], [d.bx, d.by]], t: 0.5 }
      const s = shapeSource(shape, 0, 0)
      addShapeObj({
        id: newId('o'), name: shapeName('line'), shape,
        x: r4(s.x), y: r4(s.y), rot: 0, fill: fg, visible: true, effects: [],
      })
      return
    }
    let { x, y, w, h } = d
    if (w < 0.5 && h < 0.5) {
      // Click without drag → default 4×4 at the click cell.
      w = 4
      h = 4
    }
    w = Math.max(1, Math.round(w))
    h = Math.max(1, Math.round(h))
    // Rect/ellipse are born as editable pen paths (anchors ready to drag).
    // Poly/star stay parametric so sides/points/inner keep their sliders;
    // double-click converts them on demand.
    const parametric = { ...SHAPE_DEFAULTS[d.tool] }
    const shape = (d.tool === 'rect' || d.tool === 'ellipse')
      ? toPen(parametric, w, h)
      : parametric
    addShapeObj({
      id: newId('o'), name: shapeName(d.tool), shape,
      x: Math.round(x), y: Math.round(y), w, h, rot: 0, fill: fg, visible: true, effects: [],
    })
  }

  function commitPen(closed) {
    const raw = pen?.pts || []
    setPen(null)
    const pts = raw.filter(
      (p, i, a) => i === 0 || Math.hypot(p.x - a[i - 1].x, p.y - a[i - 1].y) > 1e-6,
    )
    if (pts.length >= 3 && closed) {
      const f = pts[0], l = pts[pts.length - 1]
      if (Math.hypot(f.x - l.x, f.y - l.y) < 1e-6) pts.pop()
    }
    if (pts.length < 2) {
      setTool('select')
      return
    }
    const shape = { type: 'pen', paths: [{ pts, closed }], round: 0 }
    const bb = penBBox([{ pts, closed }])
    addShapeObj({
      id: newId('o'), name: shapeName('pen'), shape,
      x: r4(bb.x), y: r4(bb.y), rot: 0, fill: fg, visible: true, effects: [],
    }, { keepTool: true })
  }

  function cancelPen() {
    setPen(null)
  }

  // Convert a pasted logo into editable pen-path objects (one per element).
  function convertToPaths(obj) {
    const pb = boxes[obj.id]
    if (!pb) return
    const src = pb.src
    const k = pb.scale / cell // source units → cells
    let parts = []
    if (src.items[0]?.kind === 'svg') {
      parts = extractEditablePaths(src.items[0].markup)
    } else if (src.items[0]?.kind === 'path') {
      const paths = dToPen(src.items[0].d)
      if (paths) parts = [{ paths, fill: null, fillRule: 'nonzero' }]
    }
    if (!parts.length) {
      notify('Nothing convertible in this SVG')
      return
    }
    // Source units → world cells; bake the object's rotation into geometry
    // (each part gets its own bbox center, so a shared rot angle would drift).
    const bcx = (pb.box.x + pb.box.w / 2) / cell
    const bcy = (pb.box.y + pb.box.h / 2) / cell
    const rot = obj.rot || 0
    const newObjs = parts.map((part, idx) => {
      const paths = part.paths.map((sp) => ({
        closed: sp.closed,
        pts: sp.pts.map((p) => {
          let x = obj.x + (p.x - src.x) * k
          let y = obj.y + (p.y - src.y) * k
          let { hox, hoy, hix, hiy } = p
          hox *= k; hoy *= k; hix *= k; hiy *= k
          if (rot) {
            const rp = rotatePt(x, y, bcx, bcy, rot)
            x = rp.x; y = rp.y
            const ro = rotatePt(hox, hoy, 0, 0, rot)
            hox = ro.x; hoy = ro.y
            const ri = rotatePt(hix, hiy, 0, 0, rot)
            hix = ri.x; hiy = ri.y
          }
          if (obj.flipX) {
            x = 2 * bcx - x
            hox = -hox
            hix = -hix
          }
          if (obj.flipY) {
            y = 2 * bcy - y
            hoy = -hoy
            hiy = -hiy
          }
          return { x: r4(x), y: r4(y), hox: r4(hox), hoy: r4(hoy), hix: r4(hix), hiy: r4(hiy) }
        }),
      }))
      const bb = penBBox(paths)
      return {
        id: newId('o'),
        name: parts.length > 1 ? `${obj.name} · ${idx + 1}` : `${obj.name} (paths)`,
        shape: { type: 'pen', paths, fillRule: part.fillRule, round: 0 },
        x: r4(bb.x), y: r4(bb.y), rot: 0,
        fill: part.fill || fg,
        visible: obj.visible, effects: [],
      }
    })
    record()
    setObjects((prev) => {
      const at = prev.findIndex((o) => o.id === obj.id)
      const keep = prev.filter((o) => o.id !== obj.id)
      return [...keep.slice(0, at), ...newObjs, ...keep.slice(at)]
    })
    setSelIds(newObjs.map((o) => o.id))
    setPen(null)
    setTool('pen')
    notify(obj.effects.length
      ? `Converted to ${newObjs.length} editable path${newObjs.length > 1 ? 's' : ''} — effects removed`
      : `Converted to ${newObjs.length} editable path${newObjs.length > 1 ? 's' : ''}`)
  }

  // ---- pointer interactions -------------------------------------------------

  const panning = tool === 'hand' || spaceHeld

  function movingSetup(ids) {
    const mbs = ids.map((i) => boxes[i]?.box).filter(Boolean)
    let mb0 = null
    if (mbs.length) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      for (const b of mbs) {
        x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y)
        x2 = Math.max(x2, b.x + b.w); y2 = Math.max(y2, b.y + b.h)
      }
      mb0 = { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
    }
    const others = objectsRef.current
      .filter((o) => o.visible && !ids.includes(o.id) && boxes[o.id])
      .map((o) => boxes[o.id].box)
    return { mb0, others }
  }

  function onBoardPointerDown(e) {
    if (e.button === 1 || panning) {
      dragRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, cx: cam.x, cy: cam.y }
      boardRef.current.setPointerCapture(e.pointerId)
      e.preventDefault()
      return
    }
    if (e.button !== 0) return

    if (tool === 'pen') {
      // If not mid-draw, clicking an existing object selects it for node edit
      // (no resize — that's Move tool only). Only empty canvas starts a path.
      if (!pen) {
        const hitEl = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-hit]')
        if (hitEl) {
          const id = hitEl.getAttribute('data-hit')
          const ids = e.altKey ? [id] : expandGroup([id])
          setSelIds(ids)
          setSelAnchor(null)
          return
        }
        if (!e.shiftKey) setSelIds([])
      }
      const c = toCells(e, e.altKey ? 0 : 0.5)
      if (pen && pen.pts.length >= 2) {
        const p0 = pen.pts[0]
        const distPx = Math.hypot(c.x - p0.x, c.y - p0.y) * cell * cam.z
        if (distPx < 10) {
          commitPen(true)
          return
        }
      }
      setPen((p) => ({
        pts: [...(p?.pts || []), { x: c.x, y: c.y, hox: 0, hoy: 0, hix: 0, hiy: 0 }],
        cur: null,
      }))
      dragRef.current = { mode: 'penDrag' }
      boardRef.current.setPointerCapture(e.pointerId)
      return
    }

    if (DRAW_TOOLS.includes(tool)) {
      const step = e.altKey ? 0 : tool === 'line' ? 0.5 : 1
      const c = toCells(e, step)
      const d = tool === 'line'
        ? { tool, ax: c.x, ay: c.y, bx: c.x, by: c.y }
        : { tool, x0: c.x, y0: c.y, x: c.x, y: c.y, w: 0, h: 0 }
      dragRef.current = { mode: 'draw', draft: d }
      setDraft(d)
      boardRef.current.setPointerCapture(e.pointerId)
      return
    }

    // select tool on empty board → marquee
    const start = toWorld(e)
    if (!e.shiftKey) setSelIds([])
    dragRef.current = { mode: 'marquee', start, base: e.shiftKey ? selIdsRef.current : [] }
    boardRef.current.setPointerCapture(e.pointerId)
  }

  function onObjectPointerDown(e, id) {
    if (e.button === 1 || panning) return
    if (e.button !== 0) return
    // Pen tool: select for node editing only — never move/resize here.
    if (tool === 'pen') {
      e.stopPropagation()
      if (pen) return // mid-draw: ignore object hits
      let ids = e.shiftKey
        ? (selIdsRef.current.includes(id)
          ? selIdsRef.current.filter((x) => x !== id)
          : [...selIdsRef.current, id])
        : (e.altKey ? [id] : expandGroup(selIdsRef.current.includes(id) ? selIdsRef.current : [id]))
      setSelIds(ids)
      setSelAnchor(null)
      return
    }
    if (tool !== 'select') return // bubble to board for draw tools
    e.stopPropagation()
    let ids
    if (e.shiftKey) {
      ids = selIdsRef.current.includes(id)
        ? selIdsRef.current.filter((x) => x !== id)
        : [...selIdsRef.current, id]
      setSelIds(ids)
      return // shift-click toggles, never drags
    }
    ids = selIdsRef.current.includes(id) ? selIdsRef.current : [id]
    if (!e.altKey) ids = expandGroup(ids)
    // Locked layers can be selected but not moved/duplicated via drag.
    const locked = ids.some((i) => objectsRef.current.find((o) => o.id === i)?.locked)
    if (locked && !e.altKey) {
      setSelIds(ids)
      return
    }
    const setup = movingSetup(ids)

    if (e.altKey) {
      if (ids.some((i) => objectsRef.current.find((o) => o.id === i)?.locked)) {
        setSelIds(ids)
        notify('Unlock layers to duplicate')
        return
      }
      // Alt+drag duplicates the selection and drags the copies.
      record()
      const sel = objectsRef.current.filter((o) => ids.includes(o.id))
      const clones = sel.map((o) => {
        const c = JSON.parse(JSON.stringify(o))
        c.id = newId('o')
        c.name = `${o.name} copy`
        c.effects.forEach((fx) => { fx.id = newId('f') })
        return c
      })
      setObjects((objs) => [...objs, ...clones])
      const cids = clones.map((c) => c.id)
      setSelIds(cids)
      const orig = {}
      clones.forEach((c) => { orig[c.id] = { x: c.x, y: c.y } })
      dragRef.current = {
        mode: 'move', ids: cids, start: toWorld(e), orig, moved: true,
        mb0: setup.mb0,
        others: objectsRef.current
          .filter((o) => o.visible && boxes[o.id])
          .map((o) => boxes[o.id].box),
      }
      boardRef.current.setPointerCapture(e.pointerId)
      return
    }

    setSelIds(ids)
    const orig = {}
    for (const o of objectsRef.current) {
      if (ids.includes(o.id)) orig[o.id] = { x: o.x, y: o.y }
    }
    dragRef.current = { mode: 'move', ids, start: toWorld(e), orig, moved: false, ...setup }
    boardRef.current.setPointerCapture(e.pointerId)
  }

  function onHandlePointerDown(e, corner) {
    if (e.button !== 0 || !selObj || selObj.locked) return
    e.stopPropagation()
    const pb = boxes[selObj.id]
    if (!pb) return
    dragRef.current = {
      mode: 'resize', id: selObj.id, corner, orig: selObj, moved: false,
      b0: { x: selObj.x, y: selObj.y, w: pb.box.w / cell, h: pb.box.h / cell },
      src0: { x: pb.src.x, y: pb.src.y, w: pb.src.w, h: pb.src.h },
      c0: { x: pb.box.x + pb.box.w / 2, y: pb.box.y + pb.box.h / 2 },
    }
    boardRef.current.setPointerCapture(e.pointerId)
  }

  function onRotatePointerDown(e) {
    if (e.button !== 0 || !selObj || selObj.locked) return
    e.stopPropagation()
    const pb = boxes[selObj.id]
    if (!pb) return
    const cx = pb.box.x + pb.box.w / 2
    const cy = pb.box.y + pb.box.h / 2
    const w = toWorld(e)
    dragRef.current = {
      mode: 'rotate', id: selObj.id, cx, cy, moved: false,
      a0: (Math.atan2(w.y - cy, w.x - cx) * 180) / Math.PI,
      rot0: selObj.rot || 0,
    }
    boardRef.current.setPointerCapture(e.pointerId)
  }

  function onAnchorPointerDown(e, pi, i) {
    if (e.button !== 0 || !selObj?.shape || selObj.shape.type !== 'pen' || selObj.locked) return
    e.stopPropagation()
    const pb = boxes[selObj.id]
    if (!pb) return
    setSelAnchor({ objId: selObj.id, pi, i })
    dragRef.current = {
      mode: 'anchor', id: selObj.id, pi, i, orig: selObj, moved: false,
      start: toWorld(e), src0: { x: pb.src.x, y: pb.src.y },
      c0: { x: pb.box.x + pb.box.w / 2, y: pb.box.y + pb.box.h / 2 },
    }
    boardRef.current.setPointerCapture(e.pointerId)
  }

  function onHandleDotPointerDown(e, pi, i, side) {
    if (e.button !== 0 || !selObj?.shape || selObj.shape.type !== 'pen' || selObj.locked) return
    e.stopPropagation()
    const pb = boxes[selObj.id]
    if (!pb) return
    const paths = penPaths(selObj.shape)
    const p = paths[pi].pts[i]
    dragRef.current = {
      mode: 'handle', id: selObj.id, pi, i, side, orig: selObj, moved: false,
      src0: { x: pb.src.x, y: pb.src.y },
      c0: { x: pb.box.x + pb.box.w / 2, y: pb.box.y + pb.box.h / 2 },
      // anchor position in world cells
      aw: { x: selObj.x + p.x - pb.src.x, y: selObj.y + p.y - pb.src.y },
    }
    boardRef.current.setPointerCapture(e.pointerId)
  }

  // Toggle a pen anchor between corner (no handles) and smooth (tangent handles).
  function toggleAnchorSmooth(objId, pi, i) {
    const o = objectsRef.current.find((x) => x.id === objId)
    if (!o?.shape || o.shape.type !== 'pen') return
    const pb = boxes[objId]
    if (!pb) return
    const paths = penPaths(o.shape)
    const sp = paths[pi]
    const p = sp.pts[i]
    const n = sp.pts.length
    let np
    if (p.hox || p.hoy || p.hix || p.hiy) {
      np = { ...p, hox: 0, hoy: 0, hix: 0, hiy: 0 }
    } else {
      const prev = sp.pts[(i - 1 + n) % n]
      const next = sp.pts[(i + 1) % n]
      const tx = next.x - prev.x
      const ty = next.y - prev.y
      const tl = Math.hypot(tx, ty) || 1
      const d1 = Math.hypot(p.x - prev.x, p.y - prev.y)
      const d2 = Math.hypot(next.x - p.x, next.y - p.y)
      // Smooth handles land on the quarter-cell grid (fall back to exact
      // tangent thirds when snapping would collapse them to zero).
      const snapQ = (v) => Math.round(v * 4) / 4
      let hox = snapQ((tx / tl) * (d2 / 3)), hoy = snapQ((ty / tl) * (d2 / 3))
      let hix = snapQ((-tx / tl) * (d1 / 3)), hiy = snapQ((-ty / tl) * (d1 / 3))
      if (!hox && !hoy && !hix && !hiy) {
        hox = r4((tx / tl) * (d2 / 3)); hoy = r4((ty / tl) * (d2 / 3))
        hix = r4((-tx / tl) * (d1 / 3)); hiy = r4((-ty / tl) * (d1 / 3))
      }
      np = { ...p, hox, hoy, hix, hiy }
    }
    const newPaths = paths.map((s, a) =>
      a === pi ? { ...s, pts: s.pts.map((q, b) => (b === i ? np : q)) } : s,
    )
    const shape = { ...o.shape, pts: undefined, closed: undefined, paths: newPaths }
    const ns = shapeSource(shape, o.w, o.h)
    record()
    setObjects((objs) => objs.map((x) =>
      x.id === objId
        ? { ...x, x: r4(o.x + (ns.x - pb.src.x)), y: r4(o.y + (ns.y - pb.src.y)), shape }
        : x,
    ))
  }

  function applyResize(orig, src0, x, y, w, h) {
    if (orig.shape) {
      if (FREE_SHAPE(orig.shape.type)) {
        const sx = w / src0.w
        const sy = h / src0.h
        return { ...orig, x: r4(x), y: r4(y), shape: scaleShape(orig.shape, src0.x, src0.y, sx, sy) }
      }
      return { ...orig, x: r4(x), y: r4(y), w: Math.max(1, r4(w)), h: Math.max(1, r4(h)) }
    }
    if (parseCache.current.get(srcKey(orig))?.grid) return orig // grid-locked logo
    return { ...orig, x: r4(x), y: r4(y), sizeCells: Math.max(2, Math.round(h)) }
  }

  function onBoardPointerMove(e) {
    const d = dragRef.current
    if (!d) {
      if (tool === 'pen' && pen) {
        const c = toCells(e, e.altKey ? 0 : 0.5)
        setPen((p) => (p ? { ...p, cur: c } : p))
      }
      return
    }
    if (d.mode === 'pan') {
      setCam((c) => ({ ...c, x: d.cx - (e.clientX - d.sx) / c.z, y: d.cy - (e.clientY - d.sy) / c.z }))
    } else if (d.mode === 'move') {
      const w = toWorld(e)
      const rawDx = w.x - d.start.x
      const rawDy = w.y - d.start.y
      // Default snap: whole cells. Smart guides override within threshold
      // (hold Ctrl to suppress them).
      let dxPx = Math.round(rawDx / cell) * cell
      let dyPx = Math.round(rawDy / cell) * cell
      let lines = null
      if (d.mb0 && d.others.length && !e.ctrlKey) {
        const thr = 8 / cam.z
        const mb = { x: d.mb0.x + rawDx, y: d.mb0.y + rawDy, w: d.mb0.w, h: d.mb0.h }
        const sd = smartDelta(mb, d.others, thr)
        if (sd.dx !== null) dxPx = rawDx + sd.dx
        if (sd.dy !== null) dyPx = rawDy + sd.dy
        const fb = { x: d.mb0.x + dxPx, y: d.mb0.y + dyPx, w: d.mb0.w, h: d.mb0.h }
        lines = guideLines(fb, d.others, 0.5)
      }
      setGuides(lines && lines.length ? lines : null)
      const dx = r4(dxPx / cell)
      const dy = r4(dyPx / cell)
      if (!d.moved && (dx || dy)) {
        record(`move:${d.ids.join(',')}`)
        d.moved = true
      }
      if (!d.moved) return
      const fb = { x: d.mb0.x + dxPx, y: d.mb0.y + dyPx, w: d.mb0.w, h: d.mb0.h }
      setGapHud(d.mb0 ? gapLabels(fb, d.others, cell) : null)
      setObjects((objs) => objs.map((o) =>
        d.orig[o.id] ? { ...o, x: r4(d.orig[o.id].x + dx), y: r4(d.orig[o.id].y + dy) } : o,
      ))
    } else if (d.mode === 'marquee') {
      const w = toWorld(e)
      const rect = {
        x: Math.min(d.start.x, w.x),
        y: Math.min(d.start.y, w.y),
        w: Math.abs(w.x - d.start.x),
        h: Math.abs(w.y - d.start.y),
      }
      setMarquee(rect)
      const hit = objectsRef.current
        .filter((o) => {
          const pb = boxes[o.id]
          if (!pb || !o.visible) return false
          const rb = rotatedAABB(pb.box, o.rot)
          return rb.x < rect.x + rect.w && rb.x + rb.w > rect.x &&
            rb.y < rect.y + rect.h && rb.y + rb.h > rect.y
        })
        .map((o) => o.id)
      setSelIds([...new Set([...(d.base || []), ...hit])])
    } else if (d.mode === 'draw') {
      const step = e.altKey ? 0 : d.draft.tool === 'line' ? 0.5 : 1
      const c = toCells(e, step)
      let nd
      if (d.draft.tool === 'line') {
        let bx = c.x
        let by = c.y
        if (e.shiftKey) {
          // Constrain to 45° increments.
          const dx = bx - d.draft.ax
          const dy = by - d.draft.ay
          const len = Math.hypot(dx, dy)
          const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4)
          bx = d.draft.ax + Math.cos(a) * len
          by = d.draft.ay + Math.sin(a) * len
          if (step) {
            bx = Math.round(bx / step) * step
            by = Math.round(by / step) * step
          }
        }
        nd = { ...d.draft, bx, by }
      } else {
        let dx = c.x - d.draft.x0
        let dy = c.y - d.draft.y0
        if (e.shiftKey) {
          const m = Math.max(Math.abs(dx), Math.abs(dy))
          dx = Math.sign(dx || 1) * m
          dy = Math.sign(dy || 1) * m
        }
        nd = {
          ...d.draft,
          x: Math.min(d.draft.x0, d.draft.x0 + dx),
          y: Math.min(d.draft.y0, d.draft.y0 + dy),
          w: Math.abs(dx),
          h: Math.abs(dy),
        }
      }
      d.draft = nd
      setDraft(nd)
    } else if (d.mode === 'penDrag') {
      // Curve handles snap to the half-cell grid too (Alt = free).
      const c = toCells(e, e.altKey ? 0 : 0.5)
      setPen((p) => {
        if (!p || !p.pts.length) return p
        const pts = [...p.pts]
        const a = pts[pts.length - 1]
        let hx = c.x - a.x
        let hy = c.y - a.y
        if (Math.hypot(hx, hy) < 0.15) {
          hx = 0
          hy = 0
        }
        pts[pts.length - 1] = {
          ...a, hox: r4(hx), hoy: r4(hy), hix: r4(-hx), hiy: r4(-hy),
        }
        return { ...p, pts }
      })
    } else if (d.mode === 'resize') {
      let wpt = toWorld(e)
      // Flipped/rotated object: work in local untransformed space.
      if (d.orig.rot || d.orig.flipX || d.orig.flipY) {
        const b0px = { x: d.b0.x * cell, y: d.b0.y * cell, w: d.b0.w * cell, h: d.b0.h * cell }
        wpt = unplacePoint(wpt.x, wpt.y, d.orig, b0px)
      }
      const step = e.altKey ? 0 : FREE_SHAPE(d.orig.shape?.type) ? 0.5 : 1
      let cxp = wpt.x / cell
      let cyp = wpt.y / cell
      if (step) {
        cxp = Math.round(cxp / step) * step
        cyp = Math.round(cyp / step) * step
      }
      const c = d.corner
      const edgeH = c === 'n' || c === 's'
      const edgeV = c === 'e' || c === 'w'
      let x1 = d.b0.x
      let y1 = d.b0.y
      let ww = d.b0.w
      let wh = d.b0.h
      if (!edgeH) {
        if (c.includes('e')) {
          ww = Math.max(cxp - d.b0.x, 0.25)
        } else if (c.includes('w')) {
          const right = d.b0.x + d.b0.w
          x1 = Math.min(cxp, right - 0.25)
          ww = right - x1
        }
      }
      if (!edgeV) {
        if (c.includes('s')) {
          wh = Math.max(cyp - d.b0.y, 0.25)
        } else if (c.includes('n')) {
          const bot = d.b0.y + d.b0.h
          y1 = Math.min(cyp, bot - 0.25)
          wh = bot - y1
        }
      }
      if (e.shiftKey && !edgeH && !edgeV) {
        const s = Math.max(ww / d.b0.w, wh / d.b0.h)
        ww = d.b0.w * s
        wh = d.b0.h * s
        if (c.includes('w')) x1 = d.b0.x + d.b0.w - ww
        if (c.includes('n')) y1 = d.b0.y + d.b0.h - wh
      }
      if (!d.moved) {
        record(`resize:${d.id}`)
        d.moved = true
      }
      setDragHud({
        x: wpt.x,
        y: wpt.y - 16 / cam.z,
        text: `${Math.round(ww * 100) / 100} × ${Math.round(wh * 100) / 100}`,
      })
      setObjects((objs) => objs.map((o) =>
        o.id === d.id ? applyResize(d.orig, d.src0, x1, y1, ww, wh) : o,
      ))
    } else if (d.mode === 'rotate') {
      const w = toWorld(e)
      const a = (Math.atan2(w.y - d.cy, w.x - d.cx) * 180) / Math.PI
      let rot = d.rot0 + (a - d.a0)
      rot = e.shiftKey ? Math.round(rot / 45) * 45 : Math.round(rot)
      if (!d.moved) {
        record(`rot:${d.id}`)
        d.moved = true
      }
      setDragHud({
        x: w.x,
        y: w.y - 16 / cam.z,
        text: `${Math.round(normDeg(rot))}°`,
      })
      setObjects((objs) => objs.map((o) =>
        o.id === d.id ? { ...o, rot: normDeg(rot) } : o,
      ))
    } else if (d.mode === 'anchor') {
      let w = toWorld(e)
      let start = d.start
      if (d.orig.rot || d.orig.flipX || d.orig.flipY) {
        const box = { x: d.c0.x - (boxes[d.id]?.box.w || 0) / 2, y: d.c0.y - (boxes[d.id]?.box.h || 0) / 2, w: boxes[d.id]?.box.w || 0, h: boxes[d.id]?.box.h || 0 }
        // Prefer live box when available.
        const live = boxes[d.id]?.box
        const b = live || box
        w = unplacePoint(w.x, w.y, d.orig, b)
        start = unplacePoint(start.x, start.y, d.orig, b)
      }
      const step = e.altKey ? 0 : 0.5
      const paths = penPaths(d.orig.shape)
      const p0 = paths[d.pi].pts[d.i]
      let dx = (w.x - start.x) / cell
      let dy = (w.y - start.y) / cell
      if (step) {
        // Snap the anchor's ABSOLUTE world position to the half-cell grid —
        // an off-grid anchor (curve split, converted logo) lands back on it.
        const offX = d.orig.x - d.src0.x
        const offY = d.orig.y - d.src0.y
        dx = Math.round((offX + p0.x + dx) / step) * step - offX - p0.x
        dy = Math.round((offY + p0.y + dy) / step) * step - offY - p0.y
      }
      if (!d.moved && (dx || dy)) {
        record(`anchor:${d.id}:${d.pi}:${d.i}`)
        d.moved = true
      }
      if (!d.moved) return
      const newPaths = paths.map((s, a) =>
        a === d.pi
          ? { ...s, pts: s.pts.map((q, b) => (b === d.i ? { ...q, x: r4(p0.x + dx), y: r4(p0.y + dy) } : q)) }
          : s,
      )
      const shape = { ...d.orig.shape, pts: undefined, closed: undefined, paths: newPaths }
      const ns = shapeSource(shape, d.orig.w, d.orig.h)
      setObjects((objs) => objs.map((o) =>
        o.id === d.id
          ? {
              ...o,
              // Keep unmoved anchors world-fixed when the bbox origin shifts.
              x: r4(d.orig.x + (ns.x - d.src0.x)),
              y: r4(d.orig.y + (ns.y - d.src0.y)),
              shape,
            }
          : o,
      ))
    } else if (d.mode === 'handle') {
      let w = toWorld(e)
      if (d.orig.rot || d.orig.flipX || d.orig.flipY) {
        const b = boxes[d.id]?.box || { x: d.c0.x, y: d.c0.y, w: 0, h: 0 }
        w = unplacePoint(w.x, w.y, d.orig, b)
      }
      // Handle tips snap to the quarter-cell grid in ABSOLUTE world coords
      // (Alt+drag = break symmetry, snapping stays on — grid is the whole
      // point; quarter matches the generated kappa handles).
      const hx = Math.round((w.x / cell) * 4) / 4 - d.aw.x
      const hy = Math.round((w.y / cell) * 4) / 4 - d.aw.y
      if (!d.moved) {
        record(`handle:${d.id}:${d.pi}:${d.i}:${d.side}`)
        d.moved = true
      }
      const paths = penPaths(d.orig.shape)
      const newPaths = paths.map((s, a) =>
        a === d.pi
          ? {
              ...s,
              pts: s.pts.map((q, b) => {
                if (b !== d.i) return q
                const np = { ...q }
                if (d.side === 'out') {
                  np.hox = r4(hx); np.hoy = r4(hy)
                  if (!e.altKey) { np.hix = r4(-hx); np.hiy = r4(-hy) }
                } else {
                  np.hix = r4(hx); np.hiy = r4(hy)
                  if (!e.altKey) { np.hox = r4(-hx); np.hoy = r4(-hy) }
                }
                return np
              }),
            }
          : s,
      )
      const shape = { ...d.orig.shape, pts: undefined, closed: undefined, paths: newPaths }
      const ns = shapeSource(shape, d.orig.w, d.orig.h)
      setObjects((objs) => objs.map((o) =>
        o.id === d.id
          ? {
              ...o,
              x: r4(d.orig.x + (ns.x - d.src0.x)),
              y: r4(d.orig.y + (ns.y - d.src0.y)),
              shape,
            }
          : o,
      ))
    }
  }

  function onBoardPointerUp() {
    const d = dragRef.current
    dragRef.current = null
    setGuides(null)
    setDragHud(null)
    setGapHud(null)
    if (!d) return
    if (d.mode === 'draw') {
      setDraft(null)
      commitDraw(d.draft)
    } else if (d.mode === 'marquee') {
      setMarquee(null)
    }
  }

  // Double-clicks are resolved here at the board level: pointer capture from
  // the preceding pointerdown retargets the dblclick to the board, so child
  // handlers never fire — hit-test via elementFromPoint instead.
  function onBoardDoubleClick(e) {
    if (tool === 'pen' && pen && pen.pts.length >= 2) {
      commitPen(false)
      return
    }
    // Node edit (pen) or Move: double-click enters point editing.
    if (tool !== 'select' && tool !== 'pen') return
    const el = document.elementFromPoint(e.clientX, e.clientY)
    const anchorEl = el?.closest('[data-anchor-hit]')
    if (anchorEl && tool === 'pen' && selObj) {
      const [pi, i] = anchorEl.getAttribute('data-anchor-hit').split(':').map(Number)
      toggleAnchorSmooth(selObj.id, pi, i)
      return
    }
    const hitEl = el?.closest('[data-hit]')
    if (hitEl) onObjectDoubleClick(e, hitEl.getAttribute('data-hit'))
  }

  // ---- keyboard ---------------------------------------------------------------

  useEffect(() => {
    function typing(e) {
      const t = e.target
      return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')
    }
    function onKeyDown(e) {
      if (e.code === 'Space' && !typing(e)) {
        setSpaceHeld(true)
        e.preventDefault()
        return
      }
      if (typing(e)) return
      const mod = e.ctrlKey || e.metaKey

      if (mod && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault()
        if (e.shiftKey) redo()
        else undo()
        return
      }
      if (mod && (e.key === 'y' || e.key === 'Y')) {
        e.preventDefault()
        redo()
        return
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        duplicateSel()
        return
      }
      if (mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        pasteInFront()
        return
      }
      if (mod && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault()
        setSelIds(objectsRef.current.map((o) => o.id))
        return
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        zoomBy(1.25)
        return
      }
      if (mod && e.key === '-') {
        e.preventDefault()
        zoomBy(1 / 1.25)
        return
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        zoomTo(1)
        return
      }
      if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault()
        zoomFit()
        return
      }
      // Layer order: ] raise · [ lower · Ctrl+] front · Ctrl+[ back
      if (e.key === ']' || e.key === '[') {
        e.preventDefault()
        const front = e.key === ']'
        if (mod) reorderSel(0, front ? 'front' : 'back')
        else reorderSel(front ? 1 : -1)
        return
      }
      if (mod && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault()
        toggleLockSel()
        return
      }
      if (mod && e.shiftKey && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault()
        flipSel('h')
        return
      }
      if (mod && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
        e.preventDefault()
        flipSel('v')
        return
      }
      if (mod && (e.key === 'g' || e.key === 'G')) {
        e.preventDefault()
        if (e.shiftKey) ungroupSel()
        else groupSel()
        return
      }
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault()
        setShowKeys((v) => !v)
        return
      }
      if (mod) return

      const k = e.key.toLowerCase()
      if (k === 'v') setTool('select')
      else if (k === 'h') setTool('hand')
      else if (k === 'r') setTool('rect')
      else if (k === 'o') setTool('ellipse')
      else if (k === 'l') setTool('line')
      else if (k === 'p') setTool('pen')
      else if (k === 'n') setTool('poly')
      else if (k === 's') setTool('star')
      else if (e.shiftKey && k === 'x') {
        e.preventDefault()
        swapSelFillStroke()
      }
      else if (e.key === 'Enter') {
        if (tool === 'pen' && pen && pen.pts.length >= 2) commitPen(false)
      } else if (e.key === 'Escape') {
        if (showKeys) setShowKeys(false)
        else if (pen) cancelPen()
        else if (draft) {
          dragRef.current = null
          setDraft(null)
        } else if (selAnchor) setSelAnchor(null)
        else if (tool === 'pen' && selIdsRef.current.length) {
          // Leave node edit → Move tool, keep selection
          setTool('select')
        } else setSelIds([])
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selAnchor) deleteAnchor()
        else deleteSel()
      } else if (e.key.startsWith('Arrow')) {
        const ids = selIdsRef.current.filter((id) =>
          !objectsRef.current.find((o) => o.id === id)?.locked)
        if (!ids.length) return
        e.preventDefault()
        const amt = e.shiftKey ? 0.5 : 1
        const dx = e.key === 'ArrowLeft' ? -amt : e.key === 'ArrowRight' ? amt : 0
        const dy = e.key === 'ArrowUp' ? -amt : e.key === 'ArrowDown' ? amt : 0
        record('nudge')
        setObjects((objs) => objs.map((o) =>
          ids.includes(o.id) ? { ...o, x: r4(o.x + dx), y: r4(o.y + dy) } : o,
        ))
      }
    }
    function onKeyUp(e) {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    function onBlur() { setSpaceHeld(false) }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool, pen, draft, selAnchor, boxes, vp, cell, showKeys, snaps, bgWhite, gridCell, cam])

  // Switching away from the pen tool abandons the in-progress path.
  useEffect(() => {
    if (tool !== 'pen' && pen) setPen(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool])

  // ---- paste: new object at viewport center ---------------------------------

  function addLogoFromMarkup(txt, nameHint) {
    const src = buildSource(txt)
    if (!src) {
      notify('SVG not readable — paste the full <svg> markup')
      return false
    }
    record()
    setObjects((objs) => {
      const scale = src.grid ? cell / src.grid.unit : (8 * cell) / src.h
      const cxW = cam.x + vp.w / cam.z / 2 - (src.w * scale) / 2
      const cyW = cam.y + vp.h / cam.z / 2 - (src.h * scale) / 2
      const o = {
        id: newId('o'),
        name: nameHint || `Logo ${objs.filter((x) => !x.shape).length + 1}`,
        code: txt,
        x: Math.round(cxW / cell),
        y: Math.round(cyW / cell),
        rot: 0,
        sizeCells: 8,
        visible: true,
        effects: [],
      }
      setSelIds([o.id])
      return [...objs, o]
    })
    return true
  }

  function onStageDrop(e) {
    e.preventDefault()
    const file = [...(e.dataTransfer?.files || [])][0]
    if (file && /\.logolab$/i.test(file.name)) {
      importLogolabFile(file)
      return
    }
    const svgFile = file && (/svg|xml|text/i.test(file.type) || /\.svg$/i.test(file.name)) ? file : null
    if (!svgFile) {
      const txt = e.dataTransfer?.getData('text/plain') || ''
      if (txt.includes('<svg') || /^[Mm]\s*-?[\d.]/.test(txt.trim())) {
        if (addLogoFromMarkup(txt)) notify('SVG dropped onto the board')
      } else {
        notify('Drop an .svg or .logolab file')
      }
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const txt = String(reader.result || '')
      const base = svgFile.name.replace(/\.svg$/i, '') || undefined
      if (addLogoFromMarkup(txt, base)) notify(`Imported ${svgFile.name}`)
    }
    reader.onerror = () => notify('Could not read file')
    reader.readAsText(svgFile)
  }

  useEffect(() => {
    function onPaste(e) {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      const txt = e.clipboardData?.getData('text/plain') || ''
      if (!txt.includes('<svg') && !/^[Mm]\s*-?[\d.]/.test(txt.trim())) return
      if (addLogoFromMarkup(txt)) notify('SVG pasted onto the board')
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cam, vp, cell])

  // Ctrl+C with a selection copies its SVG (unless real text is selected).
  // Also stashes full object snapshots for Ctrl+F (Paste in Front).
  useEffect(() => {
    function onCopy(e) {
      const t = e.target
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      if (String(window.getSelection() || '')) return
      if (!selIdsRef.current.length) return
      const markup = buildExport(true)
      if (!markup) return
      e.clipboardData.setData('text/plain', markup)
      e.preventDefault()
      clipboardRef.current = selIdsRef.current
        .map((id) => {
          const o = objectsRef.current.find((x) => x.id === id)
          return o ? JSON.parse(JSON.stringify(o)) : null
        })
        .filter(Boolean)
      notify('Selection SVG copied')
    }
    window.addEventListener('copy', onCopy)
    return () => window.removeEventListener('copy', onCopy)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell, bgWhite])

  // ---- object/effect mutations ----------------------------------------------

  function patchObj(id, patch, tag) {
    record(tag)
    setObjects((objs) => objs.map((o) => (o.id === id ? { ...o, ...patch } : o)))
  }

  function patchShape(id, patch, tag) {
    record(tag)
    setObjects((objs) => objs.map((o) =>
      o.id === id ? { ...o, shape: { ...o.shape, ...patch } } : o,
    ))
  }

  // Pen rounding changes the rendered bbox — compensate x/y so the shape
  // doesn't drift while the slider moves.
  function setPenRound(o, r) {
    const oldSrc = shapeSource(o.shape, o.w, o.h)
    const shape = { ...o.shape, round: r }
    const newSrc = shapeSource(shape, o.w, o.h)
    patchObj(o.id, {
      shape,
      x: r4(o.x + (newSrc.x - oldSrc.x)),
      y: r4(o.y + (newSrc.y - oldSrc.y)),
    }, `round:${o.id}`)
  }

  // Bake a drawn shape (or a pen's live rounding) into an editable pen path.
  // Bbox can shift (e.g. line thickness), so x/y compensate like setPenRound.
  function convertShapeToPen(o) {
    const shape = toPen(o.shape, o.w, o.h)
    if (!shape) return
    const oldSrc = shapeSource(o.shape, o.w, o.h)
    const newSrc = shapeSource(shape, o.w, o.h)
    patchObj(o.id, {
      shape,
      x: r4(o.x + (newSrc.x - oldSrc.x)),
      y: r4(o.y + (newSrc.y - oldSrc.y)),
    })
    setPen(null)
    setTool('pen')
    setSelIds([o.id])
  }

  // Double-click editing (Figma/Illustrator style): pasted logos convert to
  // paths, parametric shapes convert to pen, and on a pen outline it inserts
  // a new anchor at the click point (curves split exactly, outline unchanged).
  function onObjectDoubleClick(e, id) {
    if (tool !== 'select' && tool !== 'pen') return
    e.stopPropagation()
    const o = objectsRef.current.find((x) => x.id === id)
    if (!o) return
    if (o.locked) {
      notify('Unlock layer to edit points')
      return
    }
    // Always enter Pen tool for node editing (Move tool never shows anchors).
    setPen(null)
    setTool('pen')
    setSelIds([id])
    if (!o.shape) {
      convertToPaths(o)
      return
    }
    if (o.shape.type !== 'pen' || (o.shape.round || 0) > 0) {
      // Live rounding is baked first so anchors match what's on screen.
      convertShapeToPen(o)
      return
    }
    // Already a pen path: if double-clicked outline, insert anchor; else just enter edit.
    if (tool === 'select') return // switched to pen; next dblclick inserts
    const pb = boxes[id]
    if (!pb) return
    // Click point → the pen's local cell coords (undo flip/rotation first).
    const wpt = toWorld(e)
    const u = unplacePoint(wpt.x, wpt.y, o, pb.box)
    const lx = u.x / cell - (o.x - pb.src.x)
    const ly = u.y / cell - (o.y - pb.src.y)
    const paths = penPaths(o.shape)
    const hit = nearestOnPen(paths, lx, ly)
    const tol = 8 / (cell * cam.z) // 8 screen px
    if (!hit || hit.dist > tol) return
    // On straight segments the new anchor snaps to the half-cell grid along
    // the segment (dominant axis; the outline stays intact). Curve splits
    // keep the exact t so the outline never changes.
    let t = hit.t
    const sp = paths[hit.pi]
    const pa = sp.pts[hit.si]
    const pb2 = sp.pts[(hit.si + 1) % sp.pts.length]
    const straight = !pa.hox && !pa.hoy && !pb2.hix && !pb2.hiy
    if (straight) {
      const dxs = pb2.x - pa.x
      const dys = pb2.y - pa.y
      const offX = o.x - pb.src.x
      const offY = o.y - pb.src.y
      if (Math.abs(dxs) >= Math.abs(dys) && Math.abs(dxs) > 1e-9) {
        const wx2 = offX + pa.x + dxs * t
        t = (Math.round(wx2 / 0.5) * 0.5 - offX - pa.x) / dxs
      } else if (Math.abs(dys) > 1e-9) {
        const wy2 = offY + pa.y + dys * t
        t = (Math.round(wy2 / 0.5) * 0.5 - offY - pa.y) / dys
      }
      t = Math.max(0.02, Math.min(0.98, t))
    }
    patchShape(id, {
      pts: undefined,
      closed: undefined,
      paths: insertAnchor(paths, hit.pi, hit.si, t),
    })
    setSelAnchor({ objId: id, pi: hit.pi, i: hit.si + 1 })
  }

  // Delete the selected pen anchor; empty paths delete the whole object.
  function deleteAnchor() {
    const a = selAnchor
    const o = objectsRef.current.find((x) => x.id === a?.objId)
    setSelAnchor(null)
    if (!o?.shape || o.shape.type !== 'pen') return
    const pb = boxes[o.id]
    if (!pb) return
    const paths = removeAnchor(penPaths(o.shape), a.pi, a.i)
    if (!paths.length) {
      record()
      setObjects((objs) => objs.filter((x) => x.id !== o.id))
      setSelIds([])
      return
    }
    const shape = { ...o.shape, pts: undefined, closed: undefined, paths }
    const ns = shapeSource(shape, o.w, o.h)
    record()
    setObjects((objs) => objs.map((x) =>
      x.id === o.id
        ? { ...x, shape, x: r4(o.x + (ns.x - pb.src.x)), y: r4(o.y + (ns.y - pb.src.y)) }
        : x,
    ))
  }

  function deleteSel() {
    const ids = selIdsRef.current
    if (!ids.length) return
    const kill = ids.filter((id) => !objectsRef.current.find((o) => o.id === id)?.locked)
    if (!kill.length) {
      notify('Unlock layers to delete')
      return
    }
    if (kill.length < ids.length) notify('Locked layers kept')
    record()
    setObjects((objs) => objs.filter((o) => !kill.includes(o.id)))
    setSelIds((s) => s.filter((id) => !kill.includes(id)))
  }

  function duplicateSel() {
    const sel = objectsRef.current.filter((o) => selIdsRef.current.includes(o.id))
    if (!sel.length) return
    record()
    const clones = sel.map((o) => {
      const c = JSON.parse(JSON.stringify(o))
      c.id = newId('o')
      c.name = `${o.name} copy`
      c.x = r4(o.x + 1)
      c.y = r4(o.y + 1)
      c.effects.forEach((fx) => { fx.id = newId('f') })
      return c
    })
    setObjects((objs) => [...objs, ...clones])
    setSelIds(clones.map((c) => c.id))
  }

  // Ctrl+F — Paste in Front (Illustrator): duplicate the internal clipboard at
  // the exact same x/y it was copied from. Independent of the system clipboard
  // (Ctrl+V stays the external SVG paste).
  function pasteInFront() {
    const clip = clipboardRef.current
    if (!clip || !clip.length) {
      notify('Nothing to paste in front — copy first (Ctrl+C)')
      return
    }
    record()
    const clones = clip.map((o) => {
      const c = JSON.parse(JSON.stringify(o))
      c.id = newId('o')
      c.effects.forEach((fx) => { fx.id = newId('f') })
      return c
    })
    setObjects((objs) => [...objs, ...clones])
    setSelIds(clones.map((c) => c.id))
    notify('Pasted in front (same position)')
  }

  function groupSel() {
    const ids = selIdsRef.current
    if (ids.length < 2) {
      notify('Select 2+ layers to group')
      return
    }
    if (ids.some((id) => objectsRef.current.find((o) => o.id === id)?.locked)) {
      notify('Unlock layers to group')
      return
    }
    const gid = newId('g')
    record()
    setObjects((objs) => objs.map((o) =>
      ids.includes(o.id) ? { ...o, groupId: gid } : o,
    ))
    notify(`Grouped ${ids.length} layers`)
  }

  function ungroupSel() {
    const ids = selIdsRef.current
    if (!ids.length) return
    const any = ids.some((id) => objectsRef.current.find((o) => o.id === id)?.groupId)
    if (!any) {
      notify('Selection is not grouped')
      return
    }
    record()
    setObjects((objs) => objs.map((o) =>
      ids.includes(o.id) ? { ...o, groupId: undefined } : o,
    ))
    notify('Ungrouped')
  }

  function boardPayload() {
    return {
      v: 1,
      type: 'logolab',
      objects: objectsRef.current,
      bgWhite,
      gridCell,
      cam,
      at: Date.now(),
    }
  }

  function exportLogolab() {
    const blob = new Blob([JSON.stringify(boardPayload(), null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `logolab-${new Date().toISOString().slice(0, 10)}.logolab`
    a.click()
    URL.revokeObjectURL(a.href)
    notify('Board exported (.logolab)')
  }

  function applyBoardData(data, label) {
    if (!data || data.type !== 'logolab' || !Array.isArray(data.objects)) {
      notify('Invalid .logolab file')
      return false
    }
    record()
    setObjects(data.objects)
    if (typeof data.bgWhite === 'boolean') setBgWhite(data.bgWhite)
    if (data.gridCell) setGridCell(data.gridCell)
    if (data.cam) setCam(data.cam)
    setSelIds([])
    setSelAnchor(null)
    notify(label || 'Board loaded')
    return true
  }

  function importLogolabFile(file) {
    const reader = new FileReader()
    reader.onload = () => {
      try {
        applyBoardData(JSON.parse(String(reader.result || '')), `Loaded ${file.name}`)
      } catch {
        notify('Could not parse .logolab file')
      }
    }
    reader.onerror = () => notify('Could not read file')
    reader.readAsText(file)
  }

  function saveSnapshot() {
    const snap = {
      id: newId('s'),
      name: `Snapshot ${snaps.length + 1}`,
      at: Date.now(),
      data: boardPayload(),
    }
    const next = [snap, ...snaps].slice(0, 12)
    setSnaps(next)
    try { localStorage.setItem('logolab-snaps-v1', JSON.stringify(next)) } catch { /* quota */ }
    notify('Snapshot saved')
  }

  function restoreSnapshot(id) {
    const snap = snaps.find((x) => x.id === id)
    if (!snap) return
    applyBoardData(snap.data, `Restored ${snap.name}`)
  }

  function deleteSnapshot(id) {
    const next = snaps.filter((x) => x.id !== id)
    setSnaps(next)
    try { localStorage.setItem('logolab-snaps-v1', JSON.stringify(next)) } catch { /* */ }
  }

  // Flip selection horizontally or vertically around the selection center.
  // Uses flipX/flipY flags (mirrored at render) and mirrors object positions
  // when more than one layer is selected.
  function flipSel(axis) {
    const ids = selIdsRef.current
    if (!ids.length) return
    if (ids.some((id) => objectsRef.current.find((o) => o.id === id)?.locked)) {
      notify('Unlock layers to flip')
      return
    }
    const entries = ids
      .map((id) => {
        const o = objectsRef.current.find((x) => x.id === id)
        const pb = boxes[id]
        return o && pb ? { id, o, pb } : null
      })
      .filter(Boolean)
    if (!entries.length) return
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const { o, pb } of entries) {
      const rb = rotatedAABB(pb.box, o.rot)
      x1 = Math.min(x1, rb.x); y1 = Math.min(y1, rb.y)
      x2 = Math.max(x2, rb.x + rb.w); y2 = Math.max(y2, rb.y + rb.h)
    }
    const scx = (x1 + x2) / 2
    const scy = (y1 + y2) / 2
    record('flip')
    setObjects((objs) => objs.map((o) => {
      const en = entries.find((e) => e.id === o.id)
      if (!en) return o
      const { pb } = en
      const ocx = pb.box.x + pb.box.w / 2
      const ocy = pb.box.y + pb.box.h / 2
      const ncx = axis === 'h' ? 2 * scx - ocx : ocx
      const ncy = axis === 'v' ? 2 * scy - ocy : ocy
      return {
        ...o,
        x: r4(o.x + (ncx - ocx) / cell),
        y: r4(o.y + (ncy - ocy) / cell),
        flipX: axis === 'h' ? !o.flipX : o.flipX,
        flipY: axis === 'v' ? !o.flipY : o.flipY,
      }
    }))
  }

  // Evenly space 3+ selected objects along an axis (first/last stay put).
  function distributeSel(axis) {
    const entries = selIds
      .map((id) => {
        const o = objects.find((x) => x.id === id)
        const b = boxes[id]?.box
        return o && b && !o.locked ? { id, o, b } : null
      })
      .filter(Boolean)
    if (entries.length < 3) {
      notify('Distribute needs 3+ unlocked layers')
      return
    }
    const sorted = [...entries].sort((a, b) =>
      axis === 'h'
        ? (a.b.x + a.b.w / 2) - (b.b.x + b.b.w / 2)
        : (a.b.y + a.b.h / 2) - (b.b.y + b.b.h / 2),
    )
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    const span = axis === 'h'
      ? (last.b.x + last.b.w / 2) - (first.b.x + first.b.w / 2)
      : (last.b.y + last.b.h / 2) - (first.b.y + first.b.h / 2)
    const step = span / (sorted.length - 1)
    record('dist')
    setObjects((objs) => objs.map((o) => {
      const i = sorted.findIndex((e) => e.id === o.id)
      if (i <= 0 || i === sorted.length - 1) return o
      const target = axis === 'h'
        ? first.b.x + first.b.w / 2 + step * i
        : first.b.y + first.b.h / 2 + step * i
      const cur = axis === 'h'
        ? sorted[i].b.x + sorted[i].b.w / 2
        : sorted[i].b.y + sorted[i].b.h / 2
      const d = (target - cur) / cell
      return axis === 'h'
        ? { ...o, x: r4(o.x + d) }
        : { ...o, y: r4(o.y + d) }
    }))
  }

  function toggleLock(id) {
    const o = objectsRef.current.find((x) => x.id === id)
    if (!o) return
    record()
    setObjects((objs) => objs.map((x) =>
      x.id === id ? { ...x, locked: !x.locked } : x,
    ))
  }

  function toggleLockSel() {
    const ids = selIdsRef.current
    if (!ids.length) return
    const allLocked = ids.every((id) => objectsRef.current.find((o) => o.id === id)?.locked)
    record()
    setObjects((objs) => objs.map((o) =>
      ids.includes(o.id) ? { ...o, locked: !allLocked } : o,
    ))
  }

  // dir: -1 lower, +1 raise; extreme: 'front' | 'back'
  function reorderLayer(id, dir, extreme) {
    record()
    setObjects((objs) => {
      const i = objs.findIndex((o) => o.id === id)
      if (i < 0) return objs
      const next = objs.filter((o) => o.id !== id)
      let j
      if (extreme === 'front') j = next.length
      else if (extreme === 'back') j = 0
      else j = Math.max(0, Math.min(next.length, i + dir))
      // When not extreme, j is index in the array after removal — adjust.
      if (!extreme) {
        const without = [...objs]
        const [item] = without.splice(i, 1)
        const ni = Math.max(0, Math.min(without.length, i + dir))
        without.splice(ni, 0, item)
        return without
      }
      next.splice(j, 0, objs[i])
      return next
    })
  }

  function reorderSel(dir, extreme) {
    const ids = selIdsRef.current
    if (!ids.length) return
    record()
    setObjects((objs) => {
      const selected = objs.filter((o) => ids.includes(o.id))
      const rest = objs.filter((o) => !ids.includes(o.id))
      if (extreme === 'front') return [...rest, ...selected]
      if (extreme === 'back') return [...selected, ...rest]
      // Step one slot as a group.
      const next = [...objs]
      if (dir > 0) {
        for (let i = next.length - 2; i >= 0; i--) {
          if (ids.includes(next[i].id) && !ids.includes(next[i + 1].id)) {
            ;[next[i], next[i + 1]] = [next[i + 1], next[i]]
          }
        }
      } else {
        for (let i = 1; i < next.length; i++) {
          if (ids.includes(next[i].id) && !ids.includes(next[i - 1].id)) {
            ;[next[i], next[i - 1]] = [next[i - 1], next[i]]
          }
        }
      }
      return next
    })
  }

  // Shift+X — swap fill ↔ stroke (Illustrator). For drawn shapes only: pasted
  // logos keep their original colors. The single color stays in `o.fill`; the
  // `outlined` flag flips whether it renders as fill or stroke. One undo step
  // for the whole selection.
  function swapSelFillStroke() {
    const ids = selIdsRef.current
    const shapes = ids
      .map((id) => objectsRef.current.find((o) => o.id === id))
      .filter((o) => o?.shape)
    if (!shapes.length) {
      notify('Swap fill/stroke works on drawn shapes only')
      return
    }
    record('swap')
    setObjects((objs) => objs.map((o) =>
      ids.includes(o.id) && o.shape ? { ...o, outlined: !o.outlined } : o,
    ))
  }

  function addEffect(objId, type) {
    record()
    patchObjEffects(objId, (fxs) => [
      ...fxs,
      { id: newId('f'), type, params: defaultParamsFor(type), seed: newSeed() },
    ])
  }

  function patchObjEffects(objId, fn) {
    setObjects((objs) => objs.map((o) => (o.id === objId ? { ...o, effects: fn(o.effects) } : o)))
  }

  function setFxParam(objId, fxId, key, val) {
    record(`fx:${fxId}:${key}`)
    patchObjEffects(objId, (fxs) =>
      fxs.map((fx) => (fx.id === fxId ? { ...fx, params: { ...fx.params, [key]: val } } : fx)),
    )
  }

  function moveFx(objId, idx, dir) {
    record()
    patchObjEffects(objId, (fxs) => {
      const next = [...fxs]
      const j = idx + dir
      if (j < 0 || j >= next.length) return fxs
      ;[next[idx], next[j]] = [next[j], next[idx]]
      return next
    })
  }

  function moveLayer(id, dir) {
    record()
    setObjects((objs) => {
      const i = objs.findIndex((o) => o.id === id)
      const j = i + dir
      if (i < 0 || j < 0 || j >= objs.length) return objs
      const next = [...objs]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })
  }

  // ---- align + boolean --------------------------------------------------------

  function alignSel(mode) {
    const entries = selIds
      .map((id) => {
        const o = objects.find((x) => x.id === id)
        const b = boxes[id]?.box
        return o && b && !o.locked ? { id, b } : null
      })
      .filter(Boolean)
    if (entries.length < 2) {
      notify('Need 2+ unlocked layers to align')
      return
    }
    const minX = Math.min(...entries.map((x) => x.b.x))
    const maxX = Math.max(...entries.map((x) => x.b.x + x.b.w))
    const minY = Math.min(...entries.map((x) => x.b.y))
    const maxY = Math.max(...entries.map((x) => x.b.y + x.b.h))
    record()
    setObjects((objs) => objs.map((o) => {
      const en = entries.find((x) => x.id === o.id)
      if (!en) return o
      let dx = 0
      let dy = 0
      if (mode === 'left') dx = minX - en.b.x
      else if (mode === 'right') dx = maxX - (en.b.x + en.b.w)
      else if (mode === 'cx') dx = (minX + maxX) / 2 - (en.b.x + en.b.w / 2)
      else if (mode === 'top') dy = minY - en.b.y
      else if (mode === 'bottom') dy = maxY - (en.b.y + en.b.h)
      else if (mode === 'cy') dy = (minY + maxY) / 2 - (en.b.y + en.b.h / 2)
      return { ...o, x: r4(o.x + dx / cell), y: r4(o.y + dy / cell) }
    }))
  }

  const selShapes = selIds
    .map((id) => objects.find((o) => o.id === id))
    .filter((o) => o && o.shape)
  const canBoolean = selIds.length >= 2 && selShapes.length === selIds.length

  const BOOL_LABEL = { union: 'Union', subtract: 'Subtract', intersect: 'Intersect', exclude: 'Exclude' }

  function booleanSel(op) {
    // Bottom-most first (objects array order = z-order); subtract keeps the
    // bottom shape minus everything above it.
    const objs = objectsRef.current.filter((o) => selIdsRef.current.includes(o.id) && o.shape)
    if (objs.length < 2) return
    const geoms = []
    for (const o of objs) {
      const pb = boxes[o.id]
      if (!pb) return
      const offX = o.x - pb.src.x
      const offY = o.y - pb.src.y
      const cx = (pb.box.x + pb.box.w / 2) / cell
      const cy = (pb.box.y + pb.box.h / 2) / cell
      geoms.push(shapePolys(o.shape, o.w, o.h).map((poly) =>
        poly.map((ring) => ring.map(([x, y]) => {
          let wx = x + offX
          let wy = y + offY
          if (o.rot) {
            const rp = rotatePt(wx, wy, cx, cy, o.rot)
            wx = rp.x; wy = rp.y
          }
          if (o.flipX) wx = 2 * cx - wx
          if (o.flipY) wy = 2 * cy - wy
          return [wx, wy]
        })),
      ))
    }
    let mp
    try {
      if (op === 'union') mp = polygonClipping.union(geoms[0], ...geoms.slice(1))
      else if (op === 'subtract') mp = polygonClipping.difference(geoms[0], ...geoms.slice(1))
      else if (op === 'intersect') mp = polygonClipping.intersection(geoms[0], ...geoms.slice(1))
      else mp = polygonClipping.xor(geoms[0], ...geoms.slice(1))
    } catch {
      notify('Boolean failed on this geometry')
      return
    }
    if (!mp || !mp.length) {
      notify(`${BOOL_LABEL[op]} result is empty`)
      return
    }
    const bb = polysBBox(mp)
    const local = mp.map((poly) =>
      poly.map((ring) => ring.map(([x, y]) => [r4(x - bb.x), r4(y - bb.y)])),
    )
    record()
    const nu = {
      id: newId('o'),
      name: BOOL_LABEL[op],
      shape: { type: 'raw', polys: local },
      x: r4(bb.x),
      y: r4(bb.y),
      rot: 0,
      fill: objs[0].fill || fg,
      visible: true,
      effects: [],
    }
    setObjects((prev) => {
      const gone = new Set(objs.map((s) => s.id))
      const keep = prev.filter((o) => !gone.has(o.id))
      // Insert where the bottom-most operand sat, counted among survivors.
      const at = prev.slice(0, prev.findIndex((o) => o.id === objs[0].id))
        .filter((o) => !gone.has(o.id)).length
      return [...keep.slice(0, at), nu, ...keep.slice(at)]
    })
    setSelIds([nu.id])
  }

  function clearBoard() {
    if (!objectsRef.current.length) return
    record()
    setObjects([])
    setSelIds([])
    notify('Board cleared (Ctrl+Z to undo)')
  }

  // ---- export ---------------------------------------------------------------

  function buildExport(onlySelected) {
    const svgEl = boardRef.current
    if (!svgEl) return null
    const ids = selIdsRef.current
    const finals = [...svgEl.querySelectorAll('g[data-final]')].filter(
      (n) => !onlySelected || ids.includes(n.getAttribute('data-final')),
    )
    if (!finals.length) return null
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (const n of finals) {
      const b = n.getBBox()
      if (!b.width && !b.height) continue
      x1 = Math.min(x1, b.x)
      y1 = Math.min(y1, b.y)
      x2 = Math.max(x2, b.x + b.width)
      y2 = Math.max(y2, b.y + b.height)
    }
    if (x1 === Infinity) return null
    const pad = onlySelected ? 0 : cell * 2
    x1 -= pad; y1 -= pad; x2 += pad; y2 += pad
    const clone = svgEl.cloneNode(true)
    clone.querySelectorAll('[data-ui]').forEach((n) => n.remove())
    if (onlySelected) {
      clone.querySelectorAll('[data-obj]').forEach((n) => {
        if (!ids.includes(n.getAttribute('data-obj'))) n.remove()
      })
    } else {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', x1)
      rect.setAttribute('y', y1)
      rect.setAttribute('width', x2 - x1)
      rect.setAttribute('height', y2 - y1)
      rect.setAttribute('fill', bg)
      clone.insertBefore(rect, clone.firstChild.nextSibling)
    }
    clone.setAttribute('viewBox', `${x1} ${y1} ${x2 - x1} ${y2 - y1}`)
    clone.setAttribute('width', Math.round(x2 - x1))
    clone.setAttribute('height', Math.round(y2 - y1))
    clone.removeAttribute('class')
    clone.removeAttribute('style')
    return clone.outerHTML
  }

  async function copySVG() {
    const markup = buildExport(selIds.length > 0)
    if (!markup) {
      notify('Nothing to copy')
      return
    }
    try {
      await navigator.clipboard.writeText(markup)
      notify(selIds.length ? 'Selection SVG copied' : 'Board SVG copied')
    } catch {
      notify('Clipboard blocked — use Download instead')
    }
  }

  function exportName() {
    return `logolab-${selObj ? selObj.name.toLowerCase().replace(/\s+/g, '-') : selIds.length ? 'selection' : 'board'}`
  }

  function downloadSVG() {
    const markup = buildExport(selIds.length > 0)
    if (!markup) {
      notify('Nothing to download')
      return
    }
    const blob = new Blob([markup], { type: 'image/svg+xml' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${exportName()}.svg`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  async function downloadPNG() {
    const markup = buildExport(selIds.length > 0)
    if (!markup) {
      notify('Nothing to download')
      return
    }
    try {
      const svg = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(svg)
      const img = new Image()
      await new Promise((res, rej) => {
        img.onload = res
        img.onerror = rej
        img.src = url
      })
      const scale = 2
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
      canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      const a = document.createElement('a')
      a.href = canvas.toDataURL('image/png')
      a.download = `${exportName()}.png`
      a.click()
      notify('PNG downloaded')
    } catch {
      notify('PNG export failed — try SVG instead')
    }
  }

  // ---- properties helpers ----------------------------------------------------

  const selPb = selObj ? boxes[selObj.id] : null
  const selGridLocked = selObj && !selObj.shape && selPb?.src.grid
  const resizable = selObj && selPb && !selObj.locked && (selObj.shape || !selPb.src.grid)

  function commitSize(axis, v) {
    if (!selObj || !selPb || v <= 0) return
    const wC = selPb.box.w / cell
    const hC = selPb.box.h / cell
    const w = axis === 'w' ? v : wC
    const h = axis === 'h' ? v : hC
    record(`size:${selObj.id}`)
    setObjects((objs) => objs.map((o) =>
      o.id === selObj.id
        ? applyResize(selObj, { x: selPb.src.x, y: selPb.src.y, w: selPb.src.w, h: selPb.src.h },
            selObj.x, selObj.y, w, h)
        : o,
    ))
  }

  // ---- render -----------------------------------------------------------------

  const vw = vp.w / cam.z
  const vh = vp.h / cam.z
  const gridStroke = bgWhite ? '#00000014' : '#ffffff10'
  const drawing = DRAW_TOOLS.includes(tool) || tool === 'pen'
  const cursor = panning
    ? (dragRef.current?.mode === 'pan' ? 'grabbing' : 'grab')
    : drawing ? 'crosshair' : 'default'
  const hairline = 1.5 / cam.z
  const handleSize = 8 / cam.z

  // Draft preview node (shape being dragged out).
  let draftNode = null
  if (draft) {
    if (draft.tool === 'line') {
      const shape = { type: 'line', pts: [[draft.ax, draft.ay], [draft.bx, draft.by]], t: 0.5 }
      const s = shapeSource(shape, 0, 0)
      draftNode = (
        <g data-ui="1" transform={`scale(${cell})`} pointerEvents="none">
          <path d={s.d} fill={`${fg}66`} stroke="#0D99FF" strokeWidth={hairline / cell} />
        </g>
      )
    } else {
      const w = Math.max(draft.w, 0.05)
      const h = Math.max(draft.h, 0.05)
      const s = shapeSource({ ...SHAPE_DEFAULTS[draft.tool] }, w, h)
      draftNode = (
        <g data-ui="1"
          transform={`translate(${draft.x * cell} ${draft.y * cell}) scale(${cell})`}
          pointerEvents="none">
          <path d={s.d} fill={`${fg}66`} stroke="#0D99FF" strokeWidth={hairline / cell} />
        </g>
      )
    }
  }

  // Pen preview (in-progress path + anchors).
  let penNode = null
  if (tool === 'pen' && pen && pen.pts.length) {
    const preview = pen.cur && !dragRef.current
      ? [...pen.pts, { x: pen.cur.x, y: pen.cur.y, hox: 0, hoy: 0, hix: 0, hiy: 0 }]
      : pen.pts
    const d = penD([{ pts: preview, closed: false }])
    const last = pen.pts[pen.pts.length - 1]
    const nearFirst = pen.pts.length >= 2 && pen.cur &&
      Math.hypot(pen.cur.x - pen.pts[0].x, pen.cur.y - pen.pts[0].y) * cell * cam.z < 10
    penNode = (
      <g data-ui="1" pointerEvents="none">
        {d && (
          <g transform={`scale(${cell})`}>
            <path d={d} fill={`${fg}40`} stroke="#0D99FF" strokeWidth={hairline / cell} />
          </g>
        )}
        {(last.hox || last.hoy) ? (
          <line
            x1={(last.x + last.hix) * cell} y1={(last.y + last.hiy) * cell}
            x2={(last.x + last.hox) * cell} y2={(last.y + last.hoy) * cell}
            stroke="#0D99FF" strokeWidth={1 / cam.z} />
        ) : null}
        {pen.pts.map((p, i) => (
          <circle key={i} cx={p.x * cell} cy={p.y * cell}
            r={(i === 0 && nearFirst ? 5.5 : 3.5) / cam.z}
            fill={i === 0 && nearFirst ? '#0D99FF' : '#ffffff'}
            stroke="#0D99FF" strokeWidth={1 / cam.z} />
        ))}
      </g>
    )
  }

  // Move tool (V): resize + rotate only — never node handles.
  // Pen tool (P): node anchors only — never resize handles.
  const transformMode = tool === 'select'
  const nodeEditMode = tool === 'pen' && !pen && selObj?.shape?.type === 'pen' && !!selPb && !selObj.locked

  const bx = selPb?.box
  const corners = (transformMode && resizable && bx)
    ? [
        { c: 'nw', x: bx.x, y: bx.y, cur: 'nwse-resize' },
        { c: 'n', x: bx.x + bx.w / 2, y: bx.y, cur: 'ns-resize' },
        { c: 'ne', x: bx.x + bx.w, y: bx.y, cur: 'nesw-resize' },
        { c: 'e', x: bx.x + bx.w, y: bx.y + bx.h / 2, cur: 'ew-resize' },
        { c: 'se', x: bx.x + bx.w, y: bx.y + bx.h, cur: 'nwse-resize' },
        { c: 's', x: bx.x + bx.w / 2, y: bx.y + bx.h, cur: 'ns-resize' },
        { c: 'sw', x: bx.x, y: bx.y + bx.h, cur: 'nesw-resize' },
        { c: 'w', x: bx.x, y: bx.y + bx.h / 2, cur: 'ew-resize' },
      ]
    : []
  const rotCorners = (transformMode && selObj && selPb && !selObj.locked)
    ? [
        { c: 'nw', x: selPb.box.x, y: selPb.box.y, ox: -1, oy: -1 },
        { c: 'ne', x: selPb.box.x + selPb.box.w, y: selPb.box.y, ox: 1, oy: -1 },
        { c: 'se', x: selPb.box.x + selPb.box.w, y: selPb.box.y + selPb.box.h, ox: 1, oy: 1 },
        { c: 'sw', x: selPb.box.x, y: selPb.box.y + selPb.box.h, ox: -1, oy: 1 },
      ]
    : []

  // Anchors only in Pen tool node-edit mode (Move never edits points).
  const penAnchorInfo = nodeEditMode
    ? penPaths(selObj.shape).flatMap((sp, pi) =>
        sp.pts.map((p, i) => ({
          pi, i, p,
          x: (selObj.x - selPb.src.x + p.x) * cell,
          y: (selObj.y - selPb.src.y + p.y) * cell,
        })))
    : []
  const activeAnchor = selAnchor && selAnchor.objId === selObj?.id
    ? penAnchorInfo.find((a) => a.pi === selAnchor.pi && a.i === selAnchor.i)
    : null

  const toolLabel = TOOLBAR.find((t) => t.id === tool)?.title.split(' (')[0] || tool
  const rotZone = 14 / cam.z
  const selRotT = selObj && selPb ? placeTransform(selObj, selPb.box) : undefined

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <PixelWord text="LOGOLAB" height={16} />
        </div>
        <div className="tools">
          {TOOLBAR.map(({ id, title, Icon }, i) => (
            <span key={id} className="tool-slot">
              {(i === 2) && <span className="tsep" />}
              <button
                className={tool === id ? 'tool on' : 'tool'}
                title={title}
                onClick={() => setTool(id)}>
                <Icon />
              </button>
            </span>
          ))}
          <span className="tsep" />
          <button className="tool" title="Undo (Ctrl+Z)" onClick={undo}><IcUndo /></button>
          <button className="tool" title="Redo (Ctrl+Shift+Z)" onClick={redo}><IcRedo /></button>
        </div>
        <div className="actions">
          <div className="zoomctl">
            <button className="tool" onClick={() => zoomBy(1 / 1.25)} title="Zoom out (Ctrl+-)">−</button>
            <span className="zoomval">{Math.round(cam.z * 100)}%</span>
            <button className="tool" onClick={() => zoomBy(1.25)} title="Zoom in (Ctrl++)">+</button>
            <button className="tool" onClick={zoomFit} title="Zoom to fit (Shift+1)">⤢</button>
          </div>
          <button className="btn" onClick={downloadSVG} title="Download SVG">SVG</button>
          <button className="btn" onClick={downloadPNG} title="Download PNG @2x">PNG</button>
          <button className="btn btn-primary" onClick={copySVG}>
            {selIds.length ? 'Copy selection SVG' : 'Copy board SVG'}
          </button>
        </div>
      </header>

      <div className="layout">
        <aside className="panel left">
          <section>
            <h2>Layers</h2>
            {objects.length === 0 && (
              <p className="hint">
                Ctrl+V an SVG anywhere, or draw:<br />
                R rectangle · O ellipse · L line · P pen
              </p>
            )}
            <div className="layers">
              {[...objects].reverse().map((o) => (
                <div key={o.id}
                  className={selIds.includes(o.id) ? 'layer on' : 'layer'}
                  onClick={(e) => {
                    if (e.shiftKey) {
                      setSelIds((ids) => ids.includes(o.id)
                        ? ids.filter((x) => x !== o.id)
                        : [...ids, o.id])
                    } else setSelIds([o.id])
                  }}
                  onDoubleClick={() => setEditName(o.id)}>
                  <button className="icon" title={o.visible ? 'Hide' : 'Show'}
                    onClick={(e) => { e.stopPropagation(); patchObj(o.id, { visible: !o.visible }) }}>
                    {o.visible ? '●' : '○'}
                  </button>
                  <button className={`icon${o.locked ? ' on' : ''}`} title={o.locked ? 'Unlock (Ctrl+L)' : 'Lock (Ctrl+L)'}
                    onClick={(e) => { e.stopPropagation(); toggleLock(o.id) }}>
                    {o.locked ? <IcLock /> : <IcUnlock />}
                  </button>
                  {editName === o.id ? (
                    <input
                      className="layer-rename"
                      defaultValue={o.name}
                      autoFocus
                      onFocus={(e) => e.target.select()}
                      onBlur={(e) => {
                        const v = e.target.value.trim()
                        if (v && v !== o.name) patchObj(o.id, { name: v }, `name:${o.id}`)
                        setEditName(null)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') e.target.blur()
                        if (e.key === 'Escape') {
                          e.target.value = o.name
                          e.target.blur()
                        }
                      }} />
                  ) : (
                    <span className={`layer-name${o.locked ? ' locked' : ''}`} title="Double-click to rename">
                      {o.groupId ? '▸ ' : ''}{o.name}{o.locked ? ' · locked' : ''}
                    </span>
                  )}
                  <span className="layer-actions">
                    <button className="icon" title="Bring to front (Ctrl+])"
                      onClick={(e) => { e.stopPropagation(); reorderLayer(o.id, 0, 'front') }}> cop</button>
                    <button className="icon" title="Raise (])"
                      onClick={(e) => { e.stopPropagation(); moveLayer(o.id, 1) }}>↑</button>
                    <button className="icon" title="Lower ([)"
                      onClick={(e) => { e.stopPropagation(); moveLayer(o.id, -1) }}>↓</button>
                    <button className="icon" title="Send to back (Ctrl+[)"
                      onClick={(e) => { e.stopPropagation(); reorderLayer(o.id, 0, 'back') }}>⤓</button>
                    <button className="icon" title="Delete" disabled={!!o.locked}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (o.locked) return
                        record()
                        setObjects((objs) => objs.filter((x) => x.id !== o.id))
                        setSelIds((ids) => ids.filter((x) => x !== o.id))
                      }}>×</button>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </aside>

        <main className="stage-wrap" ref={wrapRef}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
          onDrop={onStageDrop}>
          {objects.length === 0 && (
            <div className="empty-hint">
              <div>
                <b>Drop an SVG</b> or paste with <b>Ctrl+V</b><br />
                Draw with <b>R</b> · <b>O</b> · <b>L</b> · <b>P</b> · <b>N</b> · <b>S</b>
              </div>
            </div>
          )}
          <svg
            ref={boardRef}
            className="board"
            xmlns="http://www.w3.org/2000/svg"
            viewBox={`${cam.x} ${cam.y} ${vw} ${vh}`}
            style={{ cursor }}
            onPointerDown={onBoardPointerDown}
            onPointerMove={onBoardPointerMove}
            onPointerUp={onBoardPointerUp}
            onDoubleClick={onBoardDoubleClick}
          >
            <defs data-ui="1">
              <pattern id="gridpat" width={cell} height={cell} patternUnits="userSpaceOnUse">
                <path d={`M ${cell} 0 H 0 V ${cell}`} fill="none" stroke={gridStroke}
                  strokeWidth={Math.min(1 / cam.z, cell / 8)} />
              </pattern>
            </defs>
            <defs>
              {rendered.map((r) => (
                <g key={r.obj.id} data-obj={r.obj.id}>
                  <g id={r.srcId}
                    transform={`translate(${r.pb.box.x - r.pb.src.x * r.pb.scale} ${r.pb.box.y - r.pb.src.y * r.pb.scale}) scale(${r.pb.scale})`}>
                    {renderItems(r.pb.src.items)}
                  </g>
                  {r.defsNodes}
                </g>
              ))}
            </defs>

            <rect data-ui="1" x={cam.x} y={cam.y} width={vw} height={vh} fill={bg} />
            {showGrid && (
              <rect data-ui="1" x={cam.x} y={cam.y} width={vw} height={vh} fill="url(#gridpat)" />
            )}

            {/* Rotation lives on an inner group so getBBox() on the outer
                data-final group still reports post-rotation bounds. */}
            {rendered.map((r) => (
              <g key={r.obj.id} data-obj={r.obj.id} data-final={r.obj.id} fill={fg}>
                <g transform={placeTransform(r.obj, r.pb.box)}>
                  <use href={`#${r.finalId}`} />
                </g>
              </g>
            ))}

            {draftNode}
            {penNode}

            {/* hit targets + selection (UI only, never exported) */}
            {(tool === 'select' || tool === 'pen') && !panning && !pen && rendered.map((r) => (
              <g key={`hit-${r.obj.id}`} data-ui="1" transform={placeTransform(r.obj, r.pb.box)}>
                <rect data-hit={r.obj.id}
                  x={r.pb.box.x} y={r.pb.box.y} width={r.pb.box.w} height={r.pb.box.h}
                  fill="transparent"
                  style={{ cursor: tool === 'select' ? 'move' : 'default' }}
                  onPointerDown={(e) => onObjectPointerDown(e, r.obj.id)} />
              </g>
            ))}
            {selIds.map((id) => {
              const pb = boxes[id]
              const o = objects.find((x) => x.id === id)
              if (!pb || !o) return null
              return (
                <g key={`sel-${id}`} data-ui="1" transform={placeTransform(o, pb.box)}>
                  <rect
                    x={pb.box.x} y={pb.box.y} width={pb.box.w} height={pb.box.h}
                    fill="none" stroke="#0D99FF" strokeWidth={hairline} pointerEvents="none" />
                </g>
              )
            })}

            {/* Move tool: resize corners/edges + rotate — no anchors */}
            {transformMode && selObj && selPb && (
              <g data-ui="1" transform={selRotT}>
                {rotCorners.map(({ c, x, y, ox, oy }) => (
                  <rect key={`rot-${c}`}
                    x={x + (ox > 0 ? 2 / cam.z : -rotZone - 2 / cam.z)}
                    y={y + (oy > 0 ? 2 / cam.z : -rotZone - 2 / cam.z)}
                    width={rotZone} height={rotZone}
                    fill="transparent"
                    style={{ cursor: ROTATE_CURSOR }}
                    onPointerDown={onRotatePointerDown} />
                ))}
                {[
                  { x: selPb.box.x, y: selPb.box.y - rotZone - 2 / cam.z, w: selPb.box.w, h: rotZone },
                  { x: selPb.box.x + selPb.box.w + 2 / cam.z, y: selPb.box.y, w: rotZone, h: selPb.box.h },
                  { x: selPb.box.x, y: selPb.box.y + selPb.box.h + 2 / cam.z, w: selPb.box.w, h: rotZone },
                  { x: selPb.box.x - rotZone - 2 / cam.z, y: selPb.box.y, w: rotZone, h: selPb.box.h },
                ].map((r, i) => (
                  <rect key={`rots-${i}`}
                    x={r.x} y={r.y} width={r.w} height={r.h}
                    fill="transparent"
                    style={{ cursor: ROTATE_CURSOR }}
                    onPointerDown={onRotatePointerDown} />
                ))}
                {corners.map(({ c, x, y, cur }) => (
                  <rect key={c}
                    x={x - handleSize / 2} y={y - handleSize / 2}
                    width={handleSize} height={handleSize}
                    fill="#ffffff" stroke="#0D99FF" strokeWidth={1 / cam.z}
                    style={{ cursor: cur }}
                    onPointerDown={(e) => onHandlePointerDown(e, c)} />
                ))}
              </g>
            )}

            {/* Pen tool: anchors + curve handles only — no resize */}
            {nodeEditMode && (
              <g data-ui="1" transform={selRotT}>
                {/* light path outline for node edit focus */}
                <rect
                  x={selPb.box.x} y={selPb.box.y} width={selPb.box.w} height={selPb.box.h}
                  fill="none" stroke="#0D99FF" strokeWidth={hairline}
                  strokeDasharray={`${4 / cam.z} ${3 / cam.z}`} pointerEvents="none" />
                {penAnchorInfo.map((a) => {
                  const on = activeAnchor && a.pi === activeAnchor.pi && a.i === activeAnchor.i
                  return (
                    <g key={`a-${a.pi}-${a.i}`}>
                      {/* show curve handles for every anchor that has them */}
                      {[['out', a.p.hox, a.p.hoy], ['in', a.p.hix, a.p.hiy]].map(([side, hx, hy]) => {
                        if (!hx && !hy) return null
                        const dim = !on
                        const tx = a.x + hx * cell
                        const ty = a.y + hy * cell
                        return (
                          <g key={side} opacity={dim ? 0.45 : 1}>
                            <line x1={a.x} y1={a.y} x2={tx} y2={ty}
                              stroke="#0D99FF" strokeWidth={1 / cam.z} pointerEvents="none" />
                            <circle cx={tx} cy={ty} r={3.5 / cam.z}
                              fill="#0D99FF" stroke="#ffffff" strokeWidth={1 / cam.z}
                              pointerEvents="none" />
                            <circle cx={tx} cy={ty} r={8 / cam.z}
                              fill="transparent"
                              style={{ cursor: 'move' }}
                              onPointerDown={(e) => onHandleDotPointerDown(e, a.pi, a.i, side)} />
                          </g>
                        )
                      })}
                      <rect data-anchor="1"
                        x={a.x - 3.5 / cam.z} y={a.y - 3.5 / cam.z}
                        width={7 / cam.z} height={7 / cam.z}
                        fill={on ? '#0D99FF' : '#ffffff'}
                        stroke="#0D99FF" strokeWidth={1 / cam.z}
                        pointerEvents="none" />
                      <rect data-anchor-hit={`${a.pi}:${a.i}`}
                        x={a.x - 9 / cam.z} y={a.y - 9 / cam.z}
                        width={18 / cam.z} height={18 / cam.z}
                        fill="transparent"
                        style={{ cursor: 'move' }}
                        onPointerDown={(e) => onAnchorPointerDown(e, a.pi, a.i)} />
                    </g>
                  )
                })}
              </g>
            )}

            {guides && guides.map((g, i) => (
              g.axis === 'v' ? (
                <line key={i} data-ui="1" x1={g.pos} y1={g.a} x2={g.pos} y2={g.b}
                  stroke={GUIDE} strokeWidth={1 / cam.z} pointerEvents="none" />
              ) : (
                <line key={i} data-ui="1" x1={g.a} y1={g.pos} x2={g.b} y2={g.pos}
                  stroke={GUIDE} strokeWidth={1 / cam.z} pointerEvents="none" />
              )
            ))}
            {gapHud && gapHud.map((g, i) => (
              g.kind === 'h' ? (
                <g key={`gap-${i}`} data-ui="1" pointerEvents="none">
                  <line x1={g.x1} y1={g.y} x2={g.x2} y2={g.y}
                    stroke={GUIDE} strokeWidth={1 / cam.z} />
                  <rect x={(g.x1 + g.x2) / 2 - 14 / cam.z} y={g.y - 8 / cam.z}
                    width={28 / cam.z} height={14 / cam.z} rx={2 / cam.z} fill="#F24822" />
                  <text x={(g.x1 + g.x2) / 2} y={g.y + 3.5 / cam.z}
                    textAnchor="middle" fill="#fff" fontSize={10 / cam.z}
                    fontFamily="ui-monospace, monospace">{g.text}</text>
                </g>
              ) : (
                <g key={`gap-${i}`} data-ui="1" pointerEvents="none">
                  <line x1={g.x} y1={g.y1} x2={g.x} y2={g.y2}
                    stroke={GUIDE} strokeWidth={1 / cam.z} />
                  <rect x={g.x - 14 / cam.z} y={(g.y1 + g.y2) / 2 - 7 / cam.z}
                    width={28 / cam.z} height={14 / cam.z} rx={2 / cam.z} fill="#F24822" />
                  <text x={g.x} y={(g.y1 + g.y2) / 2 + 3.5 / cam.z}
                    textAnchor="middle" fill="#fff" fontSize={10 / cam.z}
                    fontFamily="ui-monospace, monospace">{g.text}</text>
                </g>
              )
            ))}
            {dragHud && (
              <g data-ui="1" pointerEvents="none">
                <rect x={dragHud.x - 28 / cam.z} y={dragHud.y - 8 / cam.z}
                  width={56 / cam.z} height={16 / cam.z} rx={3 / cam.z}
                  fill="#0a0a0a" stroke="#0D99FF" strokeWidth={1 / cam.z} />
                <text x={dragHud.x} y={dragHud.y + 4 / cam.z}
                  textAnchor="middle" fill="#fff" fontSize={10 / cam.z}
                  fontFamily="ui-monospace, monospace">{dragHud.text}</text>
              </g>
            )}
            {marquee && (
              <rect data-ui="1"
                x={marquee.x} y={marquee.y} width={marquee.w} height={marquee.h}
                fill="#0D99FF14" stroke="#0D99FF" strokeWidth={1 / cam.z}
                pointerEvents="none" />
            )}
          </svg>

          <footer className="readout">
            <span>{objects.length} layer{objects.length === 1 ? '' : 's'}</span>
            <span>cell {cell}px</span>
            <span>{nodeEditMode ? 'Node edit' : transformMode ? 'Move' : toolLabel}</span>
            <span>
              {selIds.length === 0 ? 'no selection'
                : selIds.length === 1 ? (selObj?.name || '1 selected')
                : `${selIds.length} selected`}
            </span>
          </footer>
        </main>

        <aside className="panel right">
          {selIds.length === 0 && (
            <>
              <section>
                <h2>Background</h2>
                <div className="seg">
                  <button className={!bgWhite ? 'seg-btn on' : 'seg-btn'} onClick={() => setBgWhite(false)}>
                    Dark
                  </button>
                  <button className={bgWhite ? 'seg-btn on' : 'seg-btn'} onClick={() => setBgWhite(true)}>
                    White
                  </button>
                </div>
              </section>
              <section>
                <h2>Grid</h2>
                <label className="ctl">
                  <span className="ctl-head"><span>Grid cell</span></span>
                  <select value={gridCell} onChange={(e) => setGridCell(Number(e.target.value))}>
                    {[8, 16, 24, 32, 48, 64, 80, 96].map((v) => (
                      <option key={v} value={v}>{v} px</option>
                    ))}
                  </select>
                </label>
                <label className="ctl row">
                  <input type="checkbox" checked={showGrid} onChange={(e) => setShowGrid(e.target.checked)} />
                  <span>Show grid (not exported)</span>
                </label>
              </section>
              <section>
                <h2>Board</h2>
                <div className="btnrow" style={{ marginBottom: 6 }}>
                  <button className="btn sm" onClick={exportLogolab}>Export .logolab</button>
                  <label className="btn sm" style={{ cursor: 'pointer' }}>
                    Import
                    <input type="file" accept=".logolab,application/json" hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0]
                        if (f) importLogolabFile(f)
                        e.target.value = ''
                      }} />
                  </label>
                </div>
                <div className="btnrow" style={{ marginBottom: 6 }}>
                  <button className="btn sm" onClick={saveSnapshot}>Save snapshot</button>
                  <button className="btn sm" onClick={() => setShowKeys(true)}>Shortcuts (?)</button>
                </div>
                {snaps.length > 0 && (
                  <div className="snaps">
                    {snaps.map((snap) => (
                      <div key={snap.id} className="snap-row">
                        <button className="snap-load" onClick={() => restoreSnapshot(snap.id)}>
                          {snap.name}
                          <span className="snap-at">{new Date(snap.at).toLocaleString()}</span>
                        </button>
                        <button className="icon" title="Delete snapshot"
                          onClick={() => deleteSnapshot(snap.id)}>×</button>
                      </div>
                    ))}
                  </div>
                )}
                <button className="btn sm" onClick={clearBoard} style={{ marginTop: 8 }}>Clear board</button>
                <p className="hint">Autosaves in this browser. Snapshots keep up to 12 versions.</p>
              </section>
              <section>
                <p className="hint">
                  <b>V Move</b> — resize, rotate, move (no points)<br />
                  <b>P Pen</b> — draw or edit anchors (no resize)<br />
                  Double-click a shape to edit points<br />
                  Ctrl+G group · Ctrl+Shift+G ungroup · ? shortcuts
                </p>
              </section>
            </>
          )}

          {selIds.length > 1 && (
            <>
              <section>
                <h2>{selIds.length} selected</h2>
                <div className="btnrow">
                  <button className="tool" title="Align left" onClick={() => alignSel('left')}><IcAlignL /></button>
                  <button className="tool" title="Align horizontal centers" onClick={() => alignSel('cx')}><IcAlignCX /></button>
                  <button className="tool" title="Align right" onClick={() => alignSel('right')}><IcAlignR /></button>
                  <button className="tool" title="Align top" onClick={() => alignSel('top')}><IcAlignT /></button>
                  <button className="tool" title="Align vertical centers" onClick={() => alignSel('cy')}><IcAlignCY /></button>
                  <button className="tool" title="Align bottom" onClick={() => alignSel('bottom')}><IcAlignB /></button>
                </div>
                <div className="btnrow" style={{ marginTop: 6 }}>
                  <button className="tool" title="Distribute horizontal" onClick={() => distributeSel('h')}><IcDistH /></button>
                  <button className="tool" title="Distribute vertical" onClick={() => distributeSel('v')}><IcDistV /></button>
                  <button className="tool" title="Flip horizontal (Ctrl+Shift+H)" onClick={() => flipSel('h')}><IcFlipH /></button>
                  <button className="tool" title="Flip vertical (Ctrl+Shift+V)" onClick={() => flipSel('v')}><IcFlipV /></button>
                </div>
                <div className="btnrow" style={{ marginTop: 6 }}>
                  <button className="btn sm" onClick={duplicateSel}>Duplicate</button>
                  <button className="btn sm" onClick={groupSel} title="Ctrl+G">Group</button>
                  <button className="btn sm" onClick={ungroupSel} title="Ctrl+Shift+G">Ungroup</button>
                  <button className="btn sm" onClick={toggleLockSel}>
                    {selIds.every((id) => objects.find((o) => o.id === id)?.locked) ? 'Unlock' : 'Lock'}
                  </button>
                </div>
              </section>
              <section>
                <h2>Shape builder</h2>
                <div className="btnrow">
                  <button className="tool" disabled={!canBoolean} title="Union" onClick={() => booleanSel('union')}><IcUnion /></button>
                  <button className="tool" disabled={!canBoolean} title="Subtract (bottom minus above)" onClick={() => booleanSel('subtract')}><IcSubtract /></button>
                  <button className="tool" disabled={!canBoolean} title="Intersect" onClick={() => booleanSel('intersect')}><IcIntersect /></button>
                  <button className="tool" disabled={!canBoolean} title="Exclude" onClick={() => booleanSel('exclude')}><IcExclude /></button>
                </div>
                <p className="hint">
                  {canBoolean
                    ? 'Combines the selected shapes into one. Curves are flattened to fine polygons.'
                    : 'Boolean ops need editable shapes — use “Convert to editable paths” on pasted logos first.'}
                </p>
              </section>
            </>
          )}

          {selObj && (
            <>
              <section>
                <h2>Properties</h2>
                <div className="props">
                  <NumField label="X" value={selObj.x}
                    disabled={!!selObj.locked}
                    onCommit={(v) => patchObj(selId, { x: r4(v) }, `px:${selId}`)} />
                  <NumField label="Y" value={selObj.y}
                    disabled={!!selObj.locked}
                    onCommit={(v) => patchObj(selId, { y: r4(v) }, `py:${selId}`)} />
                  <NumField label="W" value={selPb ? selPb.box.w / cell : 0}
                    disabled={!resizable || !!selObj.locked}
                    onCommit={(v) => commitSize('w', v)} />
                  <NumField label="H" value={selPb ? selPb.box.h / cell : 0}
                    disabled={!resizable || !!selObj.locked}
                    onCommit={(v) => commitSize('h', v)} />
                  <NumField label="∠°" value={selObj.rot || 0} step={1}
                    disabled={!!selObj.locked}
                    onCommit={(v) => patchObj(selId, { rot: normDeg(v) }, `rot:${selId}`)} />
                </div>
                {selGridLocked && (
                  <p className="hint">
                    Grid detected — {selPb.src.grid.cols}×{selPb.src.grid.rows} units,
                    size locked to the canvas grid.
                  </p>
                )}
                {!selObj.shape && !selGridLocked && (
                  <Slider def={{ label: 'Size (cells)', min: 2, max: 40, step: 1 }}
                    value={selObj.sizeCells}
                    onChange={(v) => patchObj(selId, { sizeCells: v }, `size:${selId}`)} />
                )}
                <div className="btnrow" style={{ marginTop: 8 }}>
                  <button className="tool" title="Flip horizontal (Ctrl+Shift+H)" disabled={!!selObj.locked}
                    onClick={() => flipSel('h')}><IcFlipH /></button>
                  <button className="tool" title="Flip vertical (Ctrl+Shift+V)" disabled={!!selObj.locked}
                    onClick={() => flipSel('v')}><IcFlipV /></button>
                  <button className="btn sm" onClick={duplicateSel}>Duplicate</button>
                  <button className="btn sm" onClick={() => toggleLock(selId)}>
                    {selObj.locked ? 'Unlock' : 'Lock'}
                  </button>
                </div>
                {selObj.locked && (
                  <p className="hint">Layer locked — select and unlock to edit.</p>
                )}
              </section>

              {selObj.shape ? (
                <section>
                  <h2>Shape</h2>
                  <label className="ctl row">
                    <span>{selObj.outlined ? 'Stroke' : 'Fill'}</span>
                    <input
                      type="color"
                      value={selObj.fill || fg}
                      onChange={(e) => patchObj(selId, { fill: e.target.value }, `fill:${selId}`)} />
                    <code>{(selObj.fill || fg).toUpperCase()}</code>
                    <button className="icon" title="Swap fill / stroke (Shift+X)"
                      onClick={swapSelFillStroke}>⇄</button>
                  </label>
                  {selObj.outlined && (
                    <Slider def={{ label: 'Stroke width (cells)', min: 0.125, max: 4, step: 0.125 }}
                      value={selObj.strokeWidth || 1}
                      onChange={(v) => patchObj(selId, { strokeWidth: v }, `sw:${selId}`)} />
                  )}
                  {selObj.shape.type === 'rect' && (
                    <Slider
                      def={{ label: 'Corner radius (cells)', min: 0, max: Math.max(Math.min(selObj.w, selObj.h) / 2, 0.25), step: 0.25 }}
                      value={selObj.shape.radius}
                      onChange={(v) => patchShape(selId, { radius: v }, `rad:${selId}`)} />
                  )}
                  {selObj.shape.type === 'poly' && (
                    <>
                      <Slider def={{ label: 'Sides', min: 3, max: 12, step: 1 }}
                        value={selObj.shape.sides}
                        onChange={(v) => patchShape(selId, { sides: v }, `sides:${selId}`)} />
                      <Slider def={{ label: 'Corner radius (cells)', min: 0, max: Math.max(Math.min(selObj.w, selObj.h) / 4, 0.25), step: 0.25 }}
                        value={selObj.shape.round || 0}
                        onChange={(v) => patchShape(selId, { round: v }, `round:${selId}`)} />
                    </>
                  )}
                  {selObj.shape.type === 'star' && (
                    <>
                      <Slider def={{ label: 'Points', min: 3, max: 12, step: 1 }}
                        value={selObj.shape.points}
                        onChange={(v) => patchShape(selId, { points: v }, `pts:${selId}`)} />
                      <Slider def={{ label: 'Inner radius', min: 0.1, max: 0.9, step: 0.05 }}
                        value={selObj.shape.inner}
                        onChange={(v) => patchShape(selId, { inner: v }, `inner:${selId}`)} />
                      <Slider def={{ label: 'Corner radius (cells)', min: 0, max: Math.max(Math.min(selObj.w, selObj.h) / 4, 0.25), step: 0.25 }}
                        value={selObj.shape.round || 0}
                        onChange={(v) => patchShape(selId, { round: v }, `round:${selId}`)} />
                    </>
                  )}
                  {selObj.shape.type === 'line' && (
                    <Slider def={{ label: 'Thickness (cells)', min: 0.125, max: 3, step: 0.125 }}
                      value={selObj.shape.t}
                      onChange={(v) => patchShape(selId, { t: v }, `t:${selId}`)} />
                  )}
                  {selObj.shape.type === 'pen' && (
                    <>
                      <Slider def={{ label: 'Corner radius (cells)', min: 0, max: 4, step: 0.25 }}
                        value={selObj.shape.round || 0}
                        onChange={(v) => setPenRound(selObj, v)} />
                      {(selObj.shape.round || 0) > 0 && (
                        <>
                          <button className="btn sm" onClick={() => convertShapeToPen(selObj)}>
                            Bake rounding into points
                          </button>
                          <p className="hint">
                            Turns each rounded corner into a real anchor pair with
                            curve handles you can edit.
                          </p>
                        </>
                      )}
                      {penPaths(selObj.shape).length === 1 && (
                        <label className="ctl row">
                          <input type="checkbox" checked={!!penPaths(selObj.shape)[0].closed}
                            onChange={(e) => {
                              const paths = penPaths(selObj.shape)
                              patchShape(selId, {
                                pts: undefined, closed: undefined,
                                paths: [{ ...paths[0], closed: e.target.checked }],
                              })
                            }} />
                          <span>Closed path</span>
                        </label>
                      )}
                      {tool !== 'pen' && (
                        <button className="btn sm" onClick={() => { setPen(null); setTool('pen') }}>
                          Edit points (Pen tool)
                        </button>
                      )}
                      <p className="hint">
                        {penPaths(selObj.shape).reduce((n, sp) => n + sp.pts.length, 0)} anchors
                        {penPaths(selObj.shape).length > 1 ? ` · ${penPaths(selObj.shape).length} subpaths` : ''}
                        <br />
                        {tool === 'pen'
                          ? <>Node edit mode — resize is on Move (V).<br />
                            Drag anchors · double-click corner↔smooth<br />
                            Double-click outline to add · Delete removes<br />
                            Alt+drag handle breaks symmetry · Esc → Move</>
                          : <>Switch to <b>Pen (P)</b> or double-click to edit points.<br />
                            Move (V) keeps resize handles without anchors.</>}
                      </p>
                    </>
                  )}
                  {selObj.shape.type === 'raw' && (
                    <p className="hint">Flattened boolean result.</p>
                  )}
                  {selObj.shape.type !== 'pen' && (
                    <>
                      <button className="btn sm" onClick={() => convertShapeToPen(selObj)}>
                        Edit points
                      </button>
                      <p className="hint">
                        Converts to a pen path and switches to the Pen tool.
                        Move (V) is for resize only — no point editing.
                      </p>
                    </>
                  )}
                </section>
              ) : (
                <section>
                  <h2>Logo</h2>
                  <button className="btn sm" onClick={() => convertToPaths(selObj)}>
                    Convert to editable paths
                  </button>
                  <p className="hint">
                    Splits the pasted SVG into pen paths with editable anchors and
                    curve handles. Original colors are kept; effects are removed.
                  </p>
                </section>
              )}

              <section>
                <h2>Effects</h2>
                {selObj.effects.length === 0 && (
                  <p className="hint">No effects — the layer renders pure. Add one below; effects stack top to bottom.</p>
                )}
                {selObj.effects.map((fx, k) => {
                  const def = EFFECTS[fx.type]
                  if (!def) return null
                  return (
                    <div className="fx" key={fx.id}>
                      <div className="fx-head">
                        <span className="fx-title">{def.label}</span>
                        <span className="fx-actions">
                          {def.seeded && (
                            <button className="icon" title="Reroll seed"
                              onClick={() => {
                                record()
                                patchObjEffects(selId, (fxs) =>
                                  fxs.map((f) => (f.id === fx.id ? { ...f, seed: newSeed() } : f)))
                              }}>
                              ⟳
                            </button>
                          )}
                          <button className="icon" title="Move up" disabled={k === 0}
                            onClick={() => moveFx(selId, k, -1)}>↑</button>
                          <button className="icon" title="Move down" disabled={k === selObj.effects.length - 1}
                            onClick={() => moveFx(selId, k, 1)}>↓</button>
                          <button className="icon" title="Remove"
                            onClick={() => {
                              record()
                              patchObjEffects(selId, (fxs) => fxs.filter((f) => f.id !== fx.id))
                            }}>
                            ×
                          </button>
                        </span>
                      </div>
                      <FxParams def={def} params={fx.params}
                        onParam={(key, val) => setFxParam(selId, fx.id, key, val)} />
                    </div>
                  )
                })}
                <select className="add-fx" value=""
                  onChange={(e) => { if (e.target.value) addEffect(selId, e.target.value) }}>
                  <option value="">+ Add effect…</option>
                  {Object.entries(EFFECTS).map(([key, def]) => (
                    <option key={key} value={key}>{def.label}</option>
                  ))}
                </select>
              </section>
            </>
          )}
        </aside>
      </div>

      {toast && <div className="toast" role="status">{toast}</div>}

      {showKeys && (
        <div className="keys-overlay" onClick={() => setShowKeys(false)} role="dialog">
          <div className="keys-panel" onClick={(e) => e.stopPropagation()}>
            <div className="keys-head">
              <h2>Shortcuts</h2>
              <button className="icon" onClick={() => setShowKeys(false)}>×</button>
            </div>
            <div className="keys-grid">
              <div><kbd>V</kbd> Move — resize, rotate, pan selection</div>
              <div><kbd>P</kbd> Pen — draw paths / edit anchors</div>
              <div><kbd>R</kbd> <kbd>O</kbd> <kbd>L</kbd> <kbd>N</kbd> <kbd>S</kbd> Shapes</div>
              <div><kbd>H</kbd> / <kbd>Space</kbd> Hand pan</div>
              <div><kbd>Ctrl</kbd>+<kbd>G</kbd> Group · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> Ungroup</div>
              <div><kbd>Ctrl</kbd>+<kbd>D</kbd> Duplicate · <kbd>Ctrl</kbd>+<kbd>F</kbd> Paste in front</div>
              <div><kbd>Ctrl</kbd>+<kbd>L</kbd> Lock · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>/<kbd>V</kbd> Flip</div>
              <div><kbd>]</kbd> <kbd>[</kbd> Layer order · <kbd>Ctrl</kbd>+<kbd>]</kbd>/<kbd>[</kbd> Front/back</div>
              <div><kbd>Shift</kbd>+drag constrain · <kbd>Alt</kbd> free snap / break handle</div>
              <div>Double-click shape → edit points (Pen)</div>
              <div><kbd>Esc</kbd> cancel / leave node edit → Move</div>
              <div>Drop <kbd>.svg</kbd> or import <kbd>.logolab</kbd> board file</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
