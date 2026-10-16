// Durable event inbox. Every event gets a sequence number and is written to
// disk before anyone is told about it; a read cursor records what the agent has
// already seen, so events survive daemon restarts and are delivered once.
// `wake` marks events that need a decision; standby returns only for those.
const fs = require('node:fs')

const MAX_EVENTS = 500

function createInbox({file, now = Date.now, batchMs = 300} = {}) {
  let doc = {seq: 0, cursor: 0, events: []}
  if (file) {
    try { doc = {...doc, ...JSON.parse(fs.readFileSync(file, 'utf8'))} } catch (e) {
      if (e.code !== 'ENOENT') {
        // A corrupt inbox must not keep the daemon down; keep a copy and start over.
        try { fs.renameSync(file, `${file}.corrupt-${now()}`) } catch {}
      }
    }
  }
  const waiters = new Set()

  function save() {
    if (!file) return
    fs.writeFileSync(file + '.tmp', JSON.stringify(doc), {mode: 0o600})
    fs.renameSync(file + '.tmp', file)
  }
  function notify() { for (const w of waiters) w(); waiters.clear() }

  function push(kind, data = {}, {wake = false} = {}) {
    const event = {seq: ++doc.seq, time: new Date(now()).toISOString(), kind, wake: !!wake, ...data}
    doc.events.push(event)
    if (doc.events.length > MAX_EVENTS) {
      const dropped = doc.events.splice(0, doc.events.length - MAX_EVENTS)
      // Never imply the retained list is complete when unread events fell off.
      const lost = dropped.filter(e => e.seq > doc.cursor)
      if (lost.length) doc.gap = {from: doc.gap?.from ?? lost[0].seq, through: lost.at(-1).seq}
    }
    save(); notify()
    return event
  }

  // Merge into the latest unread event of the same kind when `merge` returns a
  // replacement (e.g. several hits of damage within a second), else push.
  function pushOrMerge(kind, data, opts, merge) {
    const last = doc.events.at(-1)
    if (last && last.kind === kind && last.seq > doc.cursor) {
      const merged = merge(last)
      if (merged) {
        Object.assign(last, merged, {time: new Date(now()).toISOString()})
        save(); notify()
        return last
      }
    }
    return push(kind, data, opts)
  }

  const unread = () => doc.events.filter(e => e.seq > doc.cursor)
  const hasWaking = () => doc.events.some(e => e.seq > doc.cursor && e.wake)

  // Returns unread events and marks them read.
  function take(limit = MAX_EVENTS) {
    const events = unread().slice(0, limit)
    const gap = doc.gap
    if (events.length) doc.cursor = events.at(-1).seq
    if (gap && gap.through <= doc.cursor) delete doc.gap
    if (events.length || gap) save()
    return {events, ...(gap ? {gap} : {})}
  }

  function changed(ms) {
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); waiters.delete(done); resolve() }
      const timer = setTimeout(done, ms)
      waiters.add(done)
    })
  }

  // Resolves with {woke:true, events} once a waking event is unread, after a
  // short batching window so related events (damage then death) arrive together.
  // Resolves {woke:false, events:[]} on timeout or abort; nothing is consumed then.
  async function standby(timeoutMs, signal) {
    const deadline = now() + timeoutMs
    for (;;) {
      if (signal?.aborted) return {woke: false, events: [], aborted: true}
      if (hasWaking()) {
        await changed(batchMs)
        const batch = take()
        if (batch.events.length) return {woke: true, ...batch}
        continue // another standby took them first
      }
      const left = deadline - now()
      if (left <= 0) return {woke: false, events: []}
      await changed(Math.min(left, 1000))
    }
  }

  return {
    push, pushOrMerge, unread, hasWaking, take, standby,
    history: (limit = MAX_EVENTS) => doc.events.slice(-limit),
    unreadCount: () => unread().length,
    stop: notify,
  }
}

module.exports = {createInbox, MAX_EVENTS}
