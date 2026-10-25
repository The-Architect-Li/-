/**
 * The chapter picker on the timeline page, rendered without a browser.
 *
 * Dating chapters one box at a time is what kept the author's own clock empty
 * for eighty-five chapters, so the picker's arithmetic — which chapters are
 * selected, what a toggle sends back, what a click on an already-dated chapter
 * does — is worth pinning down where no eye can be fooled by a screenshot.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The element shape the stub builds; only `type` and `props` matter here. */
interface Element {
  type: unknown
  props: Record<string, unknown> & { children?: unknown }
}

const SOURCE = join(import.meta.dirname, '..', 'client.js')

/** Load `client.js` with a stub React, the way `test/client-shelf.test.ts` does. */
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
    // The bundle registers itself against `window`, exactly as the host shell does.
    new Function('window', code)(global.window)
  } finally {
    global.window = previous
  }
  if (!exports) throw new Error('client.js did not call __ModuleLoader__.load')
  return exports
}

/** Collect every string under an element, so a rendered chip can be read as text. */
function stringsOf(node: unknown): string[] {
  if (node === null || node === undefined || node === false) return []
  if (typeof node === 'string' || typeof node === 'number') return [String(node)]
  if (Array.isArray(node)) return node.flatMap((child) => stringsOf(child))
  const element = node as Element
  return stringsOf(element.props?.children)
}

/** Every rendered chip, in order. */
function chipsOf(node: unknown): Element[] {
  if (node === null || node === undefined || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap((child) => chipsOf(child))
  const element = node as Element
  const own = typeof element.props?.className === 'string' && element.props.className.includes('iw-chip') ? [element] : []
  return [...own, ...chipsOf(element.props?.children)]
}

describe('the chapter picker', () => {
  it('says how many are picked and which of them already have a date', async () => {
    const exports = await loadClient()
    const picker = exports.clock as { ClockChips: (props: Record<string, unknown>) => Element }
    const rendered = picker.ClockChips({
      clock: { chapters: [1, 2, 3], dated: { '2': '2019-10' } },
      value: '1,3',
      onChange: () => undefined,
    })
    const text = stringsOf(rendered).join(' ')
    expect(text).toContain('已选 2 / 3')
    // A dotted chapter is one that already carries a date — the picker says so
    // rather than leaving the reader to guess why a chip looks different.
    expect(chipsOf(rendered)).toHaveLength(3)
    expect(text).toContain('·')
    expect(text).toContain('全选')
  })

  it('sends back the whole selection, sorted, so the save needs no second pass', async () => {
    const exports = await loadClient()
    const picker = exports.clock as { ClockChips: (props: Record<string, unknown>) => Element }
    const sent: string[] = []
    const rendered = picker.ClockChips({
      clock: { chapters: [1, 2, 3], dated: {} },
      value: '3',
      onChange: (next: string) => sent.push(next),
    })
    const chips = chipsOf(rendered)
    // Pick chapter 1 while 3 is already picked.
    ;(chips[0]?.props.onClick as () => void)()
    expect(sent).toEqual(['1,3'])
    // A click on a chapter that has the date takes it out. The stub does not
    // re-render, so this second click still reads the page's original value —
    // which is exactly the "toggle one off" arithmetic under test.
    ;(chips[2]?.props.onClick as () => void)()
    expect(sent).toEqual(['1,3', ''])
  })

  it('offers to clear everything once every chapter is picked', async () => {
    const exports = await loadClient()
    const picker = exports.clock as { ClockChips: (props: Record<string, unknown>) => Element }
    const sent: string[] = []
    const rendered = picker.ClockChips({
      clock: { chapters: [1, 2], dated: {} },
      value: '1,2',
      onChange: (next: string) => sent.push(next),
    })
    const text = stringsOf(rendered).join(' ')
    expect(text).toContain('清空')
    const all = chipsOf(rendered)
    expect(all).toHaveLength(2)
  })
})
