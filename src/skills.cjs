// Physical actions. Each skill validates its arguments against the live world
// and throws right away for problems the agent can fix (unknown block, player
// out of sight), then returns run(ctx), the long-running part.
const {Movements, goals} = require('mineflayer-pathfinder')
const {Vec3} = require('vec3')

const round = n => Math.round(n * 10) / 10
const posOf = p => [Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)]

// Companion default: walk around the owner's base without breaking or placing
// anything. dig=true allows tunnelling and scaffolding.
function movements(bot, dig) {
  const m = new Movements(bot)
  m.canDig = dig
  m.allow1by1towers = dig
  if (!dig) m.scafoldingBlocks = []
  return m
}

// collectblock refuses targets its movements may not break, so digging stays
// on; without dig=true everything but the target block type is protected.
function collectMovements(bot, type, dig) {
  const m = movements(bot, dig)
  m.canDig = true
  if (!dig) for (const id of Object.keys(bot.registry.blocks).map(Number)) if (id !== type.id) m.blocksCantBreak.add(id)
  return m
}

async function travel(bot, ctx, goal, dig = false) {
  ctx.check()
  bot.pathfinder.setMovements(movements(bot, dig))
  try {
    await bot.pathfinder.goto(goal)
  } catch (e) {
    ctx.check() // a replaced/stopped action reports as such, not as a path error
    if (e.name === 'NoPath') throw new Error('no path found' + (dig ? '' : ' (try dig=true to allow breaking blocks)'))
    if (e.name === 'Timeout') throw new Error('path search timed out; try a closer target')
    throw e
  }
  ctx.check()
}

function findPlayer(bot, name) {
  const key = Object.keys(bot.players).find(n => n.toLowerCase() === String(name).toLowerCase())
  return key ? bot.players[key] : null
}

function visiblePlayer(bot, name) {
  const player = findPlayer(bot, name)
  if (!player) throw new Error(`${name} is not online`)
  if (!player.entity) throw new Error(`${player.username} is online but out of sight (too far away); ask for coordinates and use goto`)
  return player
}

function counts(bot) {
  const out = {}
  for (const item of bot.inventory.items()) out[item.name] = (out[item.name] ?? 0) + item.count
  return out
}

function gained(before, after) {
  const out = {}
  for (const [name, n] of Object.entries(after)) if (n > (before[name] ?? 0)) out[name] = n - (before[name] ?? 0)
  return out
}

function itemName(bot, id) { return bot.registry.items[id]?.name ?? String(id) }

// --- follow / come / goto -------------------------------------------------

function follow(bot, {player: name, range}) {
  const first = visiblePlayer(bot, name)
  const username = first.username
  return async ctx => {
    let entity = null
    let lostSince = null
    bot.pathfinder.setMovements(movements(bot, false))
    for (;;) {
      ctx.check()
      const now = findPlayer(bot, username)?.entity
      if (now && now !== entity) {
        entity = now
        bot.pathfinder.setGoal(new goals.GoalFollow(entity, range), true)
      }
      if (now) {
        lostSince = null
        ctx.progress({following: username, distance: round(bot.entity.position.distanceTo(now.position))})
      } else {
        entity = null
        lostSince ??= Date.now()
        ctx.progress({following: username, distance: null, lostFor: Math.round((Date.now() - lostSince) / 1000)})
        if (Date.now() - lostSince > 15000) throw new Error(`lost sight of ${username}`)
      }
      await ctx.sleep(1000)
    }
  }
}

function come(bot, {range}, {owner}) {
  if (!owner) throw new Error('no owner configured; restart with `grokcraft start owner=NAME`, or use follow player=NAME')
  const player = visiblePlayer(bot, owner)
  return async ctx => {
    await travel(bot, ctx, new goals.GoalFollow(player.entity, range))
    const pos = bot.entity.position
    return {reached: player.username, position: posOf(pos), distance: round(pos.distanceTo(player.entity.position))}
  }
}

