/**
 * Smoke-test the *built* package the way a profile consumes it.
 *
 * The vitest suite imports `src/`, so a packaging mistake (missing `lib/`,
 * broken `exports`, a prepare script that never ran) would pass every test and
 * still ship a plugin that cannot mount. This mounts `lib/index.js` with a fake
 * context and reports what actually registered.
 *
 * It also checks the *browser* half, which no test can import: the web shell
 * discovers a client bundle through the manifest (`dsh.client.platform`,
 * `exports["./client"]`) and then loads the file's `__ModuleLoader__`
 * registration. A declaration typo or a bundle that is not in `files` is
 * invisible to vitest and fatal at boot, so both are asserted here.
 *
 * Run with: node verify-install.mjs [path-to-plugin-root]
 */
import { readFileSync, existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(process.argv[2] ?? '.')

/** Read the built package manifest. */
function readManifest() {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
}

/** Resolve a `dsh.client` inject entry the way `dsh-client-modules` does. */
function clientExportOf(manifest, specifier) {
  const entry = manifest.exports?.[specifier]
  if (typeof entry === 'string') return entry
  if (entry !== null && typeof entry === 'object' && typeof entry.default === 'string') return entry.default
  return undefined
}

const tools = new Map()
const gates = []
const routes = []
const services = {
  tools: { register: (definition) => void tools.set(definition.name, definition) },
  subagents: {
    start: async () => {
      throw new Error('not used in this smoke test')
    },
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => undefined
    },
  },
}

const ctx = {
  tools: services.tools,
  subagents: services.subagents,
  on: (event, listener) => {
    if (event === 'tools/pre-execute') gates.push(listener)
    return () => undefined
  },
  get: (service) => services[service],
  inject: (deps, callback) => {
    if (deps.every((needed) => services[needed] !== undefined)) callback(ctx)
    return () => undefined
  },
  effect: (effect) => {
    const disposer = effect()
    return typeof disposer === 'function' ? disposer : () => undefined
  },
}

const plugin = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
if (typeof plugin.apply !== 'function') throw new Error('lib/index.js exports no apply()')
if (!plugin.Config) throw new Error('lib/index.js exports no Config schema')
if ('default' in plugin) {
  // The loader normalizes a module with `exports.default ?? exports` and hands
  // that to Cordis. A default export therefore *replaces* the namespace, and an
  // apply() without inject activates before its services exist — a boot failure
  // this script would otherwise miss, because it calls apply() directly.
  throw new Error('lib/index.js has a default export: the loader would unwrap to it and drop inject')
}
if (!Array.isArray(plugin.inject)) throw new Error('lib/index.js exports no inject list')

plugin.apply(ctx, { root: '.novel' })

const names = [...tools.keys()].sort()
const expected = [
  'novel_briefing', 'novel_canon', 'novel_chapter', 'novel_check', 'novel_dispatch',
  'novel_ledger', 'novel_outline', 'novel_project', 'novel_roles', 'novel_skill',
]

console.log('plugin name      :', plugin.name)
console.log('tools registered :', names.length, names.join(' '))
console.log('gate listeners   :', gates.length)
console.log('config keys      :', Object.keys(plugin.Config.dict ?? plugin.Config).length)
console.log('panel routes     :', routes.length, routes.map((route) => `${route.kind} ${route.path}`).join(' '))

const missing = expected.filter((tool) => !tools.has(tool))
if (missing.length > 0) throw new Error(`missing tools: ${missing.join(', ')}`)
if (gates.length !== 1) throw new Error(`expected one pre-execute gate, got ${gates.length}`)
if (routes.length !== 1) throw new Error(`expected one panel route, got ${routes.length}`)

const manifest = readManifest()
const client = manifest.dsh?.client
if (client === undefined) throw new Error('package.json declares no dsh.client, so the web shell never loads the panel')
if (client.platform !== 'web') throw new Error(`dsh.client.platform is ${client.platform}, not "web"`)

const bundleRel = clientExportOf(manifest, './client')
if (bundleRel === undefined) throw new Error('dsh.client is declared but exports["./client"] is missing')

const bundlePath = isAbsolute(bundleRel) ? bundleRel : join(root, bundleRel)
if (!existsSync(bundlePath)) throw new Error(`client bundle missing at ${bundleRel} — check files[] and the build`)

const bundle = readFileSync(bundlePath, 'utf8')
if (!bundle.includes('__ModuleLoader__.load')) throw new Error('client bundle never calls __ModuleLoader__.load')
if (!bundle.includes(manifest.name)) throw new Error(`client bundle does not register the package id ${manifest.name}`)
if (!bundle.includes('exports.apply')) throw new Error('client bundle exports no apply()')

const shipped = manifest.files ?? []
if (!shipped.some((entry) => bundleRel.replace(/^\.\//, '').startsWith(entry.replace(/^\.\//, '')))) {
  throw new Error(`${bundleRel} is not covered by files[], so npm would not publish it`)
}

for (const name of client.inject ?? []) {
  if (!name.startsWith('@deepseek-ai/dsh-')) throw new Error(`dsh.client.inject names ${name}, which is not a dsh client plugin`)
}

console.log('client platform  :', client.platform)
// `bundle.length` counts UTF-16 code units, and this bundle is full of Chinese
// text: it read 131,140 for a file that is 135,071 bytes on disk. Byte length is
// what anyone comparing against the download expects, so report that.
console.log('client bundle    :', bundleRel, `${Buffer.byteLength(bundle, 'utf8')} bytes`)
console.log('OK: built package mounts cleanly and advertises a loadable panel')
