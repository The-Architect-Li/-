const fs = require('fs')
const b = fs.readFileSync('D:/APPS/DSH/resources/app.asar')
const hs = b.readUInt32LE(12)
const header = JSON.parse(b.slice(16, 16 + hs).toString('utf8'))
const base = 16 + hs
const files = []
function walk(node, path) {
  for (const [k, v] of Object.entries(node.files || {})) {
    if (v.files) walk(v, path + '/' + k)
    else files.push({ path: path + '/' + k, off: Number(v.offset), size: v.size })
  }
}
walk(header, '')
const hits = []
for (const f of files) {
  if (!f.path.endsWith('.js') || f.size > 3e6) continue
  const t = b.slice(base + f.off, base + f.off + f.size).toString('utf8')
  if (t.includes("'subagents'") || t.includes('"subagents"')) hits.push(f.path)
}
console.log('提到 subagents 的包：')
console.log(hits.slice(0, 10).join('\n'))
