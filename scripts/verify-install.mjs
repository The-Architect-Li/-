/**
 * Smoke-test the *built* package the way a profile consumes it.
 *
 * The vitest suite imports `src/`, so a packaging mistake (missing `lib/`,
 * broken `exports`, a prepare script that never ran) would pass every test and
 * still ship a plugin that cannot mount. This mounts `lib/index.js` with a fake
 * context and reports what actually registered.
 *
 * Run with: node verify-install.mjs [path-to-plugin-root]
 */
import { pathToFileURL } from 'node:url'

const root = process.argv[2] ?? '.'
const entry = pathToFileURL(`${root}/lib/index.js`).href

const tools = new Map()
const gates = []
const ctx = {
  tools: { register: (definition) => void tools.set(definition.name, definition) },
  subagents: { start: async () => { throw new Error('not used in this smoke test') } },
  on: (event, listener) => {
    if (event === 'tools/pre-execute') gates.push(listener)
    return () => undefined
  },
}

const plugin = await import(entry)
if (typeof plugin.apply !== 'function') throw new Error('lib/index.js exports no apply()')
if (!plugin.Config) throw new Error('lib/index.js exports no Config schema')

plugin.apply(ctx, { root: '.novel' })

const names = [...tools.keys()].sort()
const expected = [
  'novel_briefing', 'novel_canon', 'novel_chapter', 'novel_check', 'novel_dispatch',
  'novel_ledger', 'novel_outline', 'novel_project', 'novel_roles',
]

console.log('plugin name      :', plugin.name)
console.log('tools registered :', names.length, names.join(' '))
console.log('gate listeners   :', gates.length)
console.log('config keys      :', Object.keys(plugin.Config.dict ?? plugin.Config).length)

const missing = expected.filter((tool) => !tools.has(tool))
if (missing.length > 0) throw new Error(`missing tools: ${missing.join(', ')}`)
if (gates.length !== 1) throw new Error(`expected one pre-execute gate, got ${gates.length}`)
console.log('OK: built package mounts cleanly')
