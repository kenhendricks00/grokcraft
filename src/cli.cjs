// `grokcraft <command> [key=value ...]`: one command per decision.
const fs = require('node:fs')
const path = require('node:path')
const {spawn} = require('node:child_process')
const args = require('./args.cjs')
const config = require('./config.cjs')
const format = require('./format.cjs')
const {readToken} = require('./token.cjs')
const {request, pidAlive, DaemonDown} = require('./client.cjs')

const {files} = config
const sleep = ms => new Promise(r => setTimeout(r, ms))
const PHYSICAL = ['follow', 'come', 'goto', 'farm', 'collect']

async function tryStatus() {
  try { return await request('GET', '/status', undefined, {timeoutMs: 3000}) } catch (e) {
    if (e instanceof DaemonDown) return null
    throw e
  }
}

function tail(file, lines) {
  try { return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n') } catch { return '' }
}

async function start(opts, out) {
  const running = await tryStatus()
  if (running) {
    out(`grokcraft daemon is already running (pid ${running.pid}).` +
      (Object.keys(opts).length ? ' Settings were not changed; run `grokcraft stop` first to change them.' : ''))
    return running
  }
  if (pidAlive()) throw new Error(`a grokcraft daemon (pid ${pidAlive()}) is running but not answering; check ${files.log} or kill it`)
  const settings = {...config.readJson(files.config, {}), ...opts}
  config.writeJson(files.config, settings)
  readToken({create: true})
  const effective = config.load()
  if (!effective.owner) out('note: no owner set; only chat naming the bot will wake standby. Set one with `grokcraft start owner=NAME`.')
  const log = fs.openSync(files.log, 'a', 0o600)
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.cjs')], {detached: true, stdio: ['ignore', log, log], env: process.env})
  let exited = null
  child.on('exit', code => { exited = code })
  child.unref()
  fs.closeSync(log)

  let status = null
  for (let i = 0; i < 100 && exited === null; i++) {
    status = await tryStatus()
    if (status?.connection.state === 'online' || status?.connection.auth) break
    if (status && i >= 40) break // API is up; the server is just slow
    await sleep(200)
  }
  if (exited !== null || !status) {
    throw new Error(`daemon failed to start${exited !== null ? ` (exit code ${exited})` : ''}. Last log lines from ${files.log}:\n${tail(files.log, 15)}`)
  }
  out(`Started grokcraft daemon (pid ${status.pid}), API on 127.0.0.1:${status.apiPort}, log ${files.log}`)
  if (status.connection.state !== 'online') out(`Still connecting to ${status.server}; check \`grokcraft status\` in a moment.`)
  return status
}

async function stop(out) {
  const pid = pidAlive()
  try {
    await request('POST', '/shutdown', {}, {timeoutMs: 5000})
  } catch (e) {
    if (!(e instanceof DaemonDown)) throw e
    if (!pid) { out('grokcraft daemon is not running.'); return {stopped: false} }
    process.kill(pid, 'SIGTERM')
  }
  for (let i = 0; i < 50 && pidAlive(); i++) await sleep(100)
  if (pidAlive()) throw new Error(`daemon (pid ${pidAlive()}) did not exit; check ${files.log}`)
  out('grokcraft daemon stopped.')
  return {stopped: true}
}

async function run(argv, {out = console.log} = {}) {
  const {command, args: input, flags} = args.parse(argv)
  const print = (value, render) => out(flags.json ? JSON.stringify(value, null, 2) : render(value))
  switch (command) {
    case 'help': return out(args.help(input.topic))
    case 'start': {
      const result = await start(input, flags.json ? () => {} : out)
      if (flags.json) out(JSON.stringify(result, null, 2))
      else out(format.statusLine(result))
      return
    }
    case 'stop':
    case 'shutdown': {
      const result = await stop(flags.json ? () => {} : out)
      if (flags.json) out(JSON.stringify(result))
      return
    }
    case 'status': return print(await request('GET', '/status'), format.status)
    case 'state': return print(await request('GET', '/state'), format.state)
    case 'inventory': return print(await request('GET', '/inventory'), format.inventory)
    case 'events': {
      const query = new URLSearchParams()
      if (input.all) query.set('all', '1')
      if (input.limit) query.set('limit', String(input.limit))
      const result = await request('GET', `/events?${query}`)
      return print(result, r => r.events.length ? format.events(r.events, r.gap) : (input.all ? 'No events recorded.' : 'No unread events.'))
    }
    case 'standby': {
      const result = await request('GET', `/standby?timeout=${input.timeout}`, undefined, {timeoutMs: (input.timeout + 60) * 1000})
      return print(result, r => r.woke
        ? `Minecraft needs you:\n${format.events(r.events, r.gap)}\n${format.statusLine(r.status)}`
        : `Nothing needed you in ${r.timeout}s. Run standby again to keep waiting.\n${format.statusLine(r.status)}`)
    }
    case 'chat': return print(await request('POST', '/chat', {text: input.text}), r => `Said: ${r.sent.join(' / ')}`)
    case 'stop-action': return print(await request('POST', '/stop-action', {}),
      r => r.stopped ? `Stopped action ${format.actionLine({...r.stopped, status: 'stopped'})}.` : 'No action was running.')
    default:
      if (PHYSICAL.includes(command)) {
        const result = await request('POST', '/action', {kind: command, args: input})
        return print(result, r => [
          `Started action ${format.actionLine(r.action)}${r.replaced ? `, replacing ${format.actionLine({...r.replaced, status: 'replaced'})}` : ''}.`,
          command === 'follow' ? 'It keeps going until replaced or stopped; standby wakes you if it fails.'
            : 'Run `grokcraft standby` to wait for the outcome.',
        ].join('\n'))
      }
      throw new Error(`command ${command} is not implemented`)
  }
}

async function main(argv = process.argv.slice(2)) {
  try {
    await run(argv)
  } catch (e) {
    console.error(`grokcraft: ${e.message}`)
    process.exitCode = e instanceof args.UsageError ? 2 : e instanceof DaemonDown ? 3 : 1
  }
}

module.exports = {run, main}
