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
  /** A 正文 drawer with `count` chapters spread over volumes of `perVolume`. */
  function drawer(count: number, perVolume: number): Record<string, unknown> {
    const rows: Record<string, unknown>[] = []
    let made = 0
    for (let volume = 1; made < count; volume += 1) {
      const children = [] as Record<string, unknown>[]
      for (let index = 0; index < perVolume && made < count; index += 1) {
        made += 1
        children.push({
          id: `text.chapter.${made}`,
          label: `第${made}章 测试`,
          kind: 'chapter',
          key: String(made),
          chip: '已完成',
        })
      }
      rows.push({ id: `text.volume.${volume}`, label: `第${volume}卷`, count: children.length, children })
    }
    return { id: 'text', label: '正文', count, rows }
  }

  it('mounts a window of rows when the whole drawer is long', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Section: (props: Record<string, unknown>) => unknown }
    const rendered = deep(
      tree.Section({
        section: drawer(300, 30),
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

  it('windows by visible lines, not by rows at the top', async () => {
    // Ten volumes of ten chapters is ten top-level rows — a per-run window would
    // never fire here, yet the drawer is a hundred lines long.
    const exports = await loadClient()
    const tree = exports.tree as { Section: (props: Record<string, unknown>) => unknown }
    const rendered = deep(
      tree.Section({
        section: drawer(100, 10),
        collapsed: new Set(),
        onToggle: () => undefined,
        selected: null,
        onRowClick: () => undefined,
      }),
    )
    const labels = stringsOf(rendered).filter((text) => text.endsWith('章 测试'))
    expect(labels.length).toBeLessThan(40)
    expect(labels.length).toBeGreaterThan(5)
  })

  it('keeps a short drawer as plain rows', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Section: (props: Record<string, unknown>) => unknown }
    const rendered = deep(
      tree.Section({
        section: drawer(5, 5),
        collapsed: new Set(),
        onToggle: () => undefined,
        selected: null,
        onRowClick: () => undefined,
      }),
    )
    const labels = stringsOf(rendered)
    expect(labels).toContain('第5章 测试')
    expect(labels).toContain('第1卷')
  })

  it('counts only what is open: a folded volume contributes one line', async () => {
    const exports = await loadClient()
    const tree = exports.tree as { Section: (props: Record<string, unknown>) => unknown }
    const section = drawer(300, 30)
    const folded = (section.rows as { id: string }[]).map((row) => row.id)
    const rendered = deep(
      tree.Section({
        section,
        collapsed: new Set(folded),
        onToggle: () => undefined,
        selected: null,
        onRowClick: () => undefined,
      }),
    )
    const labels = stringsOf(rendered).filter((text) => text.endsWith('章 测试'))
    expect(labels).toEqual([])
    expect(stringsOf(rendered)).toContain('第1卷')
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
