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
})
