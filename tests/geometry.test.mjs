// Geometry + boolean smoke tests (no framework — plain node assert).
// Run: npm test
import assert from 'node:assert'
import polygonClipping from 'polygon-clipping'
import {
  shapeSource, shapePolys, penPaths, penBBox, penD, scaleShape, polysBBox, polysToPath,
  toPen, nearestOnPen, insertAnchor, removeAnchor,
} from '../src/shapes.js'

// rect
let s = shapeSource({ type: 'rect', radius: 0 }, 4, 3)
assert.equal(s.w, 4)
assert.equal(s.h, 3)
assert.match(s.d, /^M 0 0 H 4 V 3 H 0 Z$/)

// rounded rect radius clamps to half the short side
s = shapeSource({ type: 'rect', radius: 99 }, 4, 2)
assert.ok(s.d.includes('A 1 1'))

// ellipse bbox
s = shapeSource({ type: 'ellipse' }, 6, 4)
assert.equal(s.w, 6)

// polygon / star vertex counts (rings are closed: first point repeated at the end)
const pring = shapePolys({ type: 'poly', sides: 5 }, 4, 4)[0][0]
assert.equal(pring.length, 6)
assert.deepEqual(pring[0], pring[pring.length - 1])
const sring = shapePolys({ type: 'star', points: 5, inner: 0.4 }, 4, 4)[0][0]
assert.equal(sring.length, 11)

// line bbox includes thickness
s = shapeSource({ type: 'line', pts: [[0, 0], [4, 0]], t: 1 }, 0, 0)
assert.ok(Math.abs(s.y - -0.5) < 1e-9 && Math.abs(s.h - 1) < 1e-9, `line bbox ${s.y} ${s.h}`)

// pen: straight closed triangle
const pts = [
  { x: 0, y: 0, hx: 0, hy: 0 },
  { x: 4, y: 0, hx: 0, hy: 0 },
  { x: 4, y: 3, hx: 0, hy: 0 },
]
// penPaths normalizes the legacy { pts, closed } form (symmetric hx/hy handles)
const tri = penPaths({ type: 'pen', pts, closed: true })
let bb = penBBox(tri)
assert.deepEqual([bb.x, bb.y, bb.w, bb.h], [0, 0, 4, 3])
assert.equal(penD(tri), 'M 0 0 L 4 0 L 4 3 L 0 0 Z')

// pen: curve bulge extends bbox beyond the anchor hull (exact cubic extrema)
const cpts = [{ x: 0, y: 0, hx: 0, hy: -2 }, { x: 4, y: 0, hx: 0, hy: 2 }]
bb = penBBox(penPaths({ type: 'pen', pts: cpts, closed: false }))
assert.ok(bb.y < -0.5, `curve bulge captured, y=${bb.y}`)

// scaleShape scales the pen bbox exactly, anchored at the bbox origin
const sc = scaleShape({ type: 'pen', pts: cpts, closed: false }, bb.x, bb.y, 2, 2)
const bb2 = penBBox(penPaths(sc))
assert.ok(Math.abs(bb2.w - bb.w * 2) < 1e-6 && Math.abs(bb2.h - bb.h * 2) < 1e-6)
assert.ok(Math.abs(bb2.x - bb.x) < 1e-6)

// boolean: overlapping rects union → one polygon with merged bbox
const a = shapePolys({ type: 'rect', radius: 0 }, 4, 4)
const b = a.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + 2, y])))
const u = polygonClipping.union(a, b)
assert.equal(u.length, 1)
assert.deepEqual(Object.values(polysBBox(u)), [0, 0, 6, 4])

// subtract circle from square → single polygon with a hole ring
const sq = shapePolys({ type: 'rect', radius: 0 }, 6, 6)
const ci = shapePolys({ type: 'ellipse' }, 2, 2).map((poly) =>
  poly.map((ring) => ring.map(([x, y]) => [x + 2, y + 2])))
const diff = polygonClipping.difference(sq, ci)
assert.equal(diff.length, 1)
assert.equal(diff[0].length, 2)
assert.equal(polysToPath(diff).split('M').length - 1, 2)

