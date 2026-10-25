/**
 * The panel's browser half, rendered without a browser.
 *
 * `client.js` is hand-written and has no bundler, so nothing else would catch a
 * row that renders but calls the wrong handler — which is exactly what happened:
 * clicking 沈砚 highlighted the row instead of opening his page, and only a
 * reader noticed. A stub `React.createElement` is enough to call `Row` and click
 * what it returns, because `Row` uses no hooks.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The element shape the stub builds; only `props` matters to these tests. */
interface Element {
  type: unknown
  props: Record<string, unknown> & { children?: unknown }
}

const SOURCE = join(import.meta.dirname, '..', 'client.js')

/**
 * Load `client.js` the way the host does and hand back the module's exports.
 *
 * The file is run, not imported: it expects `window.__ModuleLoader__` and a
 * global `React`, and both are supplied here.
 */
async function loadClient(): Promise<Record<string, unknown>> {
  const code = await readFile(SOURCE, 'utf8')
  const stub = {
    createElement: (type: unknown, props: Element['props'] | null, ...children: unknown[]): Element => ({
      type,
      props: { ...(props ?? {}), children },
    }),
    useState: <T,>(initial: T): [T, (next: T) => void] => [initial, () => undefined],
    useEffect: (): void => undefined,
    useCallback: <T,>(callback: T): T => callback,
    useMemo: <T,>(factory: () => T): T => factory(),
    useRef: <T,>(initial: T): { current: T } => ({ current: initial }),
  }
  const global = globalThis as unknown as {
    window: { __ModuleLoader__: { load: (definition: unknown) => void } }
  }
  const previous = global.window
  let exports: Record<string, unknown> | undefined
  global.window = {
    __ModuleLoader__: {
      load: (definition: unknown) => {
        const factory = (definition as { factory: (require: (id: string) => unknown) => Record<string, unknown> })
          .factory
        exports = factory((id: string) => {
          if (id === 'react') return stub
          throw new Error(`client.js asked for "${id}", which the host does not provide`)
        })
      },
    },
  }
  try {
    const require = createRequire(import.meta.url)
    const runner = new Function('window', 'require', 'module', 'exports', code)
    runner(global.window, require, { exports: {} }, {})
  } finally {
    global.window = previous
  }
  if (exports === undefined) throw new Error('client.js exported nothing')
  return exports
}

/** One chapter row, the shape `src/panel/tree.ts` emits. */
const chapterRow = {
  id: 'text:1',
  label: '第1章 裂缝',
  kind: 'chapter',
  key: '1',
  chip: '已完成',
  aside: '2140 字',
  tone: 'done',
}

/** One group row: no `kind`, so it only expands. */
const groupRow = { id: 'cast:protagonist', label: '主角', count: 1, children: [] }

describe('panel rows', () => {
  it('asks for the page when a row stands for something', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Row: (props: Record<string, unknown>) => Element[] }
    const clicked: unknown[] = []
    const rendered = tree.Row({
      row: chapterRow,
      depth: 1,
      collapsed: new Set<string>(),
      onToggle: () => undefined,
      selected: null,
      onRowClick: (row: unknown) => clicked.push(row),
    })
    const head = rendered[0]
    if (head === undefined) throw new Error('the row rendered nothing')
    ;(head.props.onClick as () => void)()
    // The one bug worth pinning: the click has to reach the handler that opens
    // pages, not a state setter that only repaints a highlight.
    expect(clicked).toEqual([chapterRow])
  })

  it('sends group rows to the same handler, which toggles them', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Row: (props: Record<string, unknown>) => Element[] }
    const clicked: unknown[] = []
    const rendered = tree.Row({
      row: groupRow,
      depth: 1,
      collapsed: new Set<string>(),
      onToggle: () => undefined,
      selected: null,
      onRowClick: (row: unknown) => clicked.push(row),
    })
    ;(rendered[0]?.props.onClick as () => void)()
    expect(clicked).toEqual([groupRow])
  })

  it('keeps the caret from toggling and opening at once', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Row: (props: Record<string, unknown>) => Element[] }
    const toggled: string[] = []
    const clicked: unknown[] = []
    const withChildren = { ...groupRow, children: [{ ...chapterRow, id: 'text:2' }] }
    const rendered = tree.Row({
      row: withChildren,
      depth: 1,
      collapsed: new Set<string>(),
      onToggle: (id: string) => toggled.push(id),
      selected: null,
      onRowClick: (row: unknown) => clicked.push(row),
    })
    const glyph = (rendered[0]?.props.children as Element[])[0]
    let stopped = false
    ;(glyph?.props.onClick as (event: { stopPropagation: () => void }) => void)({
      stopPropagation: () => {
        stopped = true
      },
    })
    expect(toggled).toEqual([withChildren.id])
    expect(stopped).toBe(true)
    expect(clicked).toEqual([])
  })

  it('tells the pointer, the keyboard and the screen reader that a row is pressable', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Row: (props: Record<string, unknown>) => Element[] }
    const props = (selected: string | null): Element['props'] => {
      const rendered = tree.Row({
        row: chapterRow,
        depth: 1,
        collapsed: new Set<string>(),
        onToggle: () => undefined,
        selected,
        onRowClick: () => undefined,
      })
      const head = rendered[0]
      if (head === undefined) throw new Error('the row rendered nothing')
      return head.props
    }
    // Hover and focus states are keyed off these classes; without them a row is
    // silently inert even though it has a click handler.
    expect(props(null).className).toBe('iw-row')
    expect(props(chapterRow.id).className).toBe('iw-row iw-row-sel')
    expect(props(null).role).toBe('button')
    expect(props(null).tabIndex).toBe(0)
  })

  it('opens the page from the keyboard, not only from the mouse', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Row: (props: Record<string, unknown>) => Element[] }
    const clicked: unknown[] = []
    let prevented = 0
    const rendered = tree.Row({
      row: chapterRow,
      depth: 1,
      collapsed: new Set<string>(),
      onToggle: () => undefined,
      selected: null,
      onRowClick: (row: unknown) => clicked.push(row),
    })
    const head = rendered[0]
    if (head === undefined) throw new Error('the row rendered nothing')
    const press = (key: string): void => {
      ;(head.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key,
        preventDefault: () => {
          prevented += 1
        },
      })
    }
    press('Enter')
    press(' ')
    press('a')
    expect(clicked).toEqual([chapterRow, chapterRow])
    // Space must not also scroll the sidebar.
    expect(prevented).toBe(2)
  })

  it('gives a drawer heading the same hover and keyboard treatment', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Section: (props: Record<string, unknown>) => Element }
    const toggled: string[] = []
    const section = { id: 'cast', label: '人物设计', count: 3, rows: [chapterRow] }
    const rendered = tree.Section({
      section,
      collapsed: new Set<string>(),
      onToggle: (id: string) => toggled.push(id),
      selected: null,
      onRowClick: () => undefined,
    })
    const heading = (rendered.props.children as Element[])[0]
    if (heading === undefined) throw new Error('the drawer rendered no heading')
    expect(heading.props.className).toBe('iw-open')
    expect(heading.props.tabIndex).toBe(0)
    expect(heading.props['aria-expanded']).toBe('true')
    ;(heading.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
      key: 'Enter',
      preventDefault: () => undefined,
    })
    expect(toggled).toEqual(['cast'])
  })
})
