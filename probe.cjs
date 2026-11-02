const fs = require('fs')
const b = fs.readFileSync('D:/APPS/DSH/resources/app.asar')
const hs = b.readUInt32LE(12)
const header = JSON.parse(b.slice(16, 16 + hs).toString('utf8'))
const base = 16 + hs
function find(node, path, target) {
  for (const [k, v] of Object.entries(node.files || {})) {
    if (v.files) { const r = find(v, path + '/' + k, target); if (r) return r }
    else if (path + '/' + k === target) return v
  }
  return null
}
function read(p) {
  const e = find(header, '', p)
  if (!e) return null
  return b.slice(base + Number(e.offset), base + Number(e.offset) + e.size).toString('utf8')
}
const t = read('/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js')
for (const key of ['presets', '.yaml', 'agents/', 'prompt', 'description']) {
  let i = t.indexOf(key)
  let n = 0
  while (i > 0 && n < 2) {
    console.log(`== ${key} #${n}:`, t.slice(Math.max(0, i - 120), i + 160).replace(/\s+/g, ' '))
    i = t.indexOf(key, i + 1)
    n++
  }
}
