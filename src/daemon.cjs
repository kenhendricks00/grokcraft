// The controller daemon: owns the Minecraft connection, reconnects, records
// events in the durable inbox and serves a loopback JSON API for the CLI.
// Usually started by `grokcraft start`; `node src/daemon.cjs` runs it in the
// foreground with the saved settings.
const http = require('node:http')
const fs = require('node:fs')
const mineflayer = require('mineflayer')
const {pathfinder} = require('mineflayer-pathfinder')
const {plugin: toolPlugin} = require('mineflayer-tool')
const {plugin: collectBlock} = require('mineflayer-collectblock')
const config = require('./config.cjs')
const {readToken} = require('./token.cjs')
const {createInbox} = require('./inbox.cjs')
const {createActions} = require('./actions.cjs')
const skills = require('./skills.cjs')

const {files} = config
config.ensureHome()
const cfg = config.load()
const token = readToken({create: true})
const startedAt = Date.now()

function log(...parts) {
  console.log(new Date().toISOString(), ...parts)
}

const inbox = createInbox({file: files.inbox})
let bot = null
let shuttingDown = false
const life = new AbortController() // aborted on shutdown; ends long polls
let reconnectTimer = null
const conn = {state: 'starting', attempts: 0, since: Date.now(), lastError: null, lastKick: null, auth: null}
const setState = state => { conn.state = state; conn.since = Date.now() }

const sameName = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase()
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const round = n => Math.round(n * 10) / 10
const posOf = p => p && [round(p.x), round(p.y), round(p.z)]
const text = reason => {
  if (typeof reason === 'string') {
    try { return text(JSON.parse(reason)) } catch { return reason }
  }
  if (reason && typeof reason === 'object') {
    if (typeof reason.toString === 'function' && reason.toString !== Object.prototype.toString) return String(reason)
    return [reason.text, reason.translate, ...(reason.extra ?? []).map(text)].filter(Boolean).join('') || JSON.stringify(reason)
  }
  return String(reason)
}

async function halt() {
  const b = bot
  if (!b) return
  try { b.pathfinder?.setGoal(null) } catch {}
  try { b.pathfinder?.stop() } catch {}
  try { b.stopDigging() } catch {}
  try { b.clearControlStates() } catch {}
  try { await Promise.race([b.collectBlock?.cancelTask(), new Promise(r => setTimeout(r, 1500))]) } catch {}
}
const actions = createActions({inbox, halt})

// --- connection -------------------------------------------------------------

function scheduleReconnect(b, why) {
  if (b !== bot || b._grokcraftEnded || shuttingDown) return
  b._grokcraftEnded = true
  const wasOnline = conn.state === 'online'
  setState('reconnecting')
  conn.lastError = why
  if (actions.current()) actions.fail(`disconnected: ${why}`)
  if (wasOnline) inbox.push('disconnected', {reason: why})
  const delay = Math.min(60000, 2000 * 2 ** Math.min(conn.attempts - 1, 5))
  conn.retryAt = Date.now() + delay
  log(`disconnected (${why}); reconnecting in ${delay / 1000}s`)
  reconnectTimer = setTimeout(connect, delay)
}

