/**
 * The chapter list must not become a 300-row scroll.
 *
 * Two things get checked here, both of them only checkable by rendering the
 * hand-written bundle: that a long flat run mounts a window's worth of rows
 * rather than all of them, and that the volume dialog exists and says what it
 * does before it has read anything.
 */
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The element shape the stub builds; only `type` and `props` matter here. */
interface Element {
  type: unknown
  props: Record<string, unknown> & { children?: unknown }
}

const SOURCE = join(import.meta.dirname, '..', 'client.js')

/** Load `client.js` with a stub React, the way the other client tests do. */
async function loadClient(): Promise<Record<string, unknown>> {
  const code = await readFile(SOURCE, 'utf8')
  const stub = {
    createElement: (type: unknown, props: Element['props'] | null, ...children: unknown[]): Element => ({
      type,
      props: { ...(props ?? {}), children },
    }),
    useState: <T,>(initial: T): [T, (next: T) => void] => [typeof initial === 'function' ? (initial as () => T)() : initial, () => undefined],
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
    const run = new Function('window', 'require', code) as (window: unknown, require: unknown) => void
    run(global.window, require)
  } finally {
    global.window = previous
  }
  if (!exports) throw new Error('client.js did not call __ModuleLoader__.load')
  return exports
}

/**
 * Render function components until only elements with a string tag are left.
 *
 * The stub `createElement` does not run components, so `Row` and the window it
 * returns would otherwise be two opaque elements and no rows at all.
 */
function deep(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(deep)
  if (node === null || node === undefined || typeof node !== 'object') return node
  const element = node as Element
  if (typeof element.type === 'function') {
    return deep((element.type as (props: Element['props']) => unknown)(element.props))
  }
  const children = Array.isArray(element.props.children) ? element.props.children : []
  return { type: element.type, props: { ...element.props, children: children.map(deep) } }
}

/** Every element in a rendered tree, depth first. */
function walk(node: unknown, found: Element[] = []): Element[] {
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) walk(child, found)
    return found
  }
  const element = node as Element
  if ('props' in element) {
    found.push(element)
    walk(element.props.children, found)
  }
  return found
}

/** Every string a rendered tree puts on screen. */
function stringsOf(node: unknown): string[] {
  const texts: string[] = []
  for (const element of walk(node)) {
    const children = Array.isArray(element.props.children) ? element.props.children : []
    for (const child of children) if (typeof child === 'string') texts.push(child)
  }
  return texts
}

describe('a long chapter run', () => {
  it('mounts a window of rows, not the whole volume', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Row: (props: Record<string, unknown>) => unknown }
    const chapters = Array.from({ length: 300 }, (_, index) => ({
      id: `text.chapter.${index + 1}`,
      label: `第${index + 1}章 测试`,
      kind: 'chapter',
      key: String(index + 1),
      chip: '已完成',
    }))
    const volume = { id: 'text.volume.1', label: '第1卷', count: 300, children: chapters }
    const rendered = deep(
      tree.Row({
        row: volume,
        depth: 1,
        collapsed: new Set(),
        onToggle: () => undefined,
        selected: null,
        onRowClick: () => undefined,
      }),
    )
    const labels = stringsOf(rendered).filter((text) => text.endsWith('章 测试'))
    expect(labels.length).toBeGreaterThan(5)
    expect(labels.length).toBeLessThan(40)
    expect(labels).toContain('第1章 测试')
  })

  it('keeps a short run as plain rows', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Row: (props: Record<string, unknown>) => unknown }
    const chapters = Array.from({ length: 5 }, (_, index) => ({
      id: `text.chapter.${index + 1}`,
      label: `第${index + 1}章 测试`,
      kind: 'chapter',
      key: String(index + 1),
    }))
    const rendered = deep(
      tree.Row({
        row: { id: 'text.volume.2', label: '第2卷', count: 5, children: chapters },
        depth: 1,
        collapsed: new Set(),
        onToggle: () => undefined,
        selected: null,
        onRowClick: () => undefined,
      }),
    )
    expect(stringsOf(rendered)).toContain('第5章 测试')
  })
})

describe('the volume dialog', () => {
  it('opens on 正文分卷 and says it is still reading', async () => {
    const exports = await loadClient()
    const dialogs = exports.dialogs as { VolumesDialog: (props: Record<string, unknown>) => Element }
    const rendered = deep(
      dialogs.VolumesDialog({
        book: { root: 'C:\\书', title: '待定' },
        sessionId: 's1',
        onDone: () => undefined,
        onCancel: () => undefined,
      }),
    )
    const texts = stringsOf(rendered).join(' ')
    expect(texts).toContain('正文分卷')
    expect(texts).toContain('正在读分卷')
    expect(texts).toContain('手动分配')
    expect(texts).toContain('自动划分')
    const labelled = walk(rendered).find((element) => element.props['aria-label'] === '正文分卷')
    expect(labelled).toBeDefined()
  })
})