function goto(bot, {target, range, dig}) {
  const [x, a, b] = target
  const goal = target.length === 2
    ? (range > 0 ? new goals.GoalNearXZ(x, a, range) : new goals.GoalXZ(x, a))
    : (range > 0 ? new goals.GoalNear(x, a, b, range) : new goals.GoalBlock(x, a, b))
  return async ctx => {
    await travel(bot, ctx, goal, dig)
    return {position: posOf(bot.entity.position), target}
  }
}

// --- collect --------------------------------------------------------------

function blockType(bot, name) {
  const clean = String(name).toLowerCase().replace(/^minecraft:/, '')
  const type = bot.registry.blocksByName[clean]
  if (type) return type
  const similar = Object.keys(bot.registry.blocksByName).filter(n => n.includes(clean)).slice(0, 8)
  throw new Error(`unknown block "${clean}" for Minecraft ${bot.version}` + (similar.length ? `; did you mean ${similar.join(', ')}?` : ''))
}

function requiredTools(bot, type) {
  if (!type.harvestTools) return null
  const ids = Object.keys(type.harvestTools).map(Number)
  if (bot.inventory.items().some(i => ids.includes(i.type))) return null
  return ids.map(id => itemName(bot, id))
}

function collect(bot, {block, count, radius, dig}) {
  const type = blockType(bot, block)
  const tools = requiredTools(bot, type)
  if (tools) throw new Error(`${type.name} drops nothing without one of: ${tools.join(', ')}`)
  return async ctx => {
    const before = counts(bot)
    const skipped = new Set()
    let mined = 0
    let lastError = null
    while (mined < count) {
      ctx.check()
      const here = bot.entity.position
      const positions = bot.findBlocks({matching: type.id, maxDistance: radius, count: 64})
        .filter(p => !skipped.has(p.toString()))
        .sort((p, q) => p.distanceTo(here) - q.distanceTo(here))
      if (!positions.length) break
      const target = bot.blockAt(positions[0])
      if (!target) { skipped.add(positions[0].toString()); continue }
      ctx.progress({mined, of: count, target: posOf(target.position)})
      bot.collectBlock.movements = collectMovements(bot, type, dig)
      try {
        await bot.collectBlock.collect(target)
      } catch (e) {
        ctx.check()
        lastError = e.message
        if (/inventory/i.test(e.message) || e.name === 'NoChests') throw new Error('inventory is full')
        skipped.add(positions[0].toString())
        if (skipped.size >= 8) break
        continue
      }
      ctx.check()
      if (bot.blockAt(target.position)?.type !== type.id) mined++
      else skipped.add(target.position.toString())
    }
    const collected = gained(before, counts(bot))
    if (!mined) {
      throw new Error(skipped.size
        ? `could not reach any ${type.name} within ${radius} blocks (${lastError ?? 'unreachable'})` + (dig ? '' : '; try dig=true')
        : `no ${type.name} within ${radius} blocks`)
    }
    return {block: type.name, mined, requested: count, collected,
      ...(mined < count ? {note: `only ${mined} reachable within ${radius} blocks`} : {})}
  }
}

// --- farm -----------------------------------------------------------------

const CROPS = {
  wheat: {block: 'wheat', mature: 7, seed: 'wheat_seeds'},
  carrots: {block: 'carrots', mature: 7, seed: 'carrot'},
  potatoes: {block: 'potatoes', mature: 7, seed: 'potato'},
  beetroots: {block: 'beetroots', mature: 3, seed: 'beetroot_seeds'},
  // Fruit blocks have no age; only harvest ones grown from a stem so the bot
  // never breaks decorative pumpkins or melons.
  melon: {block: 'melon', legacy: 'melon_block', fruit: 'melon_stem'},
  pumpkin: {block: 'pumpkin', fruit: 'pumpkin_stem'},
}
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function age(block) {
  const props = typeof block.getProperties === 'function' ? block.getProperties() : {}
  return Number(props.age ?? block.metadata)
}

function ripe(bot, info, block) {
  if (!info.fruit) return age(block) >= info.mature
  return SIDES.some(side => {
    const name = bot.blockAt(block.position.plus(side))?.name ?? ''
    return name === `attached_${info.fruit}` || name === info.fruit
  })
}

