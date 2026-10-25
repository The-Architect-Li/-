/**
 * Design preview: render the panel's real components and real `S` values to
 * static HTML, so the look can be judged in a browser instead of imagined.
 *
 * The React stub is only enough for a first paint: state returns its initial
 * value and effects do not run (a preview has no host to fetch from). The
 * `Section`/`Row` renderers are the panel's own; the page shells below mirror
 * the component markup and take their numbers straight out of `S`.
 *
 * `npm run preview` writes `preview/*.html`; open them at about 360px wide (the
 * panel's real width) and screenshot from there. This is the only way to check
 * a stylesheet change without launching the app, and the shells below are the
 * one place where a preview may drift from the component: keep them in step.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const out = fileURLToPath(new URL('../preview/', import.meta.url))
mkdirSync(out, { recursive: true })

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

/** Slice a balanced object literal starting at `marker`. */
function sliceObject(text, marker) {
  const start = text.indexOf(marker)
  if (start < 0) throw new Error(`marker not found: ${marker}`)
  let index = text.indexOf('{', start)
  const open = index
  let depth = 0
  let quote = null
  for (; index < text.length; index += 1) {
    const char = text[index]
    if (quote) {
      if (char === '\\') index += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  throw new Error(`unbalanced object at ${marker}`)
}

const CSS = source.match(/const CSS = `([\s\S]*?)`\n/)[1]
const S = new Function(`return ${sliceObject(source, 'const S = {')}`)()

const kebab = (name) => name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const style = (...parts) =>
  Object.assign({}, ...parts.filter(Boolean))
const attr = (declaration) =>
  `style="${Object.entries(declaration)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${kebab(name)}:${value}`)
    .join(';')}"`

/* --- a React small enough to render once ---------------------------------- */

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

/* --- load the panel with that stub ---------------------------------------- */

let loaded
const shim = {
  load: (definition) => {
    const module = { exports: {} }
    const returned = definition.factory((id) => {
      if (id === 'react') return React
      throw new Error(`unknown module: ${id}`)
    })
    loaded = returned || module.exports
  },
}
new Function('window', `${source}\n`)({ __ModuleLoader__: shim })
const { Row, Section } = loaded.tree

/* --- the pieces of each view ---------------------------------------------- */

const row = (label, extra = {}) => ({ id: label, label, kind: 'leaf', ...extra })

const sections = [
  { id: 'world', label: '世界观', count: 7, rows: Array.from({ length: 7 }, (_, index) => row(`地点 · 雾港${index === 0 ? '旧码头' : index + 1}`)) },
  {
    id: 'cast', label: '人物设计', count: 6,
    rows: ['沈砚', '阿蘅', '老周', '陆知白', '程微', '徐望'].map((name, index) => row(name, { chip: index < 2 ? '主角' : '配角' })),
  },
  {
    id: 'plot', label: '剧情设计', count: 83,
    rows: [row('全书故事线', { chip: '故事线', count: 3 }), row('剧情点', { count: 83 }), row('伏笔总览', { count: 2 }), row('章卡', { count: 85 })],
  },
  { id: 'text', label: '正文', count: 5, rows: Array.from({ length: 5 }, (_, index) => row(`第${index + 1}章 裂缝`, { aside: index === 0 ? '已完成' : '草稿' })) },
]

const treeBody = sections
  .map((section, index) =>
    render(h(Section, {
      section,
      collapsed: new Set(index === 0 ? [] : ['cast', 'plot', 'text']),
      onToggle: () => {},
      selected: index === 0 ? sections[0].rows[0].id : null,
      onRowClick: () => {},
    })),
  )
  .join('')

const headBar = (title, actions = '') =>
  `<div ${attr(style(S.head, { position: 'sticky', top: 0, zIndex: 2 }))}>` +
  `<span ${attr(S.glyph)}>▤</span>` +
  `<span ${attr(style(S.bookTitle, { fontSize: '13.5px' }))}>${escape(title)}</span>` +
  `<span ${attr(S.spacer)}></span>${actions}</div>`

const crumbLine = (parts) =>
  `<div ${attr(S.crumb)}>${parts
    .flatMap((part, index) => (index === 0 ? [escape(part)] : [`<span style="opacity:.6">›</span>`, escape(part)]))
    .join('')}</div>`

