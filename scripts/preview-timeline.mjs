/**
 * Render the time rail of a real book, so it can be looked at.
 *
 * `npm run preview` draws the panel with made-up numbers: fine for judging type
 * and spacing, useless for judging whether a rail of eighty-five chapters is
 * readable. This one loads the real store, asks the real `buildEntry` for the
 * timeline page, and draws it with the real client component — the numbers in the
 * picture are the book's own.
 *
 * Usage: `node scripts/preview-timeline.mjs <book-dir>` (defaults to the demo book).
 * Writes `preview/timeline.html` and `preview/shot-timeline.png` is made by Edge,
 * not here.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ProjectStore } from '../lib/domain/store.js'
import { buildEntry } from '../lib/panel/entry.js'

const book = process.argv[2] ?? fileURLToPath(new URL('../.novel/', import.meta.url))
const out = fileURLToPath(new URL('../preview/', import.meta.url))
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

const CSS = source.match(/const CSS = `([\s\S]*?)`\n/)[1]

/**
 * Pull one object literal out of `client.js` by brace counting.
 *
 * @param text - the source.
 * @param marker - `const S = {`, the opening of the literal.
 * @returns the literal, braces included.
 */
function sliceObject(text, marker) {
  const start = text.indexOf(marker)
  if (start < 0) throw new Error(`not found: ${marker}`)
  let depth = 0
  for (let index = start + marker.length - 1; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1
    else if (text[index] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start + marker.length - 1, index + 1)
    }
  }
  throw new Error(`unbalanced: ${marker}`)
}

const S = new Function(`return ${sliceObject(source, 'const S = {')}`)()
const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const style = (...parts) =>
  parts
    .filter(Boolean)
    .flatMap((part) => Object.entries(part))
    .map(([key, value]) => `${kebab(key)}:${value}`)
    .join(';')
const attr = (declaration) => `style="${escape(typeof declaration === 'string' ? declaration : style(declaration))}"`

function h(type, props, ...children) {
  const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
  const merged = { ...(props || {}) }
  if (flat.length > 0) merged.children = flat.length === 1 ? flat[0] : flat
  return { type, props: merged }
}
const noop = () => {}
const React = {
  createElement: h,
  Fragment: 'fragment',
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
  useEffect: noop,
  useLayoutEffect: noop,
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
}

function render(node) {
  if (node === null || node === undefined || node === false) return ''
  if (Array.isArray(node)) return node.map(render).join('')
  if (typeof node === 'string' || typeof node === 'number') return escape(node)
  const { type, props } = node
  if (type === 'fragment') return render(props.children)
  if (typeof type === 'function') return render(type(props))
  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || value === undefined || value === null || value === false) continue
    if (key.startsWith('on') || key === 'key' || key === 'ref') continue
    if (key === 'style') attrs.push(attr(value))
    else if (key === 'className') attrs.push(`class="${escape(value)}"`)
    else attrs.push(`${key}="${escape(value)}"`)
  }
  return `<${type}${attrs.length > 0 ? ' ' + attrs.join(' ') : ''}>${render(props.children)}</${type}>`
}

let loaded
const shim = {
  load: (definition) => {
    const module = { exports: {} }
    loaded = definition.factory((id) => {
      if (id === 'react') return React
      throw new Error(`unknown module: ${id}`)
    }) || module.exports
  },
}
new Function('window', `${source}\n`)({ __ModuleLoader__: shim })

const store = new ProjectStore(book)
const snapshot = await store.snapshot()
const page = buildEntry(snapshot, 'timeline', 'clock', new Map(), book)
if (page === undefined) throw new Error('no timeline page for this book')

const chip = page.chip ? `<span ${attr(S.pill)}>${escape(page.chip)}</span>` : ''
const head = `<div ${attr(S.head)}>
  <button ${attr(S.iconButton)} class="iw-btn">返回</button>
  <span ${attr(S.bookTitle)}>${escape(page.title)}</span>
</div>`
const crumb = `<div ${attr(S.crumb)}><span>${escape(page.breadcrumb[0])}</span><span style="opacity:.6">›</span><span>${escape(page.breadcrumb[1])}</span></div>`
const heading = `<div style="padding:0 10px 6px">
  <div style="display:flex;align-items:baseline;gap:6px">
    <span style="font-size:15.5px;font-weight:600;letter-spacing:.01em">${escape(page.title)}</span>${chip}
  </div>
  <div ${attr({ ...S.aside, padding: '2px 0 0', maxWidth: '100%' })}>${escape(page.subtitle)}</div>
</div>`
const fields = page.fields
  .map((field) => `<div ${attr(S.entryBlock)}><div ${attr(S.entryLabel)}>${escape(field.label)}</div><div ${attr(S.entryValue)}>${escape(field.value)}</div></div>`)
  .join('')
const lists = page.lists
  .map((list) => `<div ${attr(S.entryListHead)}>${escape(list.label)}</div>${list.items.map((item) => `<div ${attr(S.entryItem)}>· ${escape(item)}</div>`).join('')}`)
  .join('')

const body = `<div ${attr(S.root)}>
  ${head}${crumb}${heading}
  ${render(h(loaded.tree.Spine, { spine: page.spine }))}
  ${fields}${lists}
  <div ${attr(S.spacerBlock)}></div>
  <div ${attr(S.footer)}>${escape(page.root)}</div>
</div>`

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>时间线 · ${escape(page.title)}</title>
<style>
  html, body { margin: 0; background: Canvas; }
  ${CSS}
  .pane { width: 360px; margin: 0; }
  .iw-backdrop { position: static; }
</style></head>
<body><div class="pane">${body}</div></body></html>`

mkdirSync(out, { recursive: true })
writeFileSync(new URL('../preview/timeline.html', import.meta.url), html)
console.log(`timeline: ${page.spine.points.length} points, ${page.spine.points.reduce((sum, point) => sum + point.events.length, 0)} events, ${page.spine.loose.length} undated`)
console.log(`wrote ${new URL('../preview/timeline.html', import.meta.url).pathname}`)