function connect() {
  reconnectTimer = null
  if (shuttingDown) return
  conn.attempts++
  conn.lastKick = null
  setState('connecting')
  log(`connecting to ${cfg.host}:${cfg.port} as ${cfg.username} (${cfg.auth}, version ${cfg.version}, attempt ${conn.attempts})`)
  const b = mineflayer.createBot({
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    auth: cfg.auth,
    version: !cfg.version || cfg.version === 'auto' ? false : cfg.version,
    profilesFolder: files.auth,
    hideErrors: true,
    onMsaCode: data => {
      const message = `Microsoft sign-in needed: open ${data.verification_uri} and enter code ${data.user_code}`
      conn.auth = {url: data.verification_uri, code: data.user_code, message}
      log(message)
      inbox.push('auth_required', {message, url: data.verification_uri, code: data.user_code}, {wake: true})
    },
  })
  bot = b
  b.loadPlugin(pathfinder)
  b.loadPlugin(toolPlugin)
  b.loadPlugin(collectBlock)

  let spawned = false
  let lastHealth = null
  let quietUntil = 0
  let dead = false

  b.on('spawn', () => {
    lastHealth = b.health
    if (dead) {
      dead = false
      inbox.push('respawned', {position: posOf(b.entity.position)})
      return
    }
    if (spawned) return
    spawned = true
    quietUntil = Date.now() + 5000 // the initial player list is not "joining"
    conn.attempts = 0
    conn.auth = null
    conn.lastError = null
    setState('online')
    log(`spawned as ${b.username} on Minecraft ${b.version} at ${posOf(b.entity.position)}`)
    inbox.push('connected', {server: `${cfg.host}:${cfg.port}`, username: b.username, version: b.version, position: posOf(b.entity.position)})
  })

  b.on('health', () => {
    if (lastHealth != null && b.health > 0 && b.health < lastHealth - 0.01) {
      const amount = round(lastHealth - b.health)
      const near = nearestThreat(b, 6)
      const fields = {amount, health: round(b.health), food: b.food, ...(near ? {near} : {})}
      inbox.pushOrMerge('damaged', fields, {wake: true},
        last => Date.now() - Date.parse(last.time) < 1500 ? {...fields, amount: round(last.amount + amount)} : null)
    }
    lastHealth = b.health
  })

  b.on('death', () => {
    dead = true
    const position = posOf(b.entity?.position)
    log(`died at ${position}`)
    if (actions.current()) actions.fail('bot died')
    inbox.push('died', {position, dimension: b.game?.dimension}, {wake: true})
  })

  b.on('chat', (username, message) => {
    if (!username || sameName(username, b.username)) return
    const owner = sameName(username, cfg.owner)
    const mention = new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(b.username)}($|[^A-Za-z0-9_])`, 'i').test(message)
    inbox.push('chat', {from: username, text: message, owner, mention}, {wake: owner || mention})
  })
  b.on('whisper', (username, message) => {
    if (!username || sameName(username, b.username)) return
    inbox.push('whisper', {from: username, text: message, owner: sameName(username, cfg.owner)}, {wake: true})
  })
  b.on('playerJoined', player => {
    if (Date.now() > quietUntil && sameName(player.username, cfg.owner)) inbox.push('owner_joined', {player: player.username}, {wake: true})
  })
  b.on('playerLeft', player => {
    if (sameName(player.username, cfg.owner)) inbox.push('owner_left', {player: player.username}, {wake: true})
  })

  b.on('kicked', reason => {
    const why = text(reason)
    conn.lastKick = why
    log(`kicked: ${why}`)
    inbox.push('kicked', {reason: why}, {wake: true})
  })
  b.on('error', e => {
    conn.lastError = e.code || e.message || String(e)
    log(`error: ${conn.lastError}`)
    // Connection failures before spawn do not always emit 'end'.
    if (!spawned) setTimeout(() => scheduleReconnect(b, conn.lastError), 1000)
  })
  b.on('end', reason => scheduleReconnect(b, !spawned && (conn.lastKick || conn.lastError) ? conn.lastKick || conn.lastError : text(reason ?? 'connection closed')))
}

// --- views ------------------------------------------------------------------

function nearestThreat(b, radius) {
  const me = b.entity?.position
  if (!me) return null
  let best = null
  for (const e of Object.values(b.entities)) {
    if (e === b.entity || !['hostile', 'player', 'mob'].includes(e.type)) continue
    const d = e.position.distanceTo(me)
    if (d <= radius && (!best || d < best.d)) best = {d, e}
  }
  return best && {name: best.e.username ?? best.e.name, type: best.e.type, distance: round(best.d)}
}

function online() { return conn.state === 'online' && bot?.entity }

function ownerView(b) {
  if (!cfg.owner) return null
  const player = skills.findPlayer(b, cfg.owner)
  if (!player) return {name: cfg.owner, online: false}
  const e = player.entity
  return {name: player.username, online: true, visible: !!e,
    ...(e ? {position: posOf(e.position), distance: round(e.position.distanceTo(b.entity.position))} : {})}
}

function status() {
  const b = bot
  return {
    pid: process.pid,
    uptime: Math.round((Date.now() - startedAt) / 1000),
    server: `${cfg.host}:${cfg.port}`,
    username: b?.username ?? cfg.username,
    auth: cfg.auth,
    owner: cfg.owner,
    version: b?.version ?? (cfg.version || 'auto'),
    apiPort: cfg.apiPort,
    connection: {state: conn.state, for: Math.round((Date.now() - conn.since) / 1000),
      ...(conn.state !== 'online' && conn.lastError ? {lastError: conn.lastError} : {}),
      ...(conn.state === 'reconnecting' ? {retryIn: Math.max(0, Math.round((conn.retryAt - Date.now()) / 1000))} : {}),
      ...(conn.auth ? {auth: conn.auth.message} : {})},
    ...(online() ? {health: round(b.health), food: b.food, position: posOf(b.entity.position)} : {}),
    ...(online() && cfg.owner ? {ownerSeen: ownerView(bot)} : {}),
    action: actions.current(),
    unread: inbox.unreadCount(),
  }
}

function state() {
  const s = status()
  if (!online()) return {...s, lastAction: actions.last()}
  const b = bot
  const me = b.entity.position
  const nearby = Object.values(b.entities)
    .filter(e => e !== b.entity && e.position.distanceTo(me) <= 24 && ['player', 'hostile', 'mob', 'animal', 'passive'].includes(e.type))
    .map(e => ({name: e.username ?? e.name, type: e.type, id: e.id, distance: round(e.position.distanceTo(me)), position: posOf(e.position)}))
    .sort((a, c) => a.distance - c.distance).slice(0, 16)
  const time = b.time?.timeOfDay
  return {
    ...s,
    dimension: b.game?.dimension,
    gameMode: b.game?.gameMode,
    saturation: round(b.foodSaturation ?? 0),
    oxygen: b.oxygenLevel,
    time: time == null ? null : {ticks: time, phase: time < 12000 ? 'day' : time < 13800 ? 'dusk' : time < 22200 ? 'night' : 'dawn'},
    heldItem: b.heldItem ? `${b.heldItem.name} x${b.heldItem.count}` : null,
    standingOn: b.blockAt(b.entity.position.offset(0, -1, 0))?.name ?? null,
    players: Object.values(b.players).map(p => p.username).filter(n => n !== b.username),
    nearby,
    lastAction: actions.last(),
    inventory: skills.counts(b),
  }
}

function inventory() {
  const b = bot
  const slotNames = {5: 'head', 6: 'chest', 7: 'legs', 8: 'feet', 45: 'offhand'}
  const items = b.inventory.items().map(i => ({slot: i.slot, name: i.name, count: i.count}))
  const equipped = {}
  for (const [slot, name] of Object.entries(slotNames)) { const i = b.inventory.slots[slot]; if (i) equipped[name] = i.name }
  return {items, totals: skills.counts(b), held: b.heldItem?.name ?? null, equipped,
    freeSlots: b.inventory.emptySlotCount()}
}

// --- API ----------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status }
}

function needOnline() {
  if (online()) return bot
  const why = conn.auth ? conn.auth.message : conn.lastError ? `last error: ${conn.lastError}` : ''
  throw new ApiError(409, `bot is not in the world (connection ${conn.state}${why ? '; ' + why : ''})`)
}

const ACTIONS = {follow: skills.follow, come: skills.come, goto: skills.goto, farm: skills.farm, collect: skills.collect}

async function startAction(kind, args = {}) {
  const skill = ACTIONS[kind]
  if (!skill) throw new ApiError(400, `unknown action ${kind}`)
  const b = needOnline()
  let run
  try { run = skill(b, args, {owner: cfg.owner}) } catch (e) { throw new ApiError(422, e.message) }
  const replaced = actions.current()
  const action = await actions.start(kind, args, run)
  return {action, ...(replaced ? {replaced} : {})}
}

function chat(message) {
  const b = needOnline()
  const textValue = String(message ?? '').trim()
  if (!textValue) throw new ApiError(400, 'text must not be empty')
  // Servers reject chat packets over 256 characters.
  const parts = textValue.match(/[\s\S]{1,250}(\s|$)|[\s\S]{1,250}/g).map(p => p.trim()).filter(Boolean)
  for (const part of parts) b.chat(part)
  return {sent: parts}
}

async function standby(timeoutSec, signal) {
  const timeout = Math.min(3600, Math.max(1, Number(timeoutSec) || 300)) * 1000
  const result = await inbox.standby(timeout, signal)
  if (shuttingDown) throw new ApiError(503, 'daemon is shutting down')
  return {...result, timeout: timeout / 1000, status: status()}
}

async function shutdown(why) {
  if (shuttingDown) return
  shuttingDown = true
  life.abort()
  log(`shutting down (${why})`)
  clearTimeout(reconnectTimer)
  await actions.stop().catch(() => {})
  inbox.stop()
  try { bot?.quit('grokcraft stopped') } catch {}
  server.close()
  try { if (Number(fs.readFileSync(files.pid, 'utf8')) === process.pid) fs.unlinkSync(files.pid) } catch {}
  setTimeout(() => process.exit(0), 500).unref()
}

const routes = {
  'GET /status': () => status(),
  'GET /state': () => state(),
  'GET /inventory': () => { needOnline(); return inventory() },
  'GET /events': ({query}) => query.get('all') === '1'
    ? {events: inbox.history(Number(query.get('limit')) || 50)}
    : inbox.take(Number(query.get('limit')) || undefined),
  'GET /standby': ({query, signal}) => standby(query.get('timeout'), signal),
  'POST /action': ({body}) => startAction(body.kind, body.args),
  'POST /chat': ({body}) => chat(body.text),
  'POST /stop-action': async () => ({stopped: await actions.stop()}),
  'POST /shutdown': () => { setTimeout(() => shutdown('requested'), 50); return {stopping: true, pid: process.pid} },
}

const server = http.createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => { raw += chunk; if (raw.length > 64 * 1024) req.destroy() })
  req.on('end', async () => {
    const reply = (code, value) => {
      if (res.writableEnded || res.destroyed) return
      res.writeHead(code, {'Content-Type': 'application/json'})
      res.end(JSON.stringify(value))
    }
    try {
      if (req.headers['x-grokcraft-token'] !== token) throw new ApiError(401, 'bad or missing token (see ~/.grokcraft/token)')
      const url = new URL(req.url, 'http://127.0.0.1')
      const route = routes[`${req.method} ${url.pathname}`]
      if (!route) throw new ApiError(404, `no route ${req.method} ${url.pathname}`)
      let body = {}
      if (raw) { try { body = JSON.parse(raw) } catch { throw new ApiError(400, 'body must be JSON') } }
      const gone = new AbortController()
      res.on('close', () => gone.abort())
      life.signal.addEventListener('abort', () => gone.abort(), {once: true})
      reply(200, {ok: true, ...(await route({body, query: url.searchParams, signal: gone.signal}))})
    } catch (e) {
      if (!(e instanceof ApiError)) log(`request ${req.method} ${req.url} failed: ${e.stack || e}`)
      reply(e.status ?? 500, {ok: false, error: e.message})
    }
  })
})
server.requestTimeout = 0 // standby is a long poll

server.on('error', e => {
  log(e.code === 'EADDRINUSE' ? `port ${cfg.apiPort} is already in use; set another with \`grokcraft start apiPort=N\`` : `api error: ${e.message}`)
  process.exit(1)
})
server.listen(cfg.apiPort, '127.0.0.1', () => {
  fs.writeFileSync(files.pid, String(process.pid), {mode: 0o600})
  log(`grokcraft daemon ${process.pid} listening on 127.0.0.1:${cfg.apiPort}`)
  connect()
})

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('uncaughtException', e => log(`uncaught: ${e.stack || e}`))
process.on('unhandledRejection', e => log(`unhandled rejection: ${e?.stack || e}`))