// toPen: rect → 4-anchor closed pen path with the same bbox
let tp = toPen({ type: 'rect', radius: 0 }, 4, 3)
assert.equal(tp.type, 'pen')
assert.ok(tp.paths[0].closed)
assert.equal(tp.paths[0].pts.length, 4)
let tbb = penBBox(penPaths(tp))
assert.deepEqual([tbb.x, tbb.y, tbb.w, tbb.h], [0, 0, 4, 3])

// toPen: rounding bakes each corner into an anchor pair with curve handles
tp = toPen({ type: 'rect', radius: 1 }, 4, 4)
assert.equal(tp.paths[0].pts.length, 8)
assert.ok(tp.paths[0].pts.every((q) => q.hox || q.hoy || q.hix || q.hiy))

// toPen: ellipse → 4 kappa anchors, bbox preserved, everything on the grid
tp = toPen({ type: 'ellipse' }, 6, 4)
assert.equal(tp.paths[0].pts.length, 4)
tbb = penBBox(penPaths(tp))
assert.ok([tbb.x, tbb.y, tbb.w - 6, tbb.h - 4].every((v) => Math.abs(v) < 1e-3))
// anchors on the half-cell grid, handles on the quarter-cell grid
const onGrid = (v, g) => Math.abs(v / g - Math.round(v / g)) < 1e-9
assert.ok(tp.paths[0].pts.every((q) =>
  onGrid(q.x, 0.5) && onGrid(q.y, 0.5) &&
  [q.hox, q.hoy, q.hix, q.hiy].every((h) => onGrid(h, 0.25))))

// toPen: rounded rect handles snap to the quarter grid (axis-aligned edges)
tp = toPen({ type: 'rect', radius: 1 }, 6, 6)
assert.ok(tp.paths[0].pts.every((q) =>
  [q.hox, q.hoy, q.hix, q.hiy].every((h) => onGrid(h, 0.25))))

// toPen: rounded pentagon → 10 anchors
tp = toPen({ type: 'poly', sides: 5, round: 0.5 }, 4, 4)
assert.equal(tp.paths[0].pts.length, 10)

// toPen: raw multipolygon → one closed subpath per ring (hole kept)
tp = toPen({ type: 'raw', polys: diff }, 6, 6)
assert.equal(tp.paths.length, 2)
assert.ok(tp.paths.every((sp) => sp.closed))

// nearestOnPen: point above the top edge of a square projects onto it
const sqPen = penPaths(toPen({ type: 'rect', radius: 0 }, 4, 4))
let hit = nearestOnPen(sqPen, 2, -0.2)
assert.equal(hit.pi, 0)
assert.equal(hit.si, 0)
assert.ok(Math.abs(hit.t - 0.5) < 1e-6 && Math.abs(hit.dist - 0.2) < 1e-6)

// insertAnchor on a straight segment adds a corner anchor at t
let ins = insertAnchor(sqPen, 0, 0, 0.5)
assert.equal(ins[0].pts.length, 5)
assert.deepEqual([ins[0].pts[1].x, ins[0].pts[1].y], [2, 0])
assert.ok(!ins[0].pts[1].hox && !ins[0].pts[1].hix)

// insertAnchor splits a curve without changing the outline (bbox preserved)
const circle = penPaths(toPen({ type: 'ellipse' }, 4, 4))
const bbc = penBBox(circle)
ins = insertAnchor(circle, 0, 0, 0.5)
assert.equal(ins[0].pts.length, 5)
const bbc2 = penBBox(ins)
assert.ok(
  ['x', 'y', 'w', 'h'].every((k) => Math.abs(bbc2[k] - bbc[k]) < 1e-2),
  `curve split preserves bbox: ${JSON.stringify(bbc2)}`,
)

// removeAnchor drops the point; degenerate subpaths vanish
assert.equal(removeAnchor(sqPen, 0, 1)[0].pts.length, 3)
assert.equal(removeAnchor([{ closed: false, pts: sqPen[0].pts.slice(0, 2) }], 0, 0).length, 0)

// intersection of disjoint shapes is empty
const far = a.map((poly) => poly.map((ring) => ring.map(([x, y]) => [x + 100, y])))
assert.equal(polygonClipping.intersection(a, far).length, 0)

console.log('geometry: all tests pass')
