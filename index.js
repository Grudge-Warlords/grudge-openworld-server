import { createServer } from "http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 5001;
const GRUDGE_API = process.env.GRUDGE_API_URL || "https://api.grudge-studio.com";
const OBJECTSTORE_URL = process.env.OBJECTSTORE_URL || "https://objectstore.grudge-studio.com";
const OBJECTSTORE_PAGES = "https://molochdagod.github.io/ObjectStore/api/v1";
const SAVE_INTERVAL_MS = 30_000; // Auto-save island state every 30s

// ═══════════════════════════════════════════════════════════════
// OBJECTSTORE GAME DATA — fetched on startup, used for validation
// ═══════════════════════════════════════════════════════════════

let gameData = {
  weaponSkills: null,  // 17 weapon types, 207 skills
  enemies: null,       // enemy templates from ObjectStore
  classes: null,       // class → weapon restrictions
  loaded: false,
};

// Skill lookup index: skillId → { damage, cooldown, castTime, damageType, ... }
const skillIndex = new Map();
// Class → allowed weapon types
const classWeapons = {};

async function fetchGameDataFromObjectStore() {
  console.log("[data] Fetching game data from ObjectStore...");

  async function fetchJSON(workerPath, pagesFile) {
    try {
      const res = await fetch(`${OBJECTSTORE_URL}${workerPath}`);
      if (res.ok) return await res.json();
    } catch { /* fall through */ }
    try {
      const res = await fetch(`${OBJECTSTORE_PAGES}/${pagesFile}`);
      if (res.ok) return await res.json();
    } catch { /* fall through */ }
    return null;
  }

  const [ws, enemies, classes] = await Promise.allSettled([
    fetchJSON("/v1/weapon-skills", "weaponSkills.json"),
    fetchJSON("/v1/game-data/enemies", "enemies.json"),
    fetchJSON("/v1/game-data/classes", "classes.json"),
  ]);

  if (ws.status === "fulfilled" && ws.value) {
    gameData.weaponSkills = ws.value;
    // Build flat skill index for O(1) lookups
    if (ws.value.weaponTypes) {
      for (const wt of ws.value.weaponTypes) {
        for (const slot of wt.slots) {
          for (const skill of slot.skills) {
            skillIndex.set(skill.id, { ...skill, weaponType: wt.id });
          }
        }
      }
    }
    // Build class restrictions
    if (ws.value.classRestrictions) {
      Object.assign(classWeapons, ws.value.classRestrictions);
    }
    console.log(`[data] ⚔  Weapon skills: ${ws.value.totalWeaponTypes} types, ${ws.value.totalSkills} skills indexed`);
  } else {
    console.warn("[data] ⚠️  Failed to load weapon skills — using fallback combat");
  }

  if (enemies.status === "fulfilled" && enemies.value) {
    gameData.enemies = enemies.value;
    console.log(`[data] 👹 Enemy data loaded`);
  }

  if (classes.status === "fulfilled" && classes.value) {
    gameData.classes = classes.value;
    console.log(`[data] 🛡  Class data loaded`);
  }

  gameData.loaded = true;
  console.log(`[data] ✅ Game data sync complete (${skillIndex.size} skills indexed)`);
}

/**
 * Validate combat damage using weapon skill data.
 * Returns validated damage (capped by skill definition) or fallback.
 */
function validateSkillDamage(skillId, playerLevel = 1) {
  const skill = skillIndex.get(skillId);
  if (!skill) return null; // Unknown skill — caller uses fallback
  // Scale base damage by player level (10% per level above 1)
  const levelMult = 1 + (playerLevel - 1) * 0.1;
  return Math.floor(skill.damage * levelMult);
}

