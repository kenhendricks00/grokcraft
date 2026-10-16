// One physical action at a time. Starting a new action aborts the old one;
// replaced and explicitly stopped actions stay quiet, while finishing or
// failing on its own wakes the agent.

class ActionAborted extends Error {
  constructor(reason) { super(reason); this.name = 'ActionAborted'; this.reason = reason }
}

function createActions({inbox, halt}) {
  let nextId = 1
  let current = null
  let last = null

  const view = a => a && {id: a.id, kind: a.kind, args: a.args, status: a.status, startedAt: a.startedAt,
    ...(a.progress ? {progress: a.progress} : {}), ...(a.result ? {result: a.result} : {}), ...(a.error ? {error: a.error} : {})}

  async function settle(action, promise) {
    try {
      const result = await promise
      if (action.controller.signal.aborted) throw new ActionAborted(action.controller.signal.reason)
      action.status = 'finished'
      action.result = result ?? {}
      inbox.push('action_finished', {action: view(action)}, {wake: true})
    } catch (e) {
      const reason = action.controller.signal.aborted ? action.controller.signal.reason : null
      if (reason === 'replaced' || reason === 'stopped') {
        action.status = reason
        inbox.push(`action_${reason}`, {action: view(action)})
      } else {
        action.status = 'failed'
        action.error = reason ?? e?.message ?? String(e)
        inbox.push('action_failed', {action: view(action)}, {wake: true})
      }
    } finally {
      if (current === action) { current = null; await halt().catch(() => {}) }
      last = action
    }
  }

  // run(ctx) => Promise<result>. ctx.signal aborts; ctx.check() throws once aborted.
  async function start(kind, args, run) {
    if (current) await abort('replaced')
    const controller = new AbortController()
    const action = {id: nextId++, kind, args, status: 'running', startedAt: new Date().toISOString(), controller}
    const ctx = {
      signal: controller.signal,
      check() { if (controller.signal.aborted) throw new ActionAborted(controller.signal.reason) },
      progress(update) { action.progress = {...action.progress, ...update} },
      sleep(ms) {
        return new Promise((resolve, reject) => {
          if (controller.signal.aborted) return reject(new ActionAborted(controller.signal.reason))
          const timer = setTimeout(() => { controller.signal.removeEventListener('abort', onAbort); resolve() }, ms)
          const onAbort = () => { clearTimeout(timer); reject(new ActionAborted(controller.signal.reason)) }
          controller.signal.addEventListener('abort', onAbort, {once: true})
        })
      },
    }
    current = action
    // Defer so synchronous throws in run() are reported like any other failure.
    action.done = settle(action, Promise.resolve().then(() => run(ctx)))
    return view(action)
  }

  // reason: 'replaced' | 'stopped' (quiet) or any failure text (wakes).
  async function abort(reason) {
    const action = current
    if (!action) return null
    action.controller.abort(reason)
    await halt().catch(() => {})
    // The skill's own promise settles once the pathfinder/digging stops.
    await Promise.race([action.done, new Promise(r => setTimeout(r, 2000))])
    if (current === action) current = null
    return view(action)
  }

  return {
    start,
    stop: () => abort('stopped'),
    fail: reason => abort(reason),
    current: () => view(current),
    last: () => view(last),
  }
}

module.exports = {createActions, ActionAborted}
