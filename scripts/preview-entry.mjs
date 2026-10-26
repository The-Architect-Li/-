/**
 * Render one page of a real book, so it can be looked at.
 *
 * `npm run preview` draws the panel with made-up numbers; this one loads the
 * real store and asks the real `buildEntry` for the real page, so what you see
 * is what the panel will draw for that chapter, card, character or place.
 *
 * Usage: `node scripts/preview-entry.mjs <book-dir> <kind> <key>`
 * e.g. `node scripts/preview-entry.mjs "C:/Users/me/小说/某书" chapter 5`
 * Writes `preview/entry-<kind>-<key>.html`; the screenshot is made by Edge, not
 * here.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ProjectStore } from '../lib/domain/store.js'
import { buildEntry } from '../lib/panel/entry.js'

const book = process.argv[2]
const kind = process.argv[3] ?? 'chapter'
const key = process.argv[4] ?? '1'
if (book === undefined) {
  console.error('usage: node scripts/preview-entry.mjs <book-dir> <kind> <key>')
  process.exit(1)
}
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

const store = new ProjectStore(book)
const snapshot = await store.snapshot()
const number = Number(key)
const prose = kind === 'chapter' || kind === 'card' ? (await store.chapter(number))?.text : undefined
const rounds = kind === 'chapter' || kind === 'card' ? await store.draftsOf(number) : []
const page = buildEntry(snapshot, kind, key, [{ number, rounds }], store.root, prose)
if (page === undefined) throw new Error(`no ${kind} page for ${key}`)

const chip = page.chip ? `<span ${attr(S.pill)}>${escape(page.chip)}</span>` : ''
const head = `<div ${attr(S.head)}>
  <button ${attr(S.iconButton)} class="iw-btn">返回</button>
  <span ${attr(S.bookTitle)}>${escape(page.breadcrumb.at(-1) ?? page.title)}</span>
  <span style="flex:1"></span>
  <button ${attr(S.iconButton)} class="iw-btn">编辑</button>
</div>`
const crumb = `<div ${attr(S.crumb)}>${page.breadcrumb
  .map((part, index) => (index === 0 ? `<span>${escape(part)}</span>` : `<span style="opacity:.6">›</span><span>${escape(part)}</span>`))
  .join('')}</div>`
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
// The prose, drawn the way the panel draws it: one paragraph per line, indented.
const proseBlock = (() => {
  const text = page.edit.body?.value ?? ''
  if (text.trim() === '') return ''
  const paragraphs = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '')
  return `<div ${attr(S.entryListHead)}>${escape(page.edit.body?.label ?? '正文')}</div>${paragraphs
    .map((line) => `<div ${attr(S.proseLine)}>${escape(line)}</div>`)
    .join('')}`
})()

const body = `<div ${attr(S.root)}>
  ${head}${crumb}${heading}
  ${fields}${lists}${proseBlock}
  <div ${attr(S.spacerBlock)}></div>
  <div ${attr(S.footer)}>${escape(page.root)}</div>
</div>`

const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>${escape(kind)} ${escape(page.title)}</title>
<style>
  html, body { margin: 0; background: Canvas; }
  ${CSS}
  .pane { width: 360px; margin: 0; }
  .iw-backdrop { position: static; }
</style></head>
<body><div class="pane">${body}</div></body></html>`

mkdirSync(out, { recursive: true })
const file = new URL(`../preview/entry-${kind}-${encodeURIComponent(String(key))}.html`, import.meta.url)
writeFileSync(file, html)
console.log(`${kind} ${key}: fields ${page.fields.length}, lists ${page.lists.length}, inputs ${page.edit.inputs.length}, prose ${(page.edit.body?.value ?? '').length} chars`)
console.log(`wrote ${file.pathname}`)
