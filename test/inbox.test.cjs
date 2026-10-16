// The event inbox is plain Node: durable, read-once, and standby wakes only
// for events that need a decision.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {createInbox} = require('../src/inbox.cjs')

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'grokcraft-')), 'inbox.json')

test('events survive a restart and are read once', () => {
  const file = tmpFile()
  const first = createInbox({file})
  first.push('chat', {from: 'Steve', text: 'hi'}, {wake: true})
  first.push('connected', {})
  const second = createInbox({file})
  assert.equal(second.unreadCount(), 2)
  assert.deepEqual(second.take().events.map(e => e.kind), ['chat', 'connected'])
  assert.equal(createInbox({file}).unreadCount(), 0)
  assert.equal(createInbox({file}).push('died').seq, 3)
})

test('standby ignores quiet events and wakes for waking ones', async () => {
  const inbox = createInbox({batchMs: 10})
  inbox.push('connected')
  const quiet = await inbox.standby(50)
  assert.equal(quiet.woke, false)
  assert.equal(inbox.unreadCount(), 1, 'a timed-out standby consumes nothing')
  setTimeout(() => inbox.push('action_finished', {}, {wake: true}), 20)
  const woke = await inbox.standby(2000)
  assert.equal(woke.woke, true)
  assert.deepEqual(woke.events.map(e => e.kind), ['connected', 'action_finished'])
})

test('repeated damage merges into one unread event', () => {
  const inbox = createInbox()
  const merge = last => ({amount: last.amount + 2})
  inbox.pushOrMerge('damaged', {amount: 2}, {wake: true}, merge)
  inbox.pushOrMerge('damaged', {amount: 2}, {wake: true}, merge)
  assert.deepEqual(inbox.unread().map(e => e.amount), [4])
})
