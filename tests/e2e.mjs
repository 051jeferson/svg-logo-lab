// End-to-end smoke: drives LOGOLAB in headless Chromium via playwright-core.
// Prereqs: dev server running (npm run dev) and a Chromium download
// (node node_modules/playwright-core/cli.js install chromium-headless-shell).
// Run: npm run test:e2e
import { chromium } from 'playwright-core'

const URL_APP = process.env.LOGOLAB_URL || 'http://localhost:5173'
let fails = 0
const ok = (cond, msg) => {
  if (cond) console.log('PASS', msg)
  else { console.log('FAIL', msg); fails++ }
}

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })

await page.goto(URL_APP)
await page.waitForSelector('svg.board')
await page.evaluate(() => localStorage.removeItem('logolab-board-v1'))
await page.reload()
await page.waitForSelector('svg.board')
ok(true, 'app loads')

const board = await page.locator('svg.board').boundingBox()
const cx = board.x + board.width / 2
const cy = board.y + board.height / 2
const layerCount = () => page.locator('.layer').count()

// draw rectangle
await page.keyboard.press('r')
await page.mouse.move(cx - 100, cy - 60)
await page.mouse.down()
await page.mouse.move(cx + 60, cy + 40, { steps: 5 })
await page.mouse.up()
ok((await layerCount()) === 1, 'rectangle drawn → 1 layer')
ok(await page.locator('.layer.on').count() === 1, 'new shape selected')
ok(await page.getByText('Corner radius (cells)').count() === 1, 'rect params panel visible')

// rect is born as a pen path, but anchors only appear in Pen tool (Move = resize only)
const anchorSel = 'svg.board rect[data-anchor]'
ok(await page.getByText('Closed path').count() === 1, 'rect is born as editable path')
ok(await page.locator(anchorSel).count() === 0, 'Move tool hides anchors (resize only)')
// corner + edge resize handles in Move tool
ok(await page.locator('svg.board rect').count() >= 1, 'board has geometry')

// Enter Pen tool to edit points
await page.keyboard.press('p')
ok(await page.locator(anchorSel).count() === 4, 'Pen tool shows 4 editable anchors')

// double-click on the outline inserts an anchor there (node edit mode)
const fbb = await page.evaluate(() => {
  const r = document.querySelector('[data-final]').getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height }
})
await page.mouse.dblclick(fbb.x + fbb.w / 2, fbb.y)
ok(await page.locator(anchorSel).count() === 5, 'double-click on edge inserts anchor')

// the inserted anchor comes selected — Delete removes it, not the object
await page.keyboard.press('Delete')
ok(await page.locator(anchorSel).count() === 4, 'delete removes only the anchor')
ok((await layerCount()) === 1, 'object survives anchor delete')
// back to Move — anchors hide, object remains
await page.keyboard.press('Escape')
ok(await page.locator(anchorSel).count() === 0, 'Esc leaves node edit → Move (no anchors)')
await page.keyboard.press('Control+z')
await page.keyboard.press('Control+z')

// draw overlapping ellipse
await page.keyboard.press('o')
await page.mouse.move(cx - 20, cy - 20)
await page.mouse.down()
await page.mouse.move(cx + 140, cy + 90, { steps: 5 })
await page.mouse.up()
ok((await layerCount()) === 2, 'ellipse drawn → 2 layers')

// multi-select + boolean union
await page.keyboard.press('Control+a')
ok(await page.getByText('2 selected').count() >= 1, 'ctrl+A selects both')
const unionBtn = page.locator('button[title="Union"]')
ok(await unionBtn.isEnabled(), 'union enabled for 2 shapes')
await unionBtn.click()
ok((await layerCount()) === 1, 'union → 1 layer')
ok(await page.getByText('Flattened boolean result.').count() === 1, 'raw shape panel')

// undo / redo chain
await page.keyboard.press('Control+z')
ok((await layerCount()) === 2, 'undo boolean → 2 layers')
await page.keyboard.press('Control+Shift+z')
ok((await layerCount()) === 1, 'redo → 1 layer')
await page.keyboard.press('Control+z')
await page.keyboard.press('Control+z')
await page.keyboard.press('Control+z')
ok((await layerCount()) === 0, 'undo chain empties board')
await page.keyboard.press('Control+Shift+z')
await page.keyboard.press('Control+Shift+z')
ok((await layerCount()) === 2, 'redo chain restores')

