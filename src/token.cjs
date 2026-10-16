// A per-install secret so other local users cannot drive the bot through the
// loopback API.
const fs = require('node:fs')
const crypto = require('node:crypto')
const {files, ensureHome} = require('./config.cjs')

function readToken({create = false} = {}) {
  try { return fs.readFileSync(files.token, 'utf8').trim() } catch (e) {
    if (e.code !== 'ENOENT' || !create) return null
  }
  ensureHome()
  const token = crypto.randomBytes(24).toString('hex')
  fs.writeFileSync(files.token, token + '\n', {mode: 0o600})
  return token
}

module.exports = {readToken}
