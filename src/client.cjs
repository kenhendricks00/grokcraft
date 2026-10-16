// Talks to the daemon's loopback API.
const http = require('node:http')
const fs = require('node:fs')
const config = require('./config.cjs')
const {readToken} = require('./token.cjs')

class DaemonDown extends Error {}

function pidAlive() {
  let pid
  try { pid = Number(fs.readFileSync(config.files.pid, 'utf8')) } catch { return null }
  if (!pid) return null
  try { process.kill(pid, 0); return pid } catch (e) { return e.code === 'EPERM' ? pid : null }
}

function downMessage(port) {
  const pid = pidAlive()
  if (pid) return `grokcraft daemon (pid ${pid}) is not answering on 127.0.0.1:${port}; check ${config.files.log}`
  return `grokcraft daemon is not running. Start it with \`grokcraft start\` (log: ${config.files.log})`
}

function request(method, path, body, {timeoutMs = 30000} = {}) {
  const {apiPort} = config.load()
  const token = readToken()
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: apiPort, path, method,
      headers: {'Content-Type': 'application/json', 'x-grokcraft-token': token ?? ''}}, res => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', c => { raw += c })
      res.on('end', () => {
        let doc
        try { doc = JSON.parse(raw) } catch { return reject(new Error(`daemon returned invalid JSON (HTTP ${res.statusCode})`)) }
        if (res.statusCode === 503) return reject(new DaemonDown(doc.error))
        if (!doc.ok) return reject(Object.assign(new Error(doc.error ?? `HTTP ${res.statusCode}`), {status: res.statusCode}))
        delete doc.ok
        resolve(doc)
      })
      res.on('error', reject)
    })
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(new Error('daemon did not answer in time')))
    req.on('error', e => {
      if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(e.code)) {
        reject(new DaemonDown(e.code === 'ECONNREFUSED' ? downMessage(apiPort) : 'grokcraft daemon closed the connection (did it stop?)'))
      } else reject(e)
    })
    req.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

module.exports = {request, pidAlive, DaemonDown}
