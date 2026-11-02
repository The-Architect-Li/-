const fs = require('fs')
const b = fs.readFileSync('D:/APPS/DSH/resources/app.asar')
const hs = b.readUInt32LE(12)
const header = JSON.parse(b.slice(16, 16 + hs).toString('utf8'))
const base = 16 + hs
function read(p) {
  function find(node, path) {
    for (const [k, v] of Object.entries(node.files || {})) {
      if (v.files) { const r = find(v, path + '/' + k); if (r) return r }
      else if (path + '/' + k === p) return v
    }
    return null
  }
  const e = find(header, '')
  if (!e) return null
  return b.slice(base + Number(e.offset), base + Number(e.offset) + e.size).toString('utf8')
}
const t = read('/dsh/node_modules/@deepseek-ai/dsh-client-ui-agent-preset/lib/client.js')
console.log('长度', t?.length)
for (const key of ['service(', 'Service', 'newSession', 'createSession', 'switchTo', 'select']) {
  let i = t.indexOf(key), n = 0
  while (i > 0 && n < 2) {
    console.log(`== ${key}:`, t.slice(Math.max(0, i - 90), i + 150).replace(/\s+/g, ' '))
    i = t.indexOf(key, i + 1); n++
  }
}
