/**
 * Copy the build output into the DSH profile that actually loads it.
 *
 * The plugin is installed with `"dsh-inkwell": "file:…"`, which pnpm satisfies by
 * hard-linking files. That makes editing an existing file look like it syncs —
 * both paths share one inode, so `tsc` writing `lib/domain/store.js` updates the
 * installed copy too.
 *
 * **New files do not work that way.** A module that did not exist when the
 * dependency was installed has no inode to share, so it only ever lands in the
 * dev tree. Fifteen new modules accumulated this way, and the plugin stopped
 * loading with `Cannot find module …/lib/domain/kinds.js` — a failure that says
 * nothing about which change caused it.
 *
 * So: this script fills in what is missing. It deliberately does **not** rewrite
 * files that already exist — those are already the same inode, and writing them
 * here would be the same bytes going to the same place twice.
 *
 * Usage:
 *   node scripts/sync.mjs                # to ~/.dsh/profiles/desktop
 *   DSH_PROFILE=/path/to/profile node scripts/sync.mjs
 */
import { copyFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.DSH_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const target = join(profile, 'node_modules', 'dsh-inkwell')

/** Every file worth shipping, relative to the package root. */
const SHIP = ['lib', 'client.js', 'README.md', 'README.zh.md']

/**
 * Copy one file if the destination is missing or holds different bytes.
 *
 * "Different bytes" is the whole point. pnpm's `file:` install hard-links the
 * package, so a file edited in place is shared and needs nothing — but `tsc`
 * writes its output by replacing the file, which breaks that link. From then on
 * the installed copy is frozen at the version it was built with, and a script
 * that only fills in *missing* files never notices: the source has the change,
 * the built file has the change, the installed file does not.
 *
 * That is how `markOrigin` shipped to git and never reached the running plugin.
 *
 * @param from - absolute source path.
 * @param to - absolute destination path.
 * @returns 'copied' when bytes changed, 'same' when they already matched.
 */
async function syncFile(from, to) {
  const source = await readFile(from).catch(() => undefined)
  if (source === undefined) return 'same'
  const existing = await readFile(to).catch(() => undefined)
  if (existing !== undefined && existing.equals(source)) return 'same'
  await mkdir(dirname(to), { recursive: true })
  await copyFile(from, to)
  return 'copied'
}

/**
 * Walk one directory, yielding paths relative to `root`.
 *
 * @param {string} root - the directory walked.
 * @param {string} prefix - path accumulated so far.
 * @returns {AsyncGenerator<string>}
 */
async function* walk(root, prefix = '') {
  const entries = await readdir(join(root, prefix), { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) yield* walk(root, rel)
    else yield rel
  }
}

let copied = 0
let present = 0

for (const entry of SHIP) {
  if (entry === 'lib') {
    for await (const rel of walk(join(here, 'lib'))) {
      const result = await syncFile(join(here, 'lib', rel), join(target, 'lib', rel))
      if (result === 'copied') copied += 1
      else present += 1
    }
    continue
  }
  const result = await syncFile(join(here, entry), join(target, entry))
  if (result === 'copied') copied += 1
  else present += 1
}

console.log(`同步到 ${target}`)
console.log(`  更新 ${copied} 个文件，${present} 个内容一致`)
if (copied === 0) console.log('  装的那份已经是最新的。')
else console.log('  现在重启 DSH 才会加载新文件。')
