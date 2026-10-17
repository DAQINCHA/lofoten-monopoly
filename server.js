// 罗弗敦大富翁 —— HTTP + SSE 服务器（零依赖）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { BOARD, GROUPS, CHANCE, CHEST, START_CASH, SALARY, JAIL_FINE, MAX_PLAYERS, UTIL_RENT_PER_PIP, UTIL_RENT_BOTH } from './src/board.js';
import {
  createRoom, getRoom, joinRoom, leaveRoom, markDisconnected,
  snapshot, act, nextBotStep, chooseBotAction,
} from './src/game.js';
import { pickName } from './src/names.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 5200);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

// roomId -> Set<{res, playerId}>
const streams = new Map();

// ─────────────── 机器人调度 ───────────────
// 每个房间同时只有一个定时器，一拍走一步，走完再排下一拍。
const botTimers = new Map();
const botMisses = new Map();
// roomId -> "turnNo-playerId"：记录机器人这一回合的播报是否已经等过
const botTurnGate = new Map();

function scheduleBots(room) {
  if (!room || room.phase !== 'playing') return;
  if (botTimers.has(room.id)) return;
  const step = nextBotStep(room);
  if (!step) return; // 轮到人类，等真实玩家操作

  // 人类那边还在放播报或走子：先别动，等回执（最多等 6 秒，避免卡死）
  if (!displayReady(room)) {
    if (!room.displayWaitSince) room.displayWaitSince = Date.now();
    if (Date.now() - room.displayWaitSince < 6000) {
      const t = setTimeout(() => {
        botTimers.delete(room.id);
        scheduleBots(room);
      }, 140);
      t.unref?.();
      botTimers.set(room.id, t);
      return;
    }
  }
  room.displayWaitSince = 0;

  // 掷骰留一点动画时间，其余决策快速过
  let delay = 900;
  if (step.kind === 'turn') {
    const gate = `${room.turnNo}-${step.player.id}`;
    if (botTurnGate.get(room.id) !== gate) {
      botTurnGate.set(room.id, gate);
      // 人类已经看完这条状态（回执）才会走到这里，只需留一点反应时间
      delay = 520 + Math.random() * 180;
    } else {
      const preview = chooseBotAction(room, step.player);
      delay = preview?.type === 'roll' ? 780 : 340 + Math.random() * 160;
    }
  } else {
    delay = 700 + Math.random() * 260;
  }
  const timer = setTimeout(() => {
    botTimers.delete(room.id);
    try {
      const now = nextBotStep(room);
      if (now && now.player.id === step.player.id) tickBot(room, now.player);
    } catch (e) {
      console.error('[bot] 决策异常', e);
    }
    broadcast(room);
    scheduleBots(room);
  }, delay);
  timer.unref?.();
  botTimers.set(room.id, timer);
}

function tickBot(room, bot) {
  const action = chooseBotAction(room, bot);
  if (!action) return;
  const res = act(room, bot.id, action);
  if (res && !res.error) {
    botMisses.delete(room.id);
    return;
  }
  // 兜底：任何一步失败都不能让房间卡死
  console.warn(`[bot] ${bot.name} 的 ${action.type} 失败：${res?.error || '未知'}`);
  if (room.pending?.type === 'buy') act(room, bot.id, { type: 'pass' });
  else if (room.pending?.type === 'jail') act(room, bot.id, { type: 'jailRoll' });

  const misses = (botMisses.get(room.id) || 0) + 1;
  botMisses.set(room.id, misses);
  if (misses >= 4) {
    botMisses.delete(room.id);
    room.pending = null;
    room.canRoll = false;
    if (room.phase === 'playing' && room.players[room.current]?.id === bot.id) {
      act(room, bot.id, { type: 'endTurn' });
    }
  }
}

function broadcast(room) {
  const set = streams.get(room.id);
  if (!set || !set.size) return;
  room.version = (room.version || 0) + 1;
  const payload = `data: ${JSON.stringify(snapshot(room))}\n\n`;
  for (const client of set) {
    try {
      client.res.write(payload);
    } catch {
      set.delete(client);
    }
  }
}