const httpServer = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      worlds: worlds.size,
      islands: islands.size,
      players: totalPlayers(),
      uptime: process.uptime(),
    }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<h1>Grudge Open World Server</h1><p>Worlds: ${worlds.size} | Islands: ${islands.size} | Players: ${totalPlayers()}</p>`);
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  path: "/world",
});

// ─── World Instance (existing arena/lobby system) ──────────────
const worlds = new Map();
let nextPlayerId = 1;

function totalPlayers() {
  let count = 0;
  for (const w of worlds.values()) count += w.players.size;
  return count;
}

function generateWorldCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return worlds.has(code) ? generateWorldCode() : code;
}

function createWorld(hostId, hostName, isPublic) {
  const code = generateWorldCode();
  const world = {
    code,
    hostId,
    hostName,
    isPublic,
    maxPlayers: 8,
    createdAt: Date.now(),
    players: new Map(), // socketId → player data
  };
  worlds.set(code, world);
  return world;
}

// Clean empty worlds every 60s
setInterval(() => {
  for (const [code, world] of worlds) {
    if (world.players.size === 0 && Date.now() - world.createdAt > 5 * 60 * 1000) {
      worlds.delete(code);
      console.log(`[world] ${code} deleted (empty)`);
    }
  }
}, 60000);

// ═══════════════════════════════════════════════════════════════
// ISLAND SYSTEM — PvE zones, harvesting, PvP, auto-save
// ═══════════════════════════════════════════════════════════════

const islands = new Map(); // "island:{id}" → island state

function getOrCreateIsland(islandId) {
  const key = `island:${islandId}`;
  if (!islands.has(key)) {
    islands.set(key, {
      id: islandId,
      players: new Map(),
      enemies: new Map(),
      harvestCooldowns: new Map(), // nodeId → respawnAt timestamp
      lastSave: Date.now(),
      dirty: false,
    });
  }
  return islands.get(key);
}

// PvE enemy templates — fallback, overridden by ObjectStore data on load
const ENEMY_TEMPLATES = [
  { type: "slime",    hp: 60,  dmg: 8,  xp: 15,  gold: 5,  speed: 1.5 },
  { type: "skeleton", hp: 120, dmg: 15, xp: 30,  gold: 12, speed: 1.2 },
  { type: "orc",      hp: 200, dmg: 25, xp: 50,  gold: 20, speed: 1.0 },
  { type: "troll",    hp: 400, dmg: 40, xp: 100, gold: 45, speed: 0.7 },
  { type: "dragon",   hp: 1200, dmg: 80, xp: 300, gold: 150, speed: 0.5 },
];

function getEnemyTemplate(zoneLevel) {
  const idx = Math.min(zoneLevel - 1, ENEMY_TEMPLATES.length - 1);
  return ENEMY_TEMPLATES[idx];
}

let nextEnemyId = 1;

function spawnEnemy(island, zoneLevel = 1) {
  const templateIdx = Math.min(zoneLevel - 1, ENEMY_TEMPLATES.length - 1);
  const template = ENEMY_TEMPLATES[templateIdx];
  const scaleMult = 1 + (zoneLevel - 1) * 0.3;
  const id = `e_${nextEnemyId++}`;
  const enemy = {
    id,
    ...template,
    hp: Math.floor(template.hp * scaleMult),
    maxHp: Math.floor(template.hp * scaleMult),
    dmg: Math.floor(template.dmg * scaleMult),
    x: (Math.random() - 0.5) * 300,
    y: 0,
    z: (Math.random() - 0.5) * 300,
    state: "idle",
    targetPlayerId: null,
    spawnedAt: Date.now(),
  };
  island.enemies.set(id, enemy);
  return enemy;
}

// Auto-save dirty islands to Grudge VPS
setInterval(async () => {
  for (const [key, island] of islands) {
    if (!island.dirty || island.players.size === 0) continue;
    try {
      // Save via Grudge backend (if configured)
      if (GRUDGE_API) {
        // POST to VPS — non-blocking, fire and forget
        fetch(`${GRUDGE_API}/api/island/state`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            islandId: island.id,
            nodes: Array.from(island.harvestCooldowns.entries()).map(([k, v]) => ({ id: k, respawnAt: v })),
            enemies: island.enemies.size,
            timestamp: Date.now(),
          }),
        }).catch(e => console.warn(`[save] Failed for ${key}:`, e.message));
      }
      island.dirty = false;
      island.lastSave = Date.now();
      console.log(`[save] Saved island ${island.id}`);
    } catch (e) {
      console.warn(`[save] Error saving ${key}:`, e.message);
    }
  }
}, SAVE_INTERVAL_MS);

// Clean empty islands every 5 min
setInterval(() => {
  for (const [key, island] of islands) {
    if (island.players.size === 0 && Date.now() - island.lastSave > 10 * 60 * 1000) {
      islands.delete(key);
      console.log(`[island] ${key} cleaned up (empty)`);
    }
  }
}, 5 * 60 * 1000);

// ─── Socket.io ─────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[world] connected: ${socket.id}`);
  let currentWorld = null;
  let currentIsland = null;
  let playerId = nextPlayerId++;

  // List public worlds
  socket.on("world:list", (cb) => {
    const list = [];
    for (const [code, w] of worlds) {
      if (w.isPublic) {
        list.push({
          code,
          hostName: w.hostName,
          players: w.players.size,
          maxPlayers: w.maxPlayers,
        });
      }
    }
    cb(list);
  });

  // Create a new world
  socket.on("world:create", (data, cb) => {
    const { playerName, heroId, heroClass, heroRace, isPublic } = data;
    const world = createWorld(socket.id, playerName, isPublic ?? true);
    currentWorld = world.code;
    socket.join(world.code);

    world.players.set(socket.id, {
      id: playerId,
      name: playerName,
      heroId, heroClass, heroRace,
      x: 0, y: 0, z: 0,
      facing: 0,
      hp: 200, maxHp: 200,
      level: 1,
      state: "idle", // idle, run, attack, hurt, dead
      lastUpdate: Date.now(),
    });

    console.log(`[world] ${playerName} created world ${world.code}`);
    cb({ code: world.code, playerId, players: serializePlayers(world) });
  });

  // Join existing world
  socket.on("world:join", (data, cb) => {
    const { code, playerName, heroId, heroClass, heroRace } = data;
    const world = worlds.get(code?.toUpperCase());
    if (!world) return cb({ error: "World not found" });
    if (world.players.size >= world.maxPlayers) return cb({ error: "World is full" });

    currentWorld = world.code;
    socket.join(world.code);

    world.players.set(socket.id, {
      id: playerId,
      name: playerName,
      heroId, heroClass, heroRace,
      x: 0, y: 0, z: 0,
      facing: 0,
      hp: 200, maxHp: 200,
      level: 1,
      state: "idle",
      lastUpdate: Date.now(),
    });

    // Notify others
    socket.to(world.code).emit("player:joined", {
      id: playerId,
      name: playerName,
      heroId, heroClass, heroRace,
    });

    console.log(`[world] ${playerName} joined ${world.code}`);
    cb({ code: world.code, playerId, players: serializePlayers(world) });
  });

  // Player position/state update (sent ~15 times/sec by each client)
  socket.on("player:update", (data) => {
    if (!currentWorld) return;
    const world = worlds.get(currentWorld);
    if (!world) return;
    const player = world.players.get(socket.id);
    if (!player) return;

    player.x = data.x ?? player.x;
    player.y = data.y ?? player.y;
    player.z = data.z ?? player.z;
    player.facing = data.facing ?? player.facing;
    player.state = data.state ?? player.state;
    player.hp = data.hp ?? player.hp;
    player.level = data.level ?? player.level;
    player.lastUpdate = Date.now();

    // Broadcast to others in same world (volatile = drop if behind)
    socket.volatile.to(currentWorld).emit("player:moved", {
      id: player.id,
      x: player.x, y: player.y, z: player.z,
      facing: player.facing,
      state: player.state,
      hp: player.hp,
      level: player.level,
    });
  });

  // Player combat action (visible to others)
  socket.on("player:action", (data) => {
    if (!currentWorld) return;
    socket.to(currentWorld).emit("player:action", {
      id: playerId,
      action: data.action, // "attack", "ability1", "ability2", etc.
      targetX: data.targetX,
      targetY: data.targetY,
      targetZ: data.targetZ,
    });
  });

  // Chat
  socket.on("chat", (data) => {
    if (!currentWorld) return;
    const world = worlds.get(currentWorld);
    const player = world?.players.get(socket.id);
    if (!player) return;
    io.to(currentWorld).emit("chat", {
      id: playerId,
      name: player.name,
      text: (data.text || "").slice(0, 200),
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // ISLAND EVENTS — join/leave, harvest, PvE combat, PvP, save
  // ═══════════════════════════════════════════════════════════════

  // Join an island instance
  socket.on("island:join", (data, cb) => {
    const { islandId, playerName, heroId, heroClass, heroRace, accountId } = data;
    if (!islandId) return cb?.({ error: "islandId required" });

    const island = getOrCreateIsland(islandId);
    const roomKey = `island:${islandId}`;
    currentIsland = roomKey;
    socket.join(roomKey);

    island.players.set(socket.id, {
      id: playerId,
      name: playerName,
      accountId,
      heroId, heroClass, heroRace,
      x: 0, y: 0, z: 0,
      facing: 0,
      hp: 200, maxHp: 200,
      level: 1,
      state: "idle",
      faction: null,
      lastUpdate: Date.now(),
    });

    // Notify others on the island
    socket.to(roomKey).emit("island:player_joined", {
      id: playerId, name: playerName, heroId, heroClass, heroRace,
    });

    // Send existing players + enemies to the joiner
    const players = [];
    for (const [, p] of island.players) players.push(p);
    const enemies = [];
    for (const [, e] of island.enemies) enemies.push(e);

    console.log(`[island] ${playerName} joined island ${islandId} (${island.players.size} players)`);
    cb?.({
      playerId,
      players,
      enemies,
      harvestCooldowns: Object.fromEntries(island.harvestCooldowns),
    });

    // Auto-spawn PvE enemies if island is empty of them
    if (island.enemies.size === 0) {
      const count = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < count; i++) {
        const enemy = spawnEnemy(island, 1);
        io.to(roomKey).emit("pve:spawn", enemy);
      }
    }
  });

  // Leave island
  socket.on("island:leave", () => {
    if (!currentIsland) return;
    const island = islands.get(currentIsland);
    if (island) {
      const player = island.players.get(socket.id);
      island.players.delete(socket.id);
      if (player) {
        io.to(currentIsland).emit("island:player_left", { id: player.id, name: player.name });
      }
    }
    socket.leave(currentIsland);
    currentIsland = null;
  });

  // Island player position update (same 15Hz pattern)
  socket.on("island:update", (data) => {
    if (!currentIsland) return;
    const island = islands.get(currentIsland);
    if (!island) return;
    const player = island.players.get(socket.id);
    if (!player) return;

    player.x = data.x ?? player.x;
    player.y = data.y ?? player.y;
    player.z = data.z ?? player.z;
    player.facing = data.facing ?? player.facing;
    player.state = data.state ?? player.state;
    player.hp = data.hp ?? player.hp;
    player.lastUpdate = Date.now();

    socket.volatile.to(currentIsland).emit("island:player_moved", {
      id: player.id,
      x: player.x, y: player.y, z: player.z,
      facing: player.facing,
      state: player.state,
      hp: player.hp,
    });
  });

  // ── Harvesting ────────────────────────────────────────────────
  socket.on("harvest:start", (data, cb) => {
    if (!currentIsland) return cb?.({ error: "Not on an island" });
    const island = islands.get(currentIsland);
    if (!island) return cb?.({ error: "Island not found" });

    const { nodeId, professionId } = data;
    const now = Date.now();

    // Check cooldown
    const respawnAt = island.harvestCooldowns.get(nodeId) || 0;
    if (respawnAt > now) {
      return cb?.({ error: "Node on cooldown", respawnAt });
    }

    // Set cooldown (60s for trees, 90s for rocks)
    const cooldown = nodeId.startsWith("tree") ? 60000 : 90000;
    island.harvestCooldowns.set(nodeId, now + cooldown);
    island.dirty = true;

    // Broadcast to all on the island
    io.to(currentIsland).emit("harvest:complete", {
      nodeId,
      playerId,
      professionId,
      respawnAt: now + cooldown,
    });

    cb?.({ success: true, respawnAt: now + cooldown });
  });

  // ── PvE Combat (server-authoritative, skill-validated damage) ──
  socket.on("pve:attack", (data, cb) => {
    if (!currentIsland) return;
    const island = islands.get(currentIsland);
    if (!island) return;
    const player = island.players.get(socket.id);
    if (!player) return;

    const { enemyId, damage, skillId } = data;
    const enemy = island.enemies.get(enemyId);
    if (!enemy) return cb?.({ error: "Enemy not found" });

    // Validate damage using weapon skill data if available
    let validatedDmg;
    const skillDmg = skillId ? validateSkillDamage(skillId, player.level) : null;
    if (skillDmg !== null) {
      // Use skill-validated damage (server-authoritative)
      validatedDmg = skillDmg;
    } else {
      // Fallback: cap client-reported damage at reasonable max
      validatedDmg = Math.min(damage || 0, 500);
    }
    enemy.hp -= validatedDmg;

    io.to(currentIsland).emit("pve:damage", {
      enemyId,
      damage: validatedDmg,
      hp: enemy.hp,
      attackerId: playerId,
    });

    // Enemy killed
    if (enemy.hp <= 0) {
      island.enemies.delete(enemyId);
      island.dirty = true;
      io.to(currentIsland).emit("pve:kill", {
        enemyId,
        killerId: playerId,
        xp: enemy.xp,
        gold: enemy.gold,
        type: enemy.type,
      });

      // Respawn a new enemy after 15-30s
      const respawnDelay = 15000 + Math.random() * 15000;
      setTimeout(() => {
        if (!islands.has(currentIsland)) return;
        const isl = islands.get(currentIsland);
        if (isl.players.size === 0) return;
        const newEnemy = spawnEnemy(isl, 1);
        io.to(currentIsland).emit("pve:spawn", newEnemy);
      }, respawnDelay);

      cb?.({ killed: true, xp: enemy.xp, gold: enemy.gold });
    } else {
      cb?.({ killed: false, hp: enemy.hp });
    }
  });

  // ── PvP Combat (zone-based, faction wars) ─────────────────────
  socket.on("pvp:attack", (data) => {
    if (!currentIsland) return;
    const island = islands.get(currentIsland);
    if (!island) return;
    const attacker = island.players.get(socket.id);
    if (!attacker) return;

    const { targetPlayerId, damage } = data;
    // Find target socket by player ID
    let targetSocketId = null;
    for (const [sid, p] of island.players) {
      if (p.id === targetPlayerId) { targetSocketId = sid; break; }
    }
    if (!targetSocketId) return;
    const target = island.players.get(targetSocketId);
    if (!target) return;

    // Same faction = no PvP (unless in arena zone)
    if (attacker.faction && attacker.faction === target.faction) return;

    // Validate PvP damage using skill data if available
    let validatedDmg;
    const pvpSkillDmg = data.skillId ? validateSkillDamage(data.skillId, attacker.level || 1) : null;
    if (pvpSkillDmg !== null) {
      validatedDmg = pvpSkillDmg;
    } else {
      validatedDmg = Math.min(damage || 0, 500);
    }
    target.hp = Math.max(0, target.hp - validatedDmg);

    io.to(currentIsland).emit("pvp:damage", {
      attackerId: attacker.id,
      targetId: target.id,
      damage: validatedDmg,
      skillId: data.skillId || null,
      targetHp: target.hp,
    });

    if (target.hp <= 0) {
      io.to(currentIsland).emit("pvp:kill", {
        killerId: attacker.id,
        killerName: attacker.name,
        victimId: target.id,
        victimName: target.name,
      });
      // Respawn victim at island center after 5s
      target.hp = target.maxHp;
      target.x = 0; target.y = 20; target.z = 0;
    }
  });

  // ── Island Chat ────────────────────────────────────────────────
  socket.on("island:chat", (data) => {
    if (!currentIsland) return;
    const island = islands.get(currentIsland);
    const player = island?.players.get(socket.id);
    if (!player) return;
    io.to(currentIsland).emit("island:chat", {
      id: playerId,
      name: player.name,
      text: (data.text || "").slice(0, 300),
    });
  });

  // Disconnect
  socket.on("disconnect", () => {
    console.log(`[world] disconnected: ${socket.id}`);

    // Leave island
    if (currentIsland) {
      const island = islands.get(currentIsland);
      if (island) {
        const player = island.players.get(socket.id);
        island.players.delete(socket.id);
        if (player) {
          io.to(currentIsland).emit("island:player_left", { id: player.id, name: player.name });
        }
      }
    }

    // Leave world
    if (currentWorld) {
      const world = worlds.get(currentWorld);
      if (world) {
        const player = world.players.get(socket.id);
        world.players.delete(socket.id);
        if (player) {
          io.to(currentWorld).emit("player:left", { id: player.id, name: player.name });
        }
        if (world.players.size === 0) {
          console.log(`[world] ${currentWorld} now empty`);
        }
      }
    }
  });
});

function serializePlayers(world) {
  const result = [];
  for (const [, p] of world.players) {
    result.push({ id: p.id, name: p.name, heroId: p.heroId, heroClass: p.heroClass, heroRace: p.heroRace, x: p.x, y: p.y, z: p.z, hp: p.hp, level: p.level, state: p.state });
  }
  return result;
}

// ── Startup: fetch game data then listen ────────────────────────
fetchGameDataFromObjectStore().then(() => {
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[world] Grudge Open World Server v2.0 running on port ${PORT}`);
    console.log(`[world] ObjectStore: ${OBJECTSTORE_URL}`);
    console.log(`[world] Skills indexed: ${skillIndex.size}`);
    console.log(`[world] Class restrictions: ${Object.keys(classWeapons).join(", ") || "none"}`);
  });
}).catch((err) => {
  console.warn("[world] Game data fetch failed, starting with fallbacks:", err.message);
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[world] Grudge Open World Server running on port ${PORT} (fallback mode)`);
  });
});

// Refresh game data every 30 minutes
setInterval(() => fetchGameDataFromObjectStore().catch(() => {}), 30 * 60 * 1000);
