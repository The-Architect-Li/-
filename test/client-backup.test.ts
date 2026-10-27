/**
 * The backup dialog, rendered without a browser.
 *
 * Three facts have nowhere else to be checked: an empty shelf of copies says the
 * copies live outside the book, a copy that exists can be gone back to by name,
 * and the restore button stays shut while a restore is already running.
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

/** Every string in the tree, so a sentence can be looked for wherever it sits. */
function textOf(element: Element): string {
  return walk(element)
    .map((node) => {
      const kids = node.props.children
      const parts = Array.isArray(kids) ? kids : [kids]
      return parts.filter((part) => typeof part === 'string').join(' ')
    })
    .join('\n')
}

const book = { root: 'C:\\书\\待定\\.novel', title: '待定', chapters: 85, words: 351401 }

const copies = [
  { name: 'pre-restore-2026-10-27T19-31-05.zip', at: '2026-10-27T19:31:05.000Z', files: 97, bytes: 1166389, line: '2026-10-27T19:31:05 · 97 个文件 · 1139 KB' },
  { name: '2026-10-27T18-02-11.zip', at: '2026-10-27T18:02:11.000Z', files: 96, bytes: 1150000, line: '2026-10-27T18:02:11 · 96 个文件 · 1123 KB' },
]

describe('the backup dialog', () => {
  it('says where the copies live when there are none', async () => {
    const exports = await loadClient()
    const dialogs = exports.dialogs as { BackupDialog: (props: Record<string, unknown>) => Element }
    const rendered = dialogs.BackupDialog({
      book,
      backups: [],
      dir: 'C:\\Users\\china\\.dsh\\state\\inkwell\\backups\\待定-3f9c1a7b',
      busy: false,
      error: '',
      notice: '',
      onMake: () => undefined,
      onRestore: () => undefined,
      onCancel: () => undefined,
    })
    const text = textOf(rendered)
    expect(text).toContain('还没有副本')
    expect(text).toContain('副本不在书里')
    // Making one is the only thing offered while the list is empty.
    const buttons = walk(rendered).filter((element) => element.type === 'button')
    expect(buttons.some((element) => labelOf(element).includes('现在备份一次'))).toBe(true)
    expect(buttons.some((element) => labelOf(element).includes('回到这一版'))).toBe(false)
  })

  it('offers each copy by name, and says the present is kept first', async () => {
    const exports = await loadClient()
    const dialogs = exports.dialogs as { BackupDialog: (props: Record<string, unknown>) => Element }
    const restored: string[] = []
    const rendered = dialogs.BackupDialog({
      book,
      backups: copies,
      dir: 'C:\\backups',
      busy: false,
      error: '',
      notice: '',
      onMake: () => undefined,
      onRestore: (name: string) => restored.push(name),
      onCancel: () => undefined,
    })
    const buttons = walk(rendered).filter((element) => element.type === 'button')
    const back = buttons.filter((element) => labelOf(element) === '回到这一版')
    expect(back).toHaveLength(2)
    ;(back[1]?.props.onClick as () => void)()
    expect(restored).toEqual(['2026-10-27T18-02-11.zip'])
    expect(textOf(rendered)).toContain('pre-restore')
  })

  it('does not let a second restore start while one is running', async () => {
    const exports = await loadClient()
    const dialogs = exports.dialogs as { BackupDialog: (props: Record<string, unknown>) => Element }
    const rendered = dialogs.BackupDialog({
      book,
      backups: copies,
      dir: 'C:\\backups',
      busy: true,
      error: '',
      notice: '',
      onMake: () => undefined,
      onRestore: () => undefined,
      onCancel: () => undefined,
    })
    const buttons = walk(rendered).filter((element) => element.type === 'button')
    const back = buttons.filter((element) => labelOf(element) === '回到这一版')
    expect(back.every((element) => element.props.disabled === true)).toBe(true)
    expect(buttons.some((element) => labelOf(element).includes('正在处理'))).toBe(true)
  })

  it('survives a book it cannot name instead of taking the panel down', async () => {
    const exports = await loadClient()
    const dialogs = exports.dialogs as { BackupDialog: (props: Record<string, unknown>) => Element }
    // 0.30.0 shipped with the overlay reading `.book` off a book, and the
    // resulting throw blanked the whole pane. The dialog now says so instead.
    const rendered = dialogs.BackupDialog({
      book: undefined,
      backups: [],
      dir: '',
      busy: false,
      error: '',
      notice: '',
      onMake: () => undefined,
      onRestore: () => undefined,
      onCancel: () => undefined,
    })
    expect(textOf(rendered)).toContain('没拿到书的信息')
  })
})

it('hands the backup dialog the book itself, not a wrapper', async () => {
  // The overlay in `InkwellBody` and the callback that opens it must agree on
  // the shape: reading `.book` off a book is what blanked the panel in 0.30.0.
  const source = await readFile(SOURCE, 'utf8')
  const start = source.indexOf('backupFor === null')
  expect(start).toBeGreaterThan(0)
  const block = source.slice(start, start + 400)
  expect(block).toContain('book: backupFor,')
  expect(block).not.toContain('backupFor.book')
})
