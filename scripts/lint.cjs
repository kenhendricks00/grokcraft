// Syntax-checks every source file with `node --check`.
const fs = require('node:fs')
const path = require('node:path')
const {spawnSync} = require('node:child_process')

const root = path.join(__dirname, '..')
const targets = [path.join(root, 'bin', 'grokcraft')]
for (const dir of ['src', 'test', 'scripts']) {
  for (const name of fs.readdirSync(path.join(root, dir))) if (name.endsWith('.cjs')) targets.push(path.join(root, dir, name))
}
let failed = 0
for (const file of targets) {
  const result = spawnSync(process.execPath, ['--check', file], {encoding: 'utf8'})
  if (result.status !== 0) { failed++; process.stderr.write(result.stderr) }
}
console.log(`checked ${targets.length} files, ${failed} failed`)
process.exitCode = failed ? 1 : 0
