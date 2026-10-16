// Command schemas and `key=value` argument parsing. Pure: no I/O, no server.
// Values arrive as raw strings and are coerced by the command's schema, so
// `text=true` stays the string "true" while `count=8` becomes the number 8.

const CROPS = ['melon', 'wheat', 'carrots', 'potatoes', 'beetroots', 'pumpkin']

// type: string | int | number | bool | coords | enum
const COMMANDS = {
  start: {
    summary: 'start the background daemon (remembers settings in ~/.grokcraft/config.json)',
    args: {
      host: {type: 'string', help: 'server host (default localhost)'},
      port: {type: 'int', min: 1, max: 65535, help: 'server port; for Open to LAN use the port it prints (default 25565)'},
      username: {type: 'string', help: 'bot name (offline) or Microsoft email (microsoft)'},
      auth: {type: 'enum', values: ['offline', 'microsoft'], help: 'offline (default) or microsoft'},
      owner: {type: 'string', help: 'your Minecraft name; their chat always wakes standby'},
      version: {type: 'string', help: 'Minecraft version, e.g. 1.21.4 (default auto)'},
      apiPort: {type: 'int', min: 1, max: 65535, help: 'local HTTP API port (default 3017)'},
    },
  },
  stop: {summary: 'shut the daemon down (disconnects the bot)', args: {}},
  shutdown: {summary: 'same as stop', args: {}},
  status: {summary: 'daemon and connection status', args: {}},
  state: {summary: 'full bot state: position, health, action, owner, nearby', args: {}},
  inventory: {summary: 'list inventory items', args: {}},
  events: {
    summary: 'print unread events and mark them read',
    args: {all: {type: 'bool', help: 'show the retained history, read or not'}, limit: {type: 'int', min: 1, max: 500}},
  },
  standby: {
    summary: 'block until something needs you, then print the events',
    args: {timeout: {type: 'int', min: 1, max: 3600, default: 300, help: 'seconds before giving up (default 300)'}},
  },
  chat: {summary: 'say something in game chat', positional: 'text', args: {text: {type: 'string', required: true}}},
  'stop-action': {summary: 'stop the running physical action', args: {}},
  follow: {
    summary: 'keep following a player until replaced or stopped',
    args: {player: {type: 'string', required: true}, range: {type: 'number', min: 1, max: 16, default: 2}},
  },
  come: {summary: 'walk to the owner', args: {range: {type: 'number', min: 1, max: 16, default: 2}}},
  goto: {
    summary: 'walk to a position',
    args: {
      target: {type: 'coords', required: true, help: '[x,y,z] or [x,z]'},
      range: {type: 'number', min: 0, max: 16, default: 1},
      dig: {type: 'bool', default: false, help: 'allow breaking blocks on the way'},
    },
  },
  farm: {
    summary: 'harvest mature crops nearby, replant, pick up drops',
    args: {
      crop: {type: 'enum', values: CROPS, required: true},
      radius: {type: 'int', min: 1, max: 32, default: 8},
    },
  },
  collect: {
    summary: 'mine blocks of a type and pick up the drops',
    args: {
      block: {type: 'string', required: true, help: 'block name, e.g. oak_log'},
      count: {type: 'int', min: 1, max: 256, default: 1},
      radius: {type: 'int', min: 1, max: 128, default: 48},
      dig: {type: 'bool', default: false, help: 'allow breaking other blocks to reach targets'},
    },
  },
}

const ALIASES = {'--help': 'help', '-h': 'help', 'halt': 'stop-action', 'inv': 'inventory'}

class UsageError extends Error {}

function coerce(key, raw, spec) {
  const fail = why => { throw new UsageError(`${key}: ${why} (got "${raw}")`) }
  switch (spec.type) {
    case 'string':
      if (raw === '') fail('must not be empty')
      return raw
    case 'int':
    case 'number': {
      if (raw.trim() === '') fail('expected a number')
      const n = Number(raw)
      if (!Number.isFinite(n)) fail('expected a number')
      if (spec.type === 'int' && !Number.isInteger(n)) fail('expected a whole number')
      if (spec.min != null && n < spec.min) fail(`must be at least ${spec.min}`)
      if (spec.max != null && n > spec.max) fail(`must be at most ${spec.max}`)
      return n
    }
    case 'bool': {
      const v = raw.toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(v)) return true
      if (['false', '0', 'no', 'off'].includes(v)) return false
      return fail('expected true or false')
    }
    case 'enum': {
      const v = raw.toLowerCase().replace(/^minecraft:/, '')
      if (!spec.values.includes(v)) fail(`expected one of ${spec.values.join('|')}`)
      return v
    }
    case 'coords': {
      // Accept [x,y,z], x,y,z and "x y z"; [x,z] means any height.
      const parts = raw.trim().replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean)
      const nums = parts.map(Number)
      if (![2, 3].includes(nums.length) || nums.some(n => !Number.isFinite(n))) fail('expected [x,y,z] or [x,z]')
      return nums
    }
    default:
      throw new Error(`unknown type ${spec.type}`)
  }
}

