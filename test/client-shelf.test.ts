/**
 * The two shelf dialogs that can lose work, rendered without a browser.
 *
 * Both guard something that is expensive to get wrong: the delete question must
 * not be answerable without the confirming checkbox, and the export must not run
 * before a folder exists. `client.js` is hand-written with no bundler, so these
 * two facts have nowhere else to be checked.
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

/** Load `client.js` with a stub React, the way `test/client.test.ts` does. */
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

/** The text a button carries, flattened. */
function labelOf(element: Element): string {
  const kids = element.props.children
  const parts = Array.isArray(kids) ? kids : [kids]
  return parts.filter((part) => typeof part === 'string').join('')
}

const book = { root: 'C:\\书\\待定\\.novel', title: '待定', chapters: 85, words: 351401 }

describe('the shelf dialogs', () => {
  it('will not delete without the confirming checkbox', async () => {
    const exports = await loadClient()
    const dialogs = exports.dialogs as {
      DeleteDialog: (props: Record<string, unknown>) => Element
    }
    const deleted: unknown[] = []
    const rendered = dialogs.DeleteDialog({
      book,
      busy: false,
      error: '',
      onExportFirst: () => undefined,
      onDeleteNow: () => deleted.push('now'),
      onCancel: () => undefined,
    })
    const buttons = walk(rendered).filter((element) => element.type === 'button')
    const deleteNow = buttons.find((element) => labelOf(element).includes('直接删除'))
    if (!deleteNow) throw new Error('the dialog offered no delete button')
    expect(deleteNow.props.disabled).toBe(true)
    // The escape route is offered up front, not hidden behind the checkbox.
    const exportFirst = buttons.find((element) => labelOf(element).includes('先导出'))
    expect(exportFirst).toBeDefined()
    expect(exportFirst?.props.disabled).toBe(false)
    expect(deleted).toEqual([])
  })

  it('says plainly that a delete cannot be undone', async () => {
    const exports = await loadClient()
    const dialogs = exports.dialogs as { DeleteDialog: (props: Record<string, unknown>) => Element }
    const rendered = dialogs.DeleteDialog({
      book,
      busy: false,
      error: '',
      onExportFirst: () => undefined,
      onDeleteNow: () => undefined,
      onCancel: () => undefined,
    })
    const text = walk(rendered)
      .map((element) => labelOf(element))
      .join('\n')
    expect(text).toContain('删除后不能恢复')
  })

  it('will not export until a folder has been chosen', async () => {
    const exports = await loadClient()
    const dialogs = exports.dialogs as {
      ExportDialog: (props: Record<string, unknown>) => Element
    }
    const runs: unknown[][] = []
    const props = {
      book,
      busy: false,
      error: '',
      afterDelete: false,
      onExport: (...args: unknown[]) => runs.push(args),
      onRepick: () => undefined,
      onCancel: () => undefined,
    }
    const closed = walk(dialogs.ExportDialog({ ...props, dir: '' })).filter(
      (element) => element.type === 'button' && labelOf(element) === '导出',
    )
    expect(closed[0]?.props.disabled).toBe(true)
    const open = walk(dialogs.ExportDialog({ ...props, dir: 'C:\\导出' })).filter(
      (element) => element.type === 'button' && labelOf(element) === '导出',
    )
    expect(open[0]?.props.disabled).toBe(false)
    ;(open[0]?.props.onClick as () => void)()
    // Defaults to the submission format: one txt for the whole book.
    expect(runs).toEqual([['C:\\导出', 'txt']])
  })
})
