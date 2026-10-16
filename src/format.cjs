// Human-readable rendering of daemon responses. `--json` skips all of this.

const clock = iso => new Date(iso).toTimeString().slice(0, 8)
const xyz = p => (Array.isArray(p) ? p.map(n => Math.round(n)).join(' ') : '?')
const compact = value => JSON.stringify(value).replace(/"(\w+)":/g, '$1:')

function actionLine(a) {
  if (!a) return 'none'
  const args = Object.entries(a.args ?? {}).map(([k, v]) => `${k}=${Array.isArray(v) ? `[${v}]` : v}`).join(' ')
  return `#${a.id} ${a.kind}${args ? ' ' + args : ''} (${a.status})`
}

function event(e) {
  const head = `${e.wake ? '!' : ' '} #${e.seq} ${clock(e.time)}`
  const a = e.action
  const body = {
    chat: () => `<${e.from}> ${e.text}${e.owner ? '  [owner]' : ''}${e.mention ? '  [mentions you]' : ''}`,
    whisper: () => `<${e.from} whispers> ${e.text}${e.owner ? '  [owner]' : ''}`,
    damaged: () => `took ${e.amount} damage, health ${e.health}/20, food ${e.food}/20` + (e.near ? `; nearest: ${e.near.name} at ${e.near.distance}m` : ''),
    died: () => `died at ${xyz(e.position)}${e.dimension ? ' in ' + e.dimension : ''} (respawning)`,
    respawned: () => `respawned at ${xyz(e.position)}`,
    connected: () => `joined ${e.server} as ${e.username} (Minecraft ${e.version}) at ${xyz(e.position)}`,
    disconnected: () => `disconnected: ${e.reason}; reconnecting`,
    kicked: () => `kicked: ${e.reason}`,
    auth_required: () => e.message,
    owner_joined: () => `owner ${e.player} joined`,
    owner_left: () => `owner ${e.player} left`,
    action_finished: () => `action ${actionLine(a)}: ${compact(a.result ?? {})}`,
    action_failed: () => `action ${actionLine(a)}: ${a.error}`,
    action_replaced: () => `action ${actionLine(a)}`,
    action_stopped: () => `action ${actionLine(a)}`,
  }[e.kind]
  return `${head} ${e.kind.padEnd(15)} ${body ? body() : compact(e)}`
}

function events(list, gap) {
  const lines = []
  if (gap) lines.push(`  (events #${gap.from}-#${gap.through} were dropped before being read)`)
  for (const e of list) lines.push(event(e))
  return lines.join('\n')
}

function statusLine(s) {
  const c = s.connection
  let where = c.state
  if (c.state === 'online') where = `online at ${xyz(s.position)}, health ${s.health}/20, food ${s.food}/20`
  else if (c.state === 'reconnecting') where = `reconnecting in ${c.retryIn}s${c.lastError ? ` (${c.lastError})` : ''}`
  else if (c.lastError) where += ` (${c.lastError})`
  if (c.auth) where += `; ${c.auth}`
  const owner = s.ownerSeen
  const ownerText = owner ? (owner.visible ? `, owner ${owner.name} ${owner.distance}m away` : owner.online ? `, owner ${owner.name} out of sight` : `, owner ${owner.name} offline`) : ''
  return `[${s.username} @ ${s.server}: ${where}; action ${actionLine(s.action)}${ownerText}${s.unread ? `; ${s.unread} unread event(s)` : ''}]`
}

function status(s) {
  return [
    `daemon     pid ${s.pid}, up ${s.uptime}s, API 127.0.0.1:${s.apiPort}`,
    `server     ${s.server} (${s.auth} auth, Minecraft ${s.version})`,
    `bot        ${s.username}, owner ${s.owner ?? '(none set)'}`,
    `connection ${statusLine(s)}`,
  ].join('\n')
}

function state(s) {
  const lines = [statusLine(s)]
  if (s.connection.state !== 'online') {
    if (s.lastAction) lines.push(`last action: ${actionLine(s.lastAction)}`)
    return lines.join('\n')
  }
  lines.push(
    `dimension ${s.dimension}, ${s.gameMode}, time ${s.time ? `${s.time.phase} (${s.time.ticks})` : '?'}`,
    `health ${s.health}/20, food ${s.food}/20 (saturation ${s.saturation}), standing on ${s.standingOn}, holding ${s.heldItem ?? 'nothing'}`,
  )
  const o = s.ownerSeen
  if (o) lines.push(`owner ${o.name}: ${o.visible ? `at ${xyz(o.position)}, ${o.distance}m` : o.online ? 'online, out of sight' : 'offline'}`)
  lines.push(`action: ${actionLine(s.action)}${s.action?.progress ? ' ' + compact(s.action.progress) : ''}`)
  if (s.lastAction) lines.push(`last action: ${actionLine(s.lastAction)}${s.lastAction.error ? ': ' + s.lastAction.error : s.lastAction.result ? ': ' + compact(s.lastAction.result) : ''}`)
  lines.push(`players online: ${s.players.join(', ') || 'none'}`)
  lines.push(`nearby: ${s.nearby.map(e => `${e.name}(${e.type}) ${e.distance}m`).join(', ') || 'nothing'}`)
  const inv = Object.entries(s.inventory)
  lines.push(`inventory: ${inv.map(([n, c]) => `${n} x${c}`).join(', ') || 'empty'}`)
  return lines.join('\n')
}

function inventory(inv) {
  const lines = inv.items.length ? inv.items.map(i => `  slot ${String(i.slot).padStart(2)}  ${i.name} x${i.count}`) : ['  (empty)']
  lines.push(`held: ${inv.held ?? 'nothing'}; free slots: ${inv.freeSlots}`)
  const eq = Object.entries(inv.equipped)
  if (eq.length) lines.push(`equipped: ${eq.map(([k, v]) => `${k} ${v}`).join(', ')}`)
  return lines.join('\n')
}

module.exports = {event, events, statusLine, status, state, inventory, actionLine}
