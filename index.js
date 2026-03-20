import { createServer } from "http";
import { Server } from "socket.io";

const PORT = process.env.PORT || 5001;

const httpServer = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", worlds: worlds.size, players: totalPlayers(), uptime: process.uptime() }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end(`<h1>Grudge Open World Server</h1><p>Worlds: ${worlds.size} | Players: ${totalPlayers()}</p>`);
});

const io = new Server(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] },
  path: "/world",
});

// ─── World Instance ────────────────────────────────────────────
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

// ─── Socket.io ─────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[world] connected: ${socket.id}`);
  let currentWorld = null;
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

  // Disconnect
  socket.on("disconnect", () => {
    console.log(`[world] disconnected: ${socket.id}`);
    if (currentWorld) {
      const world = worlds.get(currentWorld);
      if (world) {
        const player = world.players.get(socket.id);
        world.players.delete(socket.id);
        if (player) {
          io.to(currentWorld).emit("player:left", { id: player.id, name: player.name });
        }
        if (world.players.size === 0) {
          // Keep world alive for 5 minutes in case host reconnects
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

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`[world] Grudge Open World Server running on port ${PORT}`);
});
