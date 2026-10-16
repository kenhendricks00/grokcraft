// Shared locations and settings for the CLI and the daemon.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const home = process.env.GROKCRAFT_HOME || path.join(os.homedir(), '.grokcraft')
const files = {
  home,
  config: path.join(home, 'config.json'),
  pid: path.join(home, 'daemon.pid'),
  log: path.join(home, 'daemon.log'),
  token: path.join(home, 'token'),
  inbox: path.join(home, 'inbox.json'),
  auth: path.join(home, 'auth'),
}

const DEFAULTS = {
  host: 'localhost',
  port: 25565,
  username: 'Grok',
  auth: 'offline',
  owner: null,
  version: 'auto',
  apiPort: 3017,
}

function ensureHome() {
  fs.mkdirSync(home, {recursive: true, mode: 0o700})
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    if (e.code === 'ENOENT') return fallback
    throw new Error(`cannot read ${file}: ${e.message}`)
  }
}

function writeJson(file, value) {
  ensureHome()
  fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n', {mode: 0o600})
  fs.renameSync(file + '.tmp', file)
}

// Saved settings, then environment, then defaults.
function load() {
  const saved = readJson(files.config, {})
  const env = {}
  if (process.env.GROKCRAFT_API_PORT) env.apiPort = Number(process.env.GROKCRAFT_API_PORT)
  return {...DEFAULTS, ...saved, ...env}
}

module.exports = {files, DEFAULTS, ensureHome, readJson, writeJson, load}