// 人类把这条状态（播报、走子）放完了吗？
function displayReady(room) {
  const humans = room.players.filter((p) => !p.isBot && !p.bankrupt && p.connected);
  if (!humans.length) return true;
  if (!room.acks) room.acks = new Map();
  return humans.every((p) => (room.acks.get(p.id) || 0) >= (room.version || 0));
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      // 单页应用回退
      fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) => {
        if (e2) res.writeHead(404).end('not found');
        else res.writeHead(200, { 'content-type': MIME['.html'] }).end(html);
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const noCache = ['.html', '.js', '.css'].includes(ext);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': noCache ? 'no-cache' : 'public, max-age=300',
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  // ── API ──
  if (pathname === '/api/board') {
    return sendJson(res, 200, {
      board: BOARD, groups: GROUPS,
      meta: { START_CASH, SALARY, JAIL_FINE, MAX_PLAYERS, UTIL_RENT_PER_PIP, UTIL_RENT_BOTH },
      decks: { chance: CHANCE, chest: CHEST },
    });
  }

  if (pathname === '/api/name') {
    // 随机起名：如果知道房间号，就避开这个房间里已经有人用的名字
    const room = getRoom(url.searchParams.get('room'));
    const used = new Set(room ? room.players.map((p) => p.name) : []);
    return sendJson(res, 200, { name: pickName(used) });
  }

  if (pathname === '/api/create' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { room, player } = createRoom(body.name);
      broadcast(room);
      return sendJson(res, 200, { roomId: room.id, token: player.token, playerId: player.id });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/join' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const result = joinRoom(body.roomId, body.name, body.token);
      if (result.error) return sendJson(res, 400, { error: result.error });
      broadcast(result.room);
      return sendJson(res, 200, {
        roomId: result.room.id,
        token: result.player.token,
        playerId: result.player.id,
        resumed: !!result.resumed,
      });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/action' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const room = getRoom(body.roomId);
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const player = room.players.find((p) => p.token === body.token);
      if (!player) return sendJson(res, 403, { error: '身份校验失败，请重新加入' });
      player.connected = true;
      const result = act(room, player.id, body.action || {});
      broadcast(room);
      scheduleBots(room);
      return sendJson(res, 200, result || { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/ack' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const room = getRoom(body.roomId);
      if (!room) return sendJson(res, 404, { error: '房间不存在' });
      const player = room.players.find((p) => p.token === body.token);
      if (!player) return sendJson(res, 403, { error: '身份校验失败' });
      const v = Number(body.version) || 0;
      if (!room.acks) room.acks = new Map();
      if (v > (room.acks.get(player.id) || 0)) room.acks.set(player.id, v);
      scheduleBots(room); // 人类看完了，机器人可以接着走
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/leave' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const room = getRoom(body.roomId);
      if (room) {
        const player = room.players.find((p) => p.token === body.token);
        if (player) leaveRoom(room, player.id);
        broadcast(room);
      }
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  if (pathname === '/api/state') {
    const room = getRoom(url.searchParams.get('room'));
    if (!room) return sendJson(res, 404, { error: '房间不存在' });
    const token = url.searchParams.get('token');
    if (!room.players.some((p) => p.token === token)) return sendJson(res, 403, { error: '身份校验失败' });
    return sendJson(res, 200, snapshot(room));
  }

  if (pathname === '/api/stream') {
    const room = getRoom(url.searchParams.get('room'));
    if (!room) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('room not found');
    }
    const token = url.searchParams.get('token');
    const player = room.players.find((p) => p.token === token);
    if (!player) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('unauthorized');
    }
    player.connected = true;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    res.write(`data: ${JSON.stringify(snapshot(room))}\n\n`);

    if (!streams.has(room.id)) streams.set(room.id, new Set());
    const client = { res, playerId: player.id };
    streams.get(room.id).add(client);
    broadcast(room);

    const keepAlive = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 20000);

    req.on('close', () => {
      clearInterval(keepAlive);
      const set = streams.get(room.id);
      if (set) {
        set.delete(client);
        const stillOnline = [...set].some((c) => c.playerId === player.id);
        if (!stillOnline) {
          markDisconnected(room, player.id);
          broadcast(room);
        }
      }
    });
    return;
  }

  if (pathname === '/api/status') {
    return sendJson(res, 200, {
      ok: true,
      rooms: [...streams.keys()],
      uptime: Math.round(process.uptime()),
    });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    return serveStatic(req, res, pathname);
  }
  res.writeHead(404).end('not found');
});

function lanAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const [name, list] of Object.entries(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ name, address: net.address });
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  const lines = [
    '',
    '  ╭──────────────────────────────────────────────╮',
    '  │   罗弗敦大富翁 · LOFOTEN MONOPOLY            │',
    '  ╰──────────────────────────────────────────────╯',
    '',
    `  本机访问:   http://localhost:${PORT}`,
  ];
  for (const n of lanAddresses()) {
    lines.push(`  局域网:     http://${n.address}:${PORT}   (${n.name})`);
  }
  lines.push('', '  同一 Wi-Fi / 交换机的设备打开局域网地址即可联机。', '');
  console.log(lines.join('\n'));
});

process.on('SIGINT', () => {
  console.log('\n服务已停止');
  process.exit(0);
});
