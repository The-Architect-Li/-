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
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const profile = process.env.DSH_PROFILE ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const target = join(profile, 'node_modules', 'dsh-inkwell')

/** Every file worth shipping, relative to the package root. */
const SHIP = ['lib', 'client.js', 'README.md', 'README.zh.md']

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

async function exists(path) {
  return await stat(path).then(() => true).catch(() => false)
}

let copied = 0
let present = 0

for (const entry of SHIP) {
  if (entry === 'lib') {
    for await (const rel of walk(join(here, 'lib'))) {
      const to = join(target, 'lib', rel)
      if (await exists(to)) {
        present += 1
        continue
      }
      await mkdir(dirname(to), { recursive: true })
      await copyFile(join(here, 'lib', rel), to)
      copied += 1
    }
    continue
  }
  const to = join(target, entry)
  if (await exists(to)) {
    present += 1
    continue
  }
  await mkdir(dirname(to), { recursive: true })
  await copyFile(join(here, entry), to)
  copied += 1
}

console.log(`同步到 ${target}`)
console.log(`  补齐 ${copied} 个文件，${present} 个已存在（硬链接，自动同步）`)
if (copied === 0) console.log('  没有缺失——装的那份和开发目录一致。')
else console.log('  现在重启 DSH 才会加载新文件。')