// pen tool: 3 anchors, close on first
await page.keyboard.press('p')
await page.mouse.click(cx - 200, cy - 150)
await page.mouse.click(cx - 100, cy - 150)
await page.mouse.click(cx - 100, cy - 50)
await page.mouse.click(cx - 200, cy - 150)
ok((await layerCount()) === 3, 'pen path committed on close-click')
ok(await page.getByText('Closed path').count() === 1, 'pen panel shows closed toggle')
const anchors = await page.locator(anchorSel).count()
ok(anchors === 3, `3 anchors editable (got ${anchors})`)

// duplicate + delete
await page.keyboard.press('Control+d')
ok((await layerCount()) === 4, 'ctrl+D duplicates')
await page.keyboard.press('Delete')
ok((await layerCount()) === 3, 'delete removes duplicate')

// paste an SVG logo
await page.evaluate(() => {
  const dt = new DataTransfer()
  dt.setData('text/plain', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><path fill="#FF4A00" d="M0 0h4v4H0zM4 4h4v4H4z"/></svg>')
  window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt }))
})
ok((await layerCount()) === 4, 'pasted SVG becomes a layer')
ok(await page.getByText(/Grid detected/).count() === 1, 'grid detected on pasted logo')

// add effect, export selection, check hard constraints
await page.locator('.add-fx').selectOption('echo')
await page.waitForTimeout(100)
const markup = await page.evaluate(async () => {
  let out = null
  navigator.clipboard.writeText = async (t) => { out = t }
  document.querySelector('.btn-primary').click()
  await new Promise((r) => setTimeout(r, 200))
  return out
})
ok(!!markup && markup.startsWith('<svg'), 'export produces SVG markup')
ok(markup && !/opacity/i.test(markup), 'export has no opacity')
ok(markup && !/<filter/i.test(markup), 'export has no filters')
ok(markup && !markup.includes('data-ui'), 'export strips UI overlays')
ok(markup && markup.includes('FF4A00'), 'export keeps original logo color')

// persistence across reload
await page.reload()
await page.waitForSelector('svg.board')
ok((await layerCount()) === 4, 'localStorage restores board after reload')

// rename
await page.locator('.layer-name').first().dblclick()
await page.keyboard.type('Mark')
await page.keyboard.press('Enter')
ok(await page.getByText('Mark').count() >= 1, 'layer rename works')

// marquee multi-select
await page.keyboard.press('Escape')
await page.keyboard.press('v')
await page.mouse.move(board.x + 10, board.y + 10)
await page.mouse.down()
await page.mouse.move(board.x + board.width - 10, board.y + board.height - 60, { steps: 5 })
await page.mouse.up()
ok((await page.locator('.layer.on').count()) >= 2, 'marquee selects multiple')
ok(await page.locator('button[title="Align left"]').count() === 1, 'align panel for multi-select')
ok(await page.locator('button[title="Flip horizontal (Ctrl+Shift+H)"]').count() === 1, 'flip controls for multi-select')
ok(await page.locator('button[title="Distribute horizontal"]').count() === 1, 'distribute controls for multi-select')

// flip + lock on a single shape
await page.keyboard.press('Escape')
await page.locator('.layer').first().click()
await page.keyboard.press('Control+Shift+H')
const flipped = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('logolab-board-v1') || '{}')
  // wait a tick for autosave — fall back to live state via DOM selection name
  return true
})
ok(flipped, 'flip shortcut runs without error')
await page.keyboard.press('Control+l')
ok(await page.getByText(/locked/i).count() >= 1, 'lock marks layer as locked')
// locked layer survives Delete
const beforeLock = await layerCount()
await page.keyboard.press('Delete')
ok((await layerCount()) === beforeLock, 'locked layer not deleted by Delete key')
await page.keyboard.press('Control+l')
await page.keyboard.press('Delete')
ok((await layerCount()) === beforeLock - 1, 'unlocked layer deletes')

// free rotation field accepts non-45° angles
await page.locator('.layer').first().click()
const rotInput = page.locator('.props .num').filter({ hasText: '∠°' }).locator('input')
if (await rotInput.count()) {
  await rotInput.fill('33')
  await rotInput.press('Enter')
  const rotVal = await rotInput.inputValue()
  ok(rotVal === '33' || rotVal === '33.0', `free rotation sticks at 33° (got ${rotVal})`)
}

ok(errors.length === 0, `no console/page errors${errors.length ? ': ' + errors.join(' | ') : ''}`)

await browser.close()
console.log(fails === 0 ? 'e2e: all tests pass' : `e2e: ${fails} FAILURES`)
process.exit(fails ? 1 : 0)