async function pickUpDrops(bot, ctx, center, radius, limit = 24) {
  for (let i = 0; i < limit; i++) {
    ctx.check()
    const here = bot.entity.position
    const drop = Object.values(bot.entities)
      .filter(e => /^item$/i.test(e.name ?? '') && e.position.distanceTo(center) <= radius && e.position.distanceTo(here) > 0.8)
      .sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
    if (!drop) return
    try {
      await travel(bot, ctx, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0.5))
    } catch (e) {
      ctx.check()
      return // unreachable drop: leave it rather than wander off
    }
    await ctx.sleep(150)
  }
}

function farm(bot, {crop, radius}) {
  const info = CROPS[crop]
  const type = bot.registry.blocksByName[info.block] ?? bot.registry.blocksByName[info.legacy]
  if (!type) throw new Error(`${crop} is not a block in Minecraft ${bot.version}`)
  const seedType = info.seed && bot.registry.itemsByName[info.seed]
  return async ctx => {
    const center = bot.entity.position.floored()
    const inArea = p => Math.abs(p.x - center.x) <= radius && Math.abs(p.z - center.z) <= radius && Math.abs(p.y - center.y) <= 6
    const before = counts(bot)
    const done = new Set()
    const tally = {harvested: 0, replanted: 0, noSeeds: 0, replantFailed: 0, unreachable: 0}
    let growing = 0
    for (;;) {
      ctx.check()
      const here = bot.entity.position
      const found = bot.findBlocks({matching: type.id, maxDistance: Math.ceil(radius * 1.5) + 6, count: 1024})
        .filter(p => inArea(p) && !done.has(p.toString()))
        .map(p => bot.blockAt(p)).filter(Boolean)
      const mature = found.filter(b => ripe(bot, info, b))
      growing = found.length - mature.length
      if (!mature.length) break
      const block = mature.sort((a, b) => a.position.distanceTo(here) - b.position.distanceTo(here))[0]
      const pos = block.position
      done.add(pos.toString())
      ctx.progress({...tally, target: posOf(pos), remaining: mature.length})
      try {
        await travel(bot, ctx, new goals.GoalNear(pos.x, pos.y, pos.z, 2))
      } catch (e) {
        ctx.check()
        tally.unreachable++
        continue
      }
      const current = bot.blockAt(pos)
      if (!current || current.type !== type.id || !ripe(bot, info, current)) continue
      if (info.fruit && bot.tool) await bot.tool.equipForBlock(current, {}).catch(() => {})
      await bot.dig(current, true)
      tally.harvested++
      await ctx.sleep(300)
      await pickUpDrops(bot, ctx, pos, 3)
      if (info.fruit) continue
      const soil = bot.blockAt(pos.offset(0, -1, 0))
      const spot = bot.blockAt(pos)
      if (soil?.name !== 'farmland' || !['air', 'cave_air'].includes(spot?.name)) continue
      const seed = seedType && bot.inventory.items().find(i => i.type === seedType.id)
      if (!seed) { tally.noSeeds++; continue }
      try {
        await bot.equip(seed, 'hand')
        await bot.placeBlock(soil, new Vec3(0, 1, 0))
        tally.replanted++
      } catch (e) {
        ctx.check()
        if (bot.blockAt(pos)?.type === type.id) tally.replanted++
        else tally.replantFailed++
      }
    }
    // A last sweep for anything that bounced away.
    await pickUpDrops(bot, ctx, center, radius + 2)
    const result = {crop, radius, ...tally, stillGrowing: growing, collected: gained(before, counts(bot))}
    if (!tally.harvested) result.note = `no mature ${crop} within ${radius} blocks` + (growing ? ` (${growing} still growing)` : '')
    for (const key of ['noSeeds', 'replantFailed', 'unreachable']) if (!result[key]) delete result[key]
    return result
  }
}

module.exports = {follow, come, goto, collect, farm, findPlayer, counts, CROPS}
