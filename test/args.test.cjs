// Argument parsing runs without a Minecraft server or daemon.
const test = require('node:test')
const assert = require('node:assert/strict')
const {parse, help, UsageError} = require('../src/args.cjs')

test('no arguments, help and --help all show help', () => {
  assert.equal(parse([]).command, 'help')
  assert.equal(parse(['--help']).command, 'help')
  assert.equal(parse(['help']).command, 'help')
  assert.deepEqual(parse(['farm', '--help']).args, {topic: 'farm'})
  assert.match(help(), /grokcraft <command>/)
  assert.match(help('farm'), /crop=melon\|wheat\|carrots\|potatoes\|beetroots\|pumpkin/)
})

test('key=value values are coerced by the schema', () => {
  assert.deepEqual(parse(['collect', 'block=oak_log', 'count=8']).args,
    {block: 'oak_log', count: 8, radius: 48, dig: false})
  assert.deepEqual(parse(['farm', 'crop=Wheat', 'radius=12']).args, {crop: 'wheat', radius: 12})
  assert.deepEqual(parse(['farm', 'crop=minecraft:melon']).args, {crop: 'melon', radius: 8})
  assert.deepEqual(parse(['standby']).args, {timeout: 300})
  assert.deepEqual(parse(['start', 'port=51234', 'auth=microsoft', 'owner=Steve']).args,
    {port: 51234, auth: 'microsoft', owner: 'Steve'})
})

test('coordinates accept several spellings', () => {
  for (const raw of ['[120,64,-35]', '120,64,-35', '120 64 -35', '[120, 64, -35]']) {
    assert.deepEqual(parse(['goto', `target=${raw}`]).args.target, [120, 64, -35])
  }
  assert.deepEqual(parse(['goto', 'target=[10,-20]']).args.target, [10, -20])
  assert.equal(parse(['goto', 'target=[1,2,3]', 'dig=true']).args.dig, true)
})

test('chat text stays a string and may be positional', () => {
  assert.deepEqual(parse(['chat', 'text=true']).args, {text: 'true'})
  assert.deepEqual(parse(['chat', 'text=a=b']).args, {text: 'a=b'})
  assert.deepEqual(parse(['chat', 'On', 'my', 'way']).args, {text: 'On my way'})
})

test('flags and aliases', () => {
  const parsed = parse(['state', '--json'])
  assert.equal(parsed.command, 'state')
  assert.equal(parsed.flags.json, true)
  assert.equal(parse(['inv']).command, 'inventory')
  assert.equal(parse(['shutdown']).command, 'shutdown')
  assert.equal(parse(['stop-action']).command, 'stop-action')
})

test('bad input gives usage errors', () => {
  const bad = [
    [['dance'], /unknown command "dance"/],
    [['follow'], /follow needs player=/],
    [['farm', 'crop=cactus'], /expected one of melon\|wheat/],
    [['farm', 'crop=wheat', 'radius=99'], /at most 32/],
    [['collect', 'block=oak_log', 'count=2.5'], /whole number/],
    [['collect', 'block=oak_log', 'count=lots'], /expected a number/],
    [['goto', 'target=[1,2,3,4]'], /\[x,y,z\]/],
    [['goto', 'target=[1,2,3]', 'dig=maybe'], /true or false/],
    [['state', 'verbose=1'], /unknown argument "verbose" for state; it takes no arguments/],
    [['collect', 'oak_log'], /expected key=value/],
    [['standby', 'timeout=0'], /at least 1/],
    [['follow', 'player=A', 'player=B'], /given twice/],
    [['chat', 'text='], /must not be empty/],
  ]
  for (const [argv, message] of bad) assert.throws(() => parse(argv), e => e instanceof UsageError && message.test(e.message), argv.join(' '))
})