// argv: everything after the program name. Returns {command, args, flags}.
function parse(argv) {
  const flags = {json: false, help: false}
  const words = []
  for (const word of argv) {
    if (word === '--json') flags.json = true
    else if ((word === '--help' || word === '-h') && words.length) flags.help = true
    else words.push(word)
  }
  let [command, ...rest] = words
  command = ALIASES[command] ?? command
  if (!command || command === 'help') return {command: 'help', args: {topic: rest[0]}, flags}
  const schema = COMMANDS[command]
  if (!schema) throw new UsageError(`unknown command "${command}"; run \`grokcraft --help\``)
  if (flags.help) return {command: 'help', args: {topic: command}, flags}

  const args = {}
  const positional = []
  for (const word of rest) {
    const at = word.indexOf('=')
    const key = at > 0 ? word.slice(0, at) : null
    if (key && Object.hasOwn(schema.args, key)) {
      if (Object.hasOwn(args, key)) throw new UsageError(`${key} given twice`)
      args[key] = coerce(key, word.slice(at + 1), schema.args[key])
    } else if (schema.positional) {
      positional.push(word)
    } else if (key) {
      const known = Object.keys(schema.args)
      throw new UsageError(`unknown argument "${key}" for ${command}` + (known.length ? `; expected ${known.join(', ')}` : '; it takes no arguments'))
    } else {
      throw new UsageError(`expected key=value, got "${word}"`)
    }
  }
  // `grokcraft chat hello there` is the same as text="hello there".
  if (positional.length) {
    if (Object.hasOwn(args, schema.positional)) throw new UsageError(`${schema.positional} given twice`)
    args[schema.positional] = coerce(schema.positional, positional.join(' '), schema.args[schema.positional])
  }
  for (const [key, spec] of Object.entries(schema.args)) {
    if (Object.hasOwn(args, key)) continue
    if (spec.required) throw new UsageError(`${command} needs ${key}=…; run \`grokcraft ${command} --help\``)
    if (spec.default !== undefined) args[key] = spec.default
  }
  return {command, args, flags}
}

function usage(spec, key) {
  const shape = {string: '…', int: 'N', number: 'N', bool: 'true|false', coords: '[x,y,z]', enum: spec.values?.join('|')}[spec.type]
  return spec.required ? `${key}=${shape}` : `[${key}=${shape}]`
}

function help(topic) {
  if (topic) {
    const name = ALIASES[topic] ?? topic
    const schema = COMMANDS[name]
    if (!schema) throw new UsageError(`unknown command "${topic}"; run \`grokcraft --help\``)
    const lines = [`grokcraft ${name} ${Object.entries(schema.args).map(([k, s]) => usage(s, k)).join(' ')}`.trimEnd(), '', `  ${schema.summary}`]
    const described = Object.entries(schema.args).filter(([, s]) => s.help || s.default !== undefined)
    if (described.length) lines.push('')
    for (const [key, spec] of described) {
      const def = spec.default !== undefined ? ` (default ${JSON.stringify(spec.default)})` : ''
      lines.push(`  ${key.padEnd(9)} ${spec.help ?? ''}${spec.help?.includes('default') ? '' : def}`.trimEnd())
    }
    return lines.join('\n')
  }
  const lines = [
    'grokcraft: a Mineflayer companion bot for Minecraft Java Edition, driven from a shell.',
    '',
    'Usage: grokcraft <command> [key=value ...] [--json]',
    '',
    'Commands:',
  ]
  for (const [name, schema] of Object.entries(COMMANDS)) lines.push(`  ${name.padEnd(12)} ${schema.summary}`)
  lines.push(
    '',
    'Physical actions (follow, come, goto, farm, collect) return once started; a new one',
    'replaces the old. Their outcome arrives as an event, so run `grokcraft standby` to wait.',
    'standby wakes on owner chat, chat naming the bot, damage, death and action finished/failed.',
    '',
    'Examples:',
    '  grokcraft start host=localhost port=51234 username=Grok owner=Steve',
    '  grokcraft follow player=Steve',
    '  grokcraft goto target=[120,64,-35]',
    '  grokcraft farm crop=wheat radius=10',
    '  grokcraft collect block=oak_log count=8',
    '  grokcraft chat text="On my way"',
    '  grokcraft standby timeout=600',
    '',
    'Run `grokcraft <command> --help` for one command. Add --json for raw output.',
  )
  return lines.join('\n')
}

module.exports = {COMMANDS, CROPS, UsageError, parse, help, coerce}