const heading = (title, chip, subtitle) =>
  `<div style="padding:0 10px 6px">` +
  `<div style="display:flex;align-items:baseline;gap:6px">` +
  `<span style="font-size:15.5px;font-weight:600;letter-spacing:0.01em">${escape(title)}</span>` +
  (chip ? `<span ${attr(S.pill)}>${escape(chip)}</span>` : '') +
  `</div>` +
  (subtitle ? `<div ${attr(style(S.aside, { padding: '2px 0 0', maxWidth: '100%' }))}>${escape(subtitle)}</div>` : '') +
  `</div>`

const fieldBlock = (label, value) =>
  `<div ${attr(S.entryBlock)}><div ${attr(S.entryLabel)}>${escape(label)}</div>` +
  `<div ${attr(S.entryValue)}>${escape(value)}</div></div>`

const listHead = (label) => `<div ${attr(S.entryListHead)}>${escape(label)}</div>`
const listItem = (value) => `<div ${attr(S.entryItem)}>· ${escape(value)}</div>`
const footer = (path) => `<div ${attr(S.spacerBlock)}></div><div ${attr(S.footer)}>${escape(path)}</div>`

const ROOT_PATH = 'C:\\Users\\china\\Documents\\小说\\待定v2'

const button = (label, primary = false) =>
  `<button type="button" class="${primary ? 'iw-btn iw-primary' : 'iw-btn'}" ${attr(primary ? S.primaryButton : S.iconButton)}>${escape(label)}</button>`

const shelfCard = (title, meta, path, tag) =>
  `<button type="button" class="iw-book" ${attr(S.bookRow)}>` +
  `<span ${attr(S.bookIcon)}>▤</span>` +
  `<div ${attr(S.bookBody)}>` +
  `<span ${attr(S.bookName)}>${escape(title)}</span>` +
  `<span ${attr(S.bookMeta)}>${escape(meta)}</span>` +
  `<span ${attr(S.bookMeta)}>${escape(path)}</span>` +
  `</div>` +
  (tag ? `<span ${attr(S.pill)}>${escape(tag)}</span>` : '') +
  `</button>`

const shelf = `<div ${attr(S.root)}>
  ${headBar('小说工坊', button('＋ 新建', true))}
  <div ${attr(S.listWrap)}>
    <div ${attr(style(S.fieldLabel, { padding: '4px 2px 2px' }))}>已有的书 2 本</div>
    ${shelfCard('待定', '创作中 · 85 章 · 351,401 字', ROOT_PATH, '上次')}
    ${shelfCard('雾港', '设定中 · 5 章 · 42,180 字', 'E:\\dshplugin\\.novel', '')}
  </div>
  <button type="button" class="iw-settings" ${attr(S.settingsRow)}>
    <span ${attr(S.settingsIcon)}>⚙</span>
    <span ${attr(S.settingsLabel)}>设置</span>
    <span ${attr(S.spacer)}></span>
    <span style="color:var(--iw-fg-3);font-size:11.5px">智能体团队</span>
  </button>
  <div style="height:10px"></div>
</div>`

const tree = `<div ${attr(S.root)}>
  ${headBar('待定', button('设置'))}
  ${crumbLine(['书库', '待定'])}
  ${treeBody}
  ${footer(ROOT_PATH)}
</div>`

const detail = `<div ${attr(S.root)}>
  ${headBar('沈砚', button('返回') + button('编辑'))}
  ${crumbLine(['人物设计', '主角', '沈砚'])}
  ${heading('沈砚', '主角', '雾港码头记账人，前巡捕房探员')}
  ${fieldBlock('说话方式', '句子短，先给结论。急的时候只留动词。极少用感叹号，问句常带一句“你明白吗”。')}
  ${fieldBlock('外形', '三十上下，左侧眉骨有旧疤；常年一件洗白的靛蓝短褂，袖口磨出毛边。')}
  ${fieldBlock('想要什么', '查清十年前那批货的去向，把父亲的名字从走私名单上抹掉。')}
  ${fieldBlock('不愿被人知道', '那批货的第一张放行单是他签的。')}
  ${fieldBlock('其他材料', '与阿蘅：彼此试探，谁先摊牌谁先死。')}
  ${listHead('最近出场')}${listItem('第 3 章')}${listItem('第 4 章')}${listItem('第 7 章')}
  ${footer(ROOT_PATH)}
</div>`

const paragraph = (text) => `<p ${attr(S.proseLine)}>${escape(text)}</p>`

const prose = `<div ${attr(S.root)}>
  ${headBar('第1章 裂缝', button('返回') + button('编辑'))}
  ${crumbLine(['正文', '第一卷', '第1章 裂缝'])}
  ${heading('第1章 裂缝', '已完成', '2,230 字 · 修订 1')}
  ${listHead('正文')}
  <div ${attr(S.prose)}>
    ${paragraph('雨落了一夜，码头的木板吸饱了水，踩上去像踩在人的胸口。沈砚把伞收在门外，抖了抖袖口，才推门进去。')}
    ${paragraph('账房先生抬起头，目光在他脸上停了一瞬，又落回账本上。“这么早。”')}
    ${paragraph('“昨夜第三号仓进了货。”沈砚把手按在账本边缘，指腹压着那行还没干透的墨，“谁签的放行单？”')}
    ${paragraph('窗外的汽笛响了，长而闷，像谁在水底喊了一声。没有人回答他。')}
  </div>
  <div ${attr(S.editHint)}>2,230 字</div>
  ${footer(ROOT_PATH)}
</div>`

const dialog = `<div ${attr(S.root)}>
  ${headBar('小说工坊', button('＋ 新建', true))}
  <div class="iw-backdrop"><div class="iw-dialog">
    <div style="font-size:15px;font-weight:650;letter-spacing:0.01em">在这本书里开写</div>
    <div class="iw-dialogpath">${escape(ROOT_PATH)}</div>
    <div style="display:flex;flex-direction:column;gap:5px">
      <span ${attr(S.fieldLabel)}>书名</span>
      <input class="iw-input" ${attr(S.input)} value="待定">
    </div>
    <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;cursor:pointer;user-select:none">
      <input type="checkbox" checked> 这个文件夹里已有稿件，一并导入（87 章 · 35.1 万字）
    </label>
    <div style="display:flex;gap:8px;justify-content:flex-end;padding-top:2px">${button('取消')}${button('建书', true)}</div>
  </div></div>
</div>`

const views = [
  ['shelf', '书库', shelf],
  ['tree', '目录', tree],
  ['detail', '角色页', detail],
  ['prose', '正文页', prose],
  ['dialog', '建书弹窗', dialog],
]

const page = (body, dark, extra = '') => `<!doctype html>
<html lang="zh-CN"${dark ? ' class="dark"' : ''}>
<head><meta charset="utf-8"><title>小说工坊 · 预览</title>
<style>
:root { color-scheme: ${dark ? 'dark' : 'light'}; }
html, body { margin: 0; background: ${dark ? '#1b1e23' : '#ffffff'}; color: ${dark ? '#e8e8ea' : '#1b1d20'}; }
body { font-family: -apple-system, 'Segoe UI', 'Microsoft YaHei', system-ui, sans-serif; }
.pane { width: 360px; box-sizing: border-box; padding-bottom: 8px; }
${CSS}
${extra}
</style></head>
<body>${body}</body></html>`

writeFileSync(`${out}sheet-light.html`, page(views.slice(0, 4).map(([, , view]) => `<div class="pane">${view}</div>`).join(''), false))
writeFileSync(`${out}sheet-dark.html`, page(views.slice(0, 4).map(([, , view]) => `<div class="pane">${view}</div>`).join(''), true, extractDark(CSS)))

for (const [id, , view] of views) {
  const isolate = id === 'dialog' ? `.iw-backdrop { position: static; background: none; backdrop-filter: none; padding: 0; }` : ''
  writeFileSync(`${out}${id}.html`, page(`<div class="pane">${view}</div>`, false, isolate))
}
console.log(`wrote ${views.length + 2} preview pages to preview/`)

/** Copy the dark-mode token block out of the sheet so it can be forced. */
function extractDark(css) {
  const match = css.match(/@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}\n/)
  if (!match) return ''
  return match[1].replaceAll(':root', 'html.dark')
}
