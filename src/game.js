// 罗弗敦大富翁 —— 游戏引擎（纯内存，零依赖）
import {
  BOARD, GROUPS, GROUP_CELLS, CHANCE, CHEST, INDEX_BY_NAME,
  START_CASH, SALARY, JAIL_FINE, HOUSE_SUPPLY, HOTEL_SUPPLY, MAX_PLAYERS, BOARD_SIZE,
  UTIL_RENT_PER_PIP, UTIL_RENT_BOTH,
} from './board.js';
import { BOT_NAMES, chooseBotAction } from './bot.js';

export const PLAYER_COLORS = ['#ef5b4c', '#38c3a8', '#f0c04a', '#a98cf0', '#e57bb8', '#59a9e8'];

// 棋子池：同一房间内不重复，随机分配，让每局的海岛动物都不一样
export const PLAYER_TOKENS = [
  '🐟', '🦀', '🦌', '🐋', '🐑', '🦅',
  '🦞', '🐙', '🦭', '🐧', '🦈', '🐚',
  '⛵', '🚤', '⛴', '🛶', '🗼', '🏔',
  '🌌', '🎣', '🐳', '🐬', '🦉', '🦢',
];

const FERRY_INDEXES = BOARD.map((c, i) => (c.type === 'ferry' ? i : -1)).filter((i) => i >= 0);
const UTIL_INDEXES = BOARD.map((c, i) => (c.type === 'util' ? i : -1)).filter((i) => i >= 0);

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const ri = (n) => Math.floor(Math.random() * n);
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = ri(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

function newCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => CODE_CHARS[ri(CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

// ─────────────────────────── 房间 ───────────────────────────
export function createRoom(name) {
  const id = newCode();
  const room = {
    id,
    phase: 'lobby', // lobby | playing | ended
    players: [],
    hostId: null,
    current: 0,
    turnNo: 1,
    dice: [0, 0],
    doubles: 0,
    canRoll: false,
    rollAgain: false,
    pending: null,
    trade: null,
    winnerId: null,
    endReason: null,
    turnLimit: 80,
    cells: BOARD.map(() => ({ owner: null, houses: 0, mortgaged: false })),
    log: [],
    logSeq: 0,
    // 局内聊天：所有人可见，只保留最近 60 条
    chat: [],
    // 状态版本号：每广播一次 +1。客户端播报/走子放完后回执，机器人据此等人类看完再动手
    version: 0,
    acks: new Map(),
    chanceOrder: [],
    chestOrder: [],
    chancePtr: 0,
    chestPtr: 0,
    bank: { houses: HOUSE_SUPPLY, hotels: HOTEL_SUPPLY },
    // 棋子位移轨迹：一次行动里可能走好几段（先到卡格再后退、被送进监狱直接飞过去），
    // 按顺序记下来交给前端照着演，前端不用再靠"最短路径"猜方向
    trails: {},
    moveSeq: 0,
    // 测试模式：房主可开，用于手动摆位、指定抽某张卡，方便验证动画与结算
    debug: false,
    createdAt: Date.now(),
  };
  room.chanceOrder = shuffle(CHANCE.map((_, i) => i));
  room.chestOrder = shuffle(CHEST.map((_, i) => i));
  rooms.set(id, room);
  const player = addPlayer(room, name);
  room.hostId = player.id;
  pushLog(room, `${player.name} 创建了房间 ${id}`, 'sys');
  return { room, player };
}

function addPlayer(room, name, opts = {}) {
  const usedSeats = new Set(room.players.map((p) => p.seat));
  let seat = 0;
  while (usedSeats.has(seat)) seat++;
  const usedTokens = new Set(room.players.map((p) => p.emoji));
  const tokenPool = PLAYER_TOKENS.filter((t) => !usedTokens.has(t));
  const emoji = (tokenPool.length ? tokenPool : PLAYER_TOKENS)[ri((tokenPool.length ? tokenPool : PLAYER_TOKENS).length)];
  const p = {
    id: uid(),
    token: uid(),
    name: uniqueName(room, sanitizeName(name) || `旅人${seat + 1}`),
    isBot: !!opts.isBot,
    seat,
    color: PLAYER_COLORS[seat % PLAYER_COLORS.length],
    emoji,
    cash: START_CASH,
    pos: 0,
    inJail: false,
    jailTurns: 0,
    cards: 0,
    held: [],
    orderRoll: null,
    bankrupt: false,
    connected: true,
    joinedAt: Date.now(),
  };
  room.players.push(p);
  return p;
}

// 同一房间里尽量不重名：重了就补一个后缀
function uniqueName(room, name) {
  const used = new Set(room.players.map((p) => p.name));
  if (!used.has(name)) return name;
  const base = name.slice(0, 10);
  let i = 2;
  while (used.has(`${base}·${i}`) && i < 99) i++;
  return `${base}·${i}`;
}

function sanitizeName(n) {
  return String(n || '').replace(/[\s\u0000-\u001f]/g, ' ').trim().slice(0, 12);
}

// ─────────────────────────── 手持卡牌 ───────────────────────────
// kind: 'jail' 免罪票 / 'rent' 租金减半券。卡面数据随卡存一份，方便玩家随时查看。
function addHeld(p, card) {
  if (!Array.isArray(p.held)) p.held = [];
  p.held.push({ id: uid(), kind: card.kind, title: card.title, text: card.text || '' });
  syncJailCount(p);
}

function spendHeld(p, kind) {
  if (!Array.isArray(p.held)) p.held = [];
  const i = p.held.findIndex((c) => c.kind === kind);
  if (i < 0) return null;
  const [card] = p.held.splice(i, 1);
  syncJailCount(p);
  return card;
}

function syncJailCount(p) {
  // p.cards 是「免罪票」张数（规则与机器人都依赖它），由 held 派生
  p.cards = (p.held || []).filter((c) => c.kind === 'jail').length;
}

// ─────────────────────────── 掷骰定序 ───────────────────────────
const rollOrderDie = () => 1 + ri(6);

function makeOrderRoll() {
  return [rollOrderDie(), rollOrderDie()];
}

const orderSum = (p) => (p.orderRoll ? p.orderRoll[0] + p.orderRoll[1] : -1);
const orderHigh = (p) => (p.orderRoll ? Math.max(p.orderRoll[0], p.orderRoll[1]) : 0);

// 点数大的先手；同点比单颗最大；再同比座位（先入座先手）
export function sortByOrder(players) {
  return [...players].sort(
    (a, b) => orderSum(b) - orderSum(a) || orderHigh(b) - orderHigh(a) || a.seat - b.seat,
  );
}

function rollOrder(room, p) {
  if (room.phase !== 'lobby') return { error: '对局已经开始，不能重掷' };
  if (p.orderRoll) return { error: '你这一局已经掷过了' };
  p.orderRoll = makeOrderRoll();
  pushLog(room, `🎲 ${p.name} 掷出 ${p.orderRoll[0]} + ${p.orderRoll[1]} = ${orderSum(p)}`, 'roll');
  return { ok: true };
}

export function getRoom(id) {
  return rooms.get(String(id || '').toUpperCase()) || null;
}

export function joinRoom(roomId, name, token) {
  const room = getRoom(roomId);
  if (!room) return { error: '房间不存在，检查一下房间码' };
  if (token) {
    const p = room.players.find((x) => x.token === token);
    if (p) {
      p.connected = true;
      if (name) p.name = sanitizeName(name) || p.name;
      return { room, player: p, resumed: true };
    }
  }
  if (room.phase !== 'lobby') return { error: '这一局已经开始了，等下一局吧' };
  if (room.players.length >= MAX_PLAYERS) return { error: '房间满了（最多 6 人）' };
  const p = addPlayer(room, name);
  pushLog(room, `${p.name} 加入了房间`, 'sys');
  return { room, player: p };
}

export function leaveRoom(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx < 0) return;
  if (room.phase === 'lobby') {
    const [p] = room.players.splice(idx, 1);
    pushLog(room, `${p.name} 离开了房间`, 'sys');
    if (room.hostId === p.id && room.players.length) room.hostId = room.players[0].id;
  } else {
    const p = room.players[idx];
    p.connected = false;
    pushLog(room, `${p.name} 断开了连接`, 'sys');
  }
  if (room.players.length === 0) rooms.delete(room.id);
}

export function markDisconnected(room, playerId) {
  const p = room.players.find((x) => x.id === playerId);
  if (!p) return;
  p.connected = false;
}

// ─────────────────────────── 机器人 ───────────────────────────
export function addBot(room, requesterId) {
  if (room.hostId !== requesterId) return { error: '只有房主可以添加机器人' };
  // 测试模式允许边打边加：想看人机互抢地产、收租这类情形时不用重开
  if (room.phase !== 'lobby' && !(room.phase === 'playing' && room.debug)) {
    return { error: '对局开始后不能添加机器人' };
  }
  if (room.players.length >= MAX_PLAYERS) return { error: `房间满了（最多 ${MAX_PLAYERS} 人）` };
  const used = new Set(room.players.map((p) => p.name));
  const pool = BOT_NAMES.filter((n) => !used.has(n));
  const list = pool.length ? pool : BOT_NAMES;
  const name = list[ri(list.length)];
  const p = addPlayer(room, name, { isBot: true });
  p.orderRoll = makeOrderRoll(); // 机器人入座即掷，人齐了直接看顺序
  pushLog(room, `🤖 ${p.name} 加入了房间`, 'sys');
  return { ok: true, playerId: p.id };
}

export function removeBot(room, requesterId, botId) {
  if (room.hostId !== requesterId) return { error: '只有房主可以移除机器人' };
  if (room.phase !== 'lobby' && !(room.phase === 'playing' && room.debug)) {
    return { error: '对局中不能移除机器人' };
  }
  const idx = room.players.findIndex((p) => p.id === botId && p.isBot);
  if (idx < 0) return { error: '找不到这个机器人' };
  const [p] = room.players.splice(idx, 1);
  // 局中移除：把当前指针拨回去，别让下一位被跳过（或轮到已经出局的人）
  if (room.phase === 'playing' && room.players.length) {
    if (idx < room.current) room.current -= 1;
    else if (idx === room.current) {
      let guard = 0;
      do {
        room.current = (room.current + 1) % room.players.length;
        guard++;
      } while (cur(room).bankrupt && guard < 50);
    }
  }
  pushLog(room, `🤖 ${p.name} 离开了房间`, 'sys');
  return { ok: true };
}

// 服务器的机器人调度器每拍调用一次：返回此刻该行动的机器人
export function nextBotStep(room) {
  if (room.phase !== 'playing') return null;
  if (room.trade) {
    const to = byId(room, room.trade.to);
    if (to && to.isBot && !to.bankrupt) return { player: to, kind: 'trade' };
    return null;
  }
  const p = cur(room);
  if (p && p.isBot && !p.bankrupt) return { player: p, kind: 'turn' };
  return null;
}

export { chooseBotAction };

// ─────────────────────────── 快照 ───────────────────────────
export function snapshot(room) {
  return {
    id: room.id,
    phase: room.phase,
    version: room.version || 0,
    hostId: room.hostId,
    current: room.current,
    turnNo: room.turnNo,
    dice: room.dice,
    canRoll: room.canRoll,
    pending: room.pending,
    trade: room.trade,
    winnerId: room.winnerId,
    endReason: room.endReason,
    turnLimit: room.turnLimit,
    // 本次行动里棋子的位移轨迹（分段的），前端照着演；moveSeq 变了才是一条新轨迹
    moveSeq: room.moveSeq || 0,
    debug: !!room.debug,
    cells: room.cells,
    bank: room.bank,
    log: room.log.slice(-70),
    chat: (room.chat || []).slice(-50),
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: !!p.isBot,
      seat: p.seat,
      color: p.color,
      emoji: p.emoji,
      cash: p.cash,
      pos: p.pos,
      path: (room.trails && room.trails[p.id]) || [],
      inJail: p.inJail,
      jailTurns: p.jailTurns,
      cards: p.cards,
      held: (p.held || []).map((c) => ({ id: c.id, kind: c.kind, title: c.title, text: c.text })),
      orderRoll: p.orderRoll || null,
      bankrupt: p.bankrupt,
      connected: p.connected,
      props: room.cells.map((c, i) => (c.owner === p.id ? i : -1)).filter((i) => i >= 0),
      netWorth: netWorth(room, p),
    })),
  };
}

function cur(room) {
  return room.players[room.current];
}
function byId(room, id) {
  return room.players.find((p) => p.id === id);
}
function activePlayers(room) {
  return room.players.filter((p) => !p.bankrupt);
}
function netWorth(room, p) {
  let v = p.cash;
  room.cells.forEach((c, i) => {
    if (c.owner === p.id) {
      v += BOARD[i].price;
      v += c.houses * (BOARD[i].houseCost || 0);
    }
  });
  return v;
}

// 日志里的金额统一带千分位，读起来不费劲
const kr = (n) => 'kr ' + Number(n).toLocaleString('en-US');

function pushLog(room, text, kind = 'sys', delta = 0, opts = {}) {
  // delta：本条的现金增减，前端用不同颜色标出「得」与「失」
  // seq：单调递增序号，前端靠它识别"哪些是刚发生的"，用来逐条大屏播报
  // quiet：照旧写进侧栏日志，但不单独上大屏（用于和金额播报重复的描述句）
  room.logSeq = (room.logSeq || 0) + 1;
  room.log.push({
    seq: room.logSeq,
    text,
    kind,
    t: Date.now(),
    delta: Number.isFinite(delta) ? delta : 0,
    quiet: !!opts.quiet,
  });
  if (room.log.length > 240) room.log.shift();
}

// ─────────────────────────── 回合 ───────────────────────────
function startGame(room, playerId) {
  if (room.hostId !== playerId) return { error: '只有房主可以开始游戏' };
  if (room.phase !== 'lobby') return { error: '游戏已经开始了' };
  // 测试模式一个人也能开局：自己一个人慢慢摆位、抽卡，看各种情形
  if (room.players.length < 2 && !room.debug) return { error: '至少需要 2 名玩家' };
  room.phase = 'playing';
  // 还有人没掷骰：开局替他补掷一次，保证顺序公平
  room.players.forEach((p) => {
    if (!p.orderRoll) p.orderRoll = makeOrderRoll();
  });
  room.players = sortByOrder(room.players);
  room.players.forEach((p) => {
    p.cash = START_CASH;
    p.pos = 0;
    p.inJail = false;
    p.jailTurns = 0;
    p.cards = 0;
    p.held = [];
    p.bankrupt = false;
  });
  room.cells = BOARD.map(() => ({ owner: null, houses: 0, mortgaged: false }));
  room.bank = { houses: HOUSE_SUPPLY, hotels: HOTEL_SUPPLY };
  room.current = 0;
  room.turnNo = 1;
  room.winnerId = null;
  room.endReason = null;
  room.trade = null;
  room.chancePtr = 0;
  room.chestPtr = 0;
  room.chanceOrder = shuffle(CHANCE.map((_, i) => i));
  room.chestOrder = shuffle(CHEST.map((_, i) => i));
  room.trails = {};
  room.moveSeq = (room.moveSeq || 0) + 1; // 所有人回到起点，别照旧轨迹倒着走一圈
  room.log = [];
  pushLog(room, `游戏开始，每人 ${kr(START_CASH)}。愿极光眷顾你。`, 'sys');
  pushLog(
    room,
    `🎲 出手顺序：${room.players.map((p, i) => `${i + 1}. ${p.name}（${orderSum(p)} 点）`).join(' → ')}`,
    'sys',
  );
  beginTurn(room);
  return { ok: true };
}

function beginTurn(room) {
  const p = cur(room);
  p.botTradeTried = false;
  room.dice = [0, 0];
  room.doubles = 0;
  room.rollAgain = false;
  room.pending = null;
  if (p.inJail) {
    room.canRoll = false;
    room.pending = { type: 'jail' };
    pushLog(room, `${p.name} 在监狱里，等待保释或掷出对子`, 'jail');
  } else {
    room.canRoll = true;
    pushLog(room, `— 第 ${room.turnNo} 回合 · 轮到 ${p.name} —`, 'turn');
  }
}

function endByWorth(room) {
  const alive = activePlayers(room);
  const sorted = [...alive].sort((a, b) => netWorth(room, b) - netWorth(room, a));
  room.phase = 'ended';
  room.endReason = 'limit';
  room.winnerId = sorted[0]?.id || null;
  room.pending = null;
  room.trade = null;
  pushLog(room, `第 ${room.turnLimit} 回合结束，${sorted[0]?.name || '无人'} 以最高净值成为岛主`, 'win');
}

function endTurn(room) {
  if (room.pending) return { error: '还有待处理的决定' };
  if (room.canRoll) return { error: '你还没有掷骰子' };
  if (room.phase !== 'playing') return { error: '游戏已结束' };
  room.trade = null;
  let guard = 0;
  do {
    room.current = (room.current + 1) % room.players.length;
    guard++;
  } while (cur(room).bankrupt && guard < 50);
  room.turnNo++;
  if (room.turnLimit > 0 && room.turnNo > room.turnLimit) {
    endByWorth(room);
    return { ok: true };
  }
  beginTurn(room);
  return { ok: true };
}

const G = (i) => BOARD[i];

// landed：正好停在起点（而不是路过）。措辞分开，避免和下面落地的那句重复
function salary(room, p, opts = {}) {
  p.cash += SALARY;
  const lead = opts.landed
    ? `${p.name} 稳稳停在旅程起点`
    : `${p.name} 绕过最后一道礁石回到旅程起点`;
  const what = opts.landed ? '起点津贴' : '过路津贴';
  pushLog(room, `${lead}，领到 ${kr(SALARY)} 的${what}`, 'money', SALARY);
}

// 记一段位移：mode = walk 顺时针逐格 / back 逆时针逐格 / jump 直接押送（不沿棋盘走）
// 按官方大富翁规则，只有「后退 N 格」那张卡是逆时针；
// 「前往某地」「回到起点」一律顺时针前进（可能绕过起点领津贴）；
// 进监狱是 "Go directly to Jail. Do not pass GO"，所以用 jump：一步到位，绝不经过起点。
function markMove(room, p, from, to, mode) {
  if (from === to) return;
  if (!room.trails) room.trails = {};
  const list = room.trails[p.id] || (room.trails[p.id] = []);
  list.push({ from, to, mode });
}

// 顺时针方向离 from 最近的某类卡格（极光卡 3 格、命运卡 3 格）；
// 已经站在同类卡格上就返回 -1，表示不用走
function nearestCardCell(from, type) {
  // 已经站在同类卡格上就原地抽，别再往前绕一圈到下一格
  if (G(from).type === type) return -1;
  let best = -1;
  let bestD = BOARD_SIZE;
  BOARD.forEach((c, i) => {
    if (c.type !== type) return;
    const d = (i - from + BOARD_SIZE) % BOARD_SIZE;
    if (d > 0 && d < bestD) { bestD = d; best = i; }
  });
  return best;
}

// 返回是否刚领过津贴，好让落地播报别再重复一句
function moveBy(room, p, steps) {
  const before = p.pos;
  p.pos = (p.pos + steps) % BOARD_SIZE;
  markMove(room, p, before, p.pos, steps >= 0 ? 'walk' : 'back');
  if (p.pos < before) {
    salary(room, p, { landed: p.pos === 0 });
    return true;
  }
  return false;
}

function sendToJail(room, p, opts = {}) {
  const before = p.pos;
  const jailIdx = BOARD.findIndex((c) => c.type === 'jail');
  p.pos = jailIdx;
  // 官方规则：直接进监狱，不沿棋盘走、也不经过起点（自然没有津贴）
  markMove(room, p, before, p.pos, 'jump');
  p.inJail = true;
  p.jailTurns = 0;
  room.canRoll = false;
  room.rollAgain = false;
  pushLog(room, `${p.name} 被送进监狱`, 'jail', 0, opts);
}

// ─────────────────────────── 落地处理 ───────────────────────────
function resolveLanding(room, p, depth = 0, opts = {}) {
  if (depth > 6) return;
  const cell = G(p.pos);
  const st = room.cells[p.pos];

  switch (cell.type) {
    case 'go':
      // 正好停在起点时津贴那条已经播过（带金额），这里不再重复上大屏
      if (opts.salaryPaid) return;
      pushLog(room, `${p.name} 稳稳停在旅程起点，船帆收得整整齐齐`, 'sys');
      return;
    case 'jail':
      pushLog(room, `${p.name} 从监狱门口经过，只是和守卫点了点头`, 'sys');
      return;
    case 'parking':
      pushLog(room, `${p.name} 在极光营地生起篝火，煮了壶咖啡歇脚`, 'sys');
      return;
    case 'gotojail':
      sendToJail(room, p);
      return;
    case 'tax':
      // 这句只是过场描述，真正的金额由下面的 charge 播一条，避免同一件事播两遍
      pushLog(room, `${p.name} 被拦在码头，渔获过磅、缴税`, 'sys', 0, { quiet: true });
      charge(room, p, cell.amount, `${cell.name}`);
      return;
    case 'chance':
      drawCard(room, p, 'chance', depth);
      return;
    case 'chest':
      drawCard(room, p, 'chest', depth);
      return;
    case 'prop':
    case 'ferry':
    case 'util': {
      if (!st.owner) {
        room.pending = { type: 'buy', index: p.pos };
        pushLog(room, `${p.name} 闯进「${cell.name}」，地主家的门锁还没上——${kr(cell.price)} 就能签下地契`, 'sys');
        return;
      }
      if (st.owner === p.id) {
        pushLog(room, `${p.name} 回到自家「${cell.name}」，检查了一下门牌`, 'sys');
        return;
      }
      const owner = byId(room, st.owner);
      if (!owner || owner.bankrupt) return;
      if (st.mortgaged) {
        pushLog(room, `「${cell.name}」门窗钉死（抵押中），${p.name} 白跑一趟`, 'sys');
        return;
      }
      const rent = applyRentVoucher(room, p, rentOf(room, p.pos, room.dice[0] + room.dice[1]), cell.name);
      // 描述句不上大屏，收租金额那条会带上「租金 · 地名」
      pushLog(room, `${p.name} 一脚踩进 ${owner.name} 的「${cell.name}」，被拦下收租`, 'rent', 0, { quiet: true });
      charge(room, p, rent, `「${cell.name}」租金`, owner);
      return;
    }
    default:
  }
}

// 「渔市议价券」一类的保留卡：付租时自动抵掉一半，用掉即失效
// 小额租金（不到 kr 6,000）不值得动用，留着应付更贵的落点
function applyRentVoucher(room, p, rent, place) {
  if (!rent || rent < 6000) return rent;
  if (!(p.held || []).some((c) => c.kind === 'rent')) return rent;
  const card = spendHeld(p, 'rent');
  if (!card) return rent;
  const cut = Math.ceil(rent / 2);
  pushLog(
    room,
    `${p.name} 亮出「${card.title}」，把「${place}」的租金压到 ${kr(rent - cut)}`,
    'card',
    cut,
    { quiet: true },
  );
  return rent - cut;
}

function rentOf(room, index, diceSum) {
  const cell = G(index);
  const st = room.cells[index];
  if (!st.owner || st.mortgaged) return 0;
  if (cell.type === 'prop') {
    if (st.houses > 0) return cell.rent[st.houses];
    const full = GROUP_CELLS[cell.group].every((i) => room.cells[i].owner === st.owner);
    return cell.rent[0] * (full ? 2 : 1);
  }
  if (cell.type === 'ferry') {
    const n = FERRY_INDEXES.filter((i) => room.cells[i].owner === st.owner).length;
    return cell.rent[Math.max(0, n - 1)];
  }
  if (cell.type === 'util') {
    const n = UTIL_INDEXES.filter((i) => room.cells[i].owner === st.owner).length;
    return (diceSum || 7) * (n >= 2 ? UTIL_RENT_BOTH : UTIL_RENT_PER_PIP);
  }
  return 0;
}

// ─────────────────────────── 卡牌 ───────────────────────────
// forced：测试模式直接指定一张卡（不打乱牌堆指针，方便反复复现）
function drawCard(room, p, which, depth, forced) {
  const isChance = which === 'chance';
  const deck = isChance ? CHANCE : CHEST;
  const order = isChance ? room.chanceOrder : room.chestOrder;
  const ptrKey = isChance ? 'chancePtr' : 'chestPtr';
  const card = forced || deck[order[room[ptrKey] % order.length]];
  if (!forced) room[ptrKey]++;

  // 先把这张卡对现金的影响算清楚，播报只发一条：卡面 + 总金额
  const others = card.payEach ? activePlayers(room).filter((o) => o.id !== p.id) : [];
  let feeTotal = 0;
  if (card.feePerHouse || card.feePerHotel) {
    room.cells.forEach((c) => {
      if (c.owner !== p.id) return;
      feeTotal += c.houses === 5 ? (card.feePerHotel || 0) : c.houses * (card.feePerHouse || 0);
    });
  }
  // 只折进卡面自带的收支（card.money / payEach / 修房费）；「回到起点」这类要靠移动
  // 才产生的津贴不折进来，走 salary() 单独播一条带金额的
  let moneyDelta = card.money || 0;
  if (card.payEach) moneyDelta -= card.payEach * others.length;
  if (card.payAll) moneyDelta -= card.payAll;
  if (feeTotal > 0) moneyDelta -= feeTotal;
  pushLog(room, `${isChance ? '极光卡' : '命运卡'} · ${card.title}：${card.text}`, 'card', moneyDelta);

  if (card.money > 0) {
    p.cash += card.money;
  } else if (card.money < 0) {
    // 金额已经在卡面那条里播过，这里只记账
    charge(room, p, -card.money, card.title, null, { quiet: true });
  }
  if (card.jailCard) {
    addHeld(p, { kind: 'jail', title: '免费渡轮票', text: '可免除一次入狱，被关押时直接使用' });
    // 卡面已经说明拿到免罪票，这里只留日志，不重复播报
    pushLog(room, `${p.name} 获得一张免费渡轮票（免罪卡）`, 'card', 0, { quiet: true });
  }
  if (card.hold === 'rent') {
    addHeld(p, { kind: 'rent', title: card.title, text: '付租时自动抵掉一半，用掉即消失' });
    pushLog(room, `${p.name} 收好「${card.title}」，付租时能抵一半`, 'card', 0, { quiet: true });
  }
  if (card.jail) {
    sendToJail(room, p, { quiet: true });
    return;
  }
  if (card.payEach) {
    others.forEach((o) => charge(room, p, card.payEach, card.title, o, { quiet: true }));
  }
  if (card.payAll) {
    // 「社区维护费」一类：每位存活玩家（含抽卡者）各向银行缴 card.payAll
    activePlayers(room).forEach((o) => charge(room, o, card.payAll, card.title, null, { quiet: true }));
  }
  if (feeTotal > 0) {
    charge(room, p, feeTotal, card.title, null, { quiet: true });
  } else if (card.feePerHouse || card.feePerHotel) {
    pushLog(room, `${p.name} 名下连一间渔屋都没有，风暴只刮走了一顶帽子`, 'card');
  }
  if (card.skip) {
    room.canRoll = false;
    room.rollAgain = false;
    // 卡面已经写了「停留一回合」，这条只进日志
    pushLog(room, `${p.name} 本回合被迫停留`, 'card', 0, { quiet: true });
    return;
  }
  if (typeof card.back === 'number') {
    // 先按骰子走到卡格（上一段已经记过），再一步步退回去，别把两段合并成一次到位
    const before = p.pos;
    p.pos = (p.pos - card.back + BOARD_SIZE) % BOARD_SIZE;
    markMove(room, p, before, p.pos, 'back');
    resolveLanding(room, p, depth + 1);
    return;
  }
  if (typeof card.moveTo === 'number' || card.moveToName) {
    const target = card.moveToName ? INDEX_BY_NAME.get(card.moveToName) : card.moveTo;
    if (typeof target !== 'number') return;
    const passed = target <= p.pos;
    const before = p.pos;
    p.pos = target;
    // 「前往某地」一律顺时针前进（可能绕过起点领津贴），同样是接着上一段走
    markMove(room, p, before, p.pos, 'walk');
    if (passed) salary(room, p, { landed: target === 0 });
    resolveLanding(room, p, depth + 1, { salaryPaid: passed });
  }
}

// ─────────────────────────── 金钱 ───────────────────────────
function liquidate(room, p, need) {
  let guard = 0;
  while (p.cash < need && guard++ < 80) {
    // 先卖房（优先房源最多的地块）。酒店拆回 4 栋房屋，需要银行有房屋可给
    const built = room.cells
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.owner === p.id && x.c.houses > 0)
      .filter((x) => x.c.houses < 5 || room.bank.houses >= 4)
      .sort((a, b) => b.c.houses - a.c.houses);
    if (built.length) {
      const { c, i } = built[0];
      const cost = G(i).houseCost || 0;
      if (c.houses === 5) {
        c.houses = 4;
        room.bank.hotels++;
        room.bank.houses -= 4;
        p.cash += Math.floor(cost / 2) * 5;
        pushLog(room, `${p.name} 忍痛拆掉「${G(i).name}」的酒店换现金`, 'money', Math.floor(cost / 2) * 5);
      } else {
        c.houses--;
        room.bank.houses++;
        p.cash += Math.floor(cost / 2);
        pushLog(room, `${p.name} 卖掉「${G(i).name}」的一栋木屋`, 'money', Math.floor(cost / 2));
      }
      continue;
    }
    // 再抵押无建筑的地产
    const free = room.cells
      .map((c, i) => ({ c, i }))
      .filter((x) => x.c.owner === p.id && !x.c.mortgaged && x.c.houses === 0)
      .sort((a, b) => G(a.i).price - G(b.i).price);
    if (free.length) {
      const { c, i } = free[0];
      c.mortgaged = true;
      const v = Math.floor(G(i).price / 2);
      p.cash += v;
      pushLog(room, `${p.name} 急售「${G(i).name}」的抵押权，换回 ${kr(v)}`, 'money', v);
      continue;
    }
    break;
  }
}

function charge(room, p, amount, reason, creditor = null, opts = {}) {
  if (amount <= 0) return true;
  if (p.cash < amount) liquidate(room, p, amount);
  if (p.cash < amount) {
    const paid = p.cash;
    p.cash = 0;
    if (creditor) creditor.cash += paid;
    pushLog(room, `${p.name} 把口袋翻了个底朝天，也凑不出 ${kr(amount)}（${reason}）`, 'bad', -paid);
    bankrupt(room, p, creditor);
    return false;
  }
  p.cash -= amount;
  if (creditor) {
    creditor.cash += amount;
    if (!opts.quiet) pushLog(room, `${p.name} 把 ${kr(amount)} 塞进 ${creditor.name} 手里 · ${reason}`, 'rent', -amount);
  } else if (!opts.quiet) {
    pushLog(room, `${p.name} 向银行上缴 ${kr(amount)} · ${reason}`, 'money', -amount);
  }
  return true;
}

function bankrupt(room, p, creditor) {
  p.bankrupt = true;
  p.cash = 0;
  const owned = room.cells.map((c, i) => (c.owner === p.id ? i : -1)).filter((i) => i >= 0);
  owned.forEach((i) => {
    const c = room.cells[i];
    if (creditor) {
      c.owner = creditor.id;
      c.mortgaged = !!c.mortgaged;
      if (c.houses > 0) {
        room.bank.houses += c.houses === 5 ? 0 : c.houses;
        room.bank.hotels += c.houses === 5 ? 1 : 0;
        c.houses = 0;
      }
    } else {
      c.owner = null;
      c.houses = 0;
      c.mortgaged = false;
    }
  });
  pushLog(room, `${p.name} 的渔船靠岸了，从此退出罗弗敦的争夺${creditor ? `，地契全数归 ${creditor.name}` : '，地契收归银行'}`, 'bad');
  const alive = activePlayers(room);
  if (alive.length <= 1) {
    room.phase = 'ended';
    room.winnerId = alive[0]?.id || null;
    room.pending = null;
    pushLog(room, alive[0] ? `${alive[0].name} 成为罗弗敦的新领主！` : '全岛无人幸免', 'win');
    return;
  }

  // 在自己回合破产：必须立刻跳过他的回合，否则没人能点「结束回合」
  if (room.players[room.current]?.id !== p.id) return;
  room.pending = null;
  room.trade = null;
  room.dice = [0, 0];
  room.canRoll = false;
  room.rollAgain = false;
  room.doubles = 0;
  let guard = 0;
  do {
    room.current = (room.current + 1) % room.players.length;
    guard++;
  } while (room.players[room.current].bankrupt && guard < 50);
  room.turnNo++;
  if (room.turnLimit > 0 && room.turnNo > room.turnLimit) {
    endByWorth(room);
    return;
  }
  beginTurn(room);
}

// ─────────────────────────── 交易 ───────────────────────────
function offerTrade(room, p, data) {
  if (room.phase !== 'playing') return { error: '游戏未开始' };
  if (cur(room).id !== p.id) return { error: '只能在自己的回合发起交易' };
  if (room.pending) return { error: '先处理当前的决定' };
  const to = byId(room, data.to);
  if (!to || to.bankrupt || to.id === p.id) return { error: '对方不能交易' };
  const give = (data.give || []).filter((i) => Number.isInteger(i) && room.cells[i]?.owner === p.id);
  const get = (data.get || []).filter((i) => Number.isInteger(i) && room.cells[i]?.owner === to.id);
  const giveCash = Math.max(0, Math.min(999999, Math.floor(+data.giveCash || 0)));
  const getCash = Math.max(0, Math.min(999999, Math.floor(+data.getCash || 0)));
  if (giveCash > p.cash) return { error: '现金不够' };
  if (getCash > to.cash) return { error: '对方现金不够' };
  if (!give.length && !get.length && !giveCash && !getCash) return { error: '交易内容为空' };
  room.trade = {
    from: p.id, to: to.id, give, get, giveCash, getCash,
    fromName: p.name, toName: to.name,
  };
  if (p.isBot) p.botTradeTried = true;
  pushLog(room, `${p.name} 向 ${to.name} 发起交易`, 'trade');
  return { ok: true };
}

function respondTrade(room, p, accept) {
  const t = room.trade;
  if (!t) return { error: '没有待处理的交易' };
  if (t.to !== p.id) return { error: '这不是给你的交易' };
  const from = byId(room, t.from);
  if (!from) { room.trade = null; return { error: '对方已离开' }; }
  if (!accept) {
    room.trade = null;
    pushLog(room, `${p.name} 拒绝了交易`, 'trade');
    return { ok: true };
  }
  if (t.giveCash > from.cash || t.getCash > p.cash) {
    room.trade = null;
    return { error: '现金不足，交易取消' };
  }
  t.give.forEach((i) => { room.cells[i].owner = p.id; });
  t.get.forEach((i) => { room.cells[i].owner = from.id; });
  from.cash = from.cash - t.giveCash + t.getCash;
  p.cash = p.cash + t.giveCash - t.getCash;
  room.trade = null;
  pushLog(room, `${from.name} 与 ${p.name} 达成交易`, 'trade');
  return { ok: true };
}

// ─────────────────────────── 动作入口 ───────────────────────────
// ─────────────────────────── 局内聊天 ───────────────────────────
const CHAT_MAX = 60;
const CHAT_KEEP = 60;

function chat(room, p, text) {
  const clean = String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // 换行、控制字符一律压成空格
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CHAT_MAX);
  if (!clean) return { error: '说点什么吧' };
  const now = Date.now();
  if (p.lastChatAt && now - p.lastChatAt < 500) return { ok: true, skipped: true }; // 防止刷屏
  p.lastChatAt = now;
  if (!Array.isArray(room.chat)) room.chat = [];
  room.chat.push({ id: uid(), pid: p.id, name: p.name, color: p.color, text: clean, ts: now });
  if (room.chat.length > CHAT_KEEP) room.chat.splice(0, room.chat.length - CHAT_KEEP);
  return { ok: true };
}

// 这些操作会让棋子动起来，每次都重新开一条位移轨迹
const MOVE_ACTIONS = new Set(['roll', 'jailRoll', 'debugMove', 'debugGoTo', 'debugCard']);

export function act(room, playerId, action) {
  const p = byId(room, playerId);
  if (!p) return { error: '玩家不存在' };
  const type = action?.type;

  if (type === 'chat') return chat(room, p, action.text);
  if (type === 'start') return startGame(room, playerId);
  if (type === 'setLimit') {
    if (room.hostId !== playerId) return { error: '只有房主可以设置' };
    if (room.phase !== 'lobby') return { error: '对局已经开始' };
    const n = Number(action.turnLimit);
    room.turnLimit = n === 0 || (Number.isFinite(n) && n >= 10 && n <= 300) ? n : 80;
    return { ok: true };
  }
  if (type === 'addBot') return addBot(room, playerId);
  if (type === 'removeBot') return removeBot(room, playerId, action.playerId);
  // 测试模式的开关放在局外也能用：这样可以从大厅直接开一局单人测试
  if (type === 'setDebug') {
    if (room.hostId !== playerId) return { error: '只有房主能开关测试模式' };
    room.debug = !!action.on;
    pushLog(room, `🧪 ${p.name}${room.debug ? '开启了' : '关闭了'}测试模式`, 'sys', 0, { quiet: true });
    return { ok: true };
  }
  if (type === 'rollOrder') return rollOrder(room, p);
  if (type === 'restart') {
    if (room.hostId !== playerId) return { error: '只有房主可以重开' };
    if (room.phase !== 'ended') return { error: '本局还没结束' };
    room.phase = 'lobby';
    room.log = [];
    room.pending = null;
    room.trade = null;
    room.dice = [0, 0];
    room.canRoll = false;
    room.rollAgain = false;
    room.doubles = 0;
    room.current = 0;
    room.turnNo = 1;
    room.winnerId = null;
    room.endReason = null;
    room.trails = {};
    room.moveSeq = (room.moveSeq || 0) + 1;
    room.players.forEach((x) => {
      x.bankrupt = false;
      x.cash = START_CASH;
      x.pos = 0;
      x.inJail = false;
      x.cards = 0;
      x.held = [];
      x.jailTurns = 0;
      x.orderRoll = null; // 下一局重新掷骰定序
    });
    room.cells = BOARD.map(() => ({ owner: null, houses: 0, mortgaged: false }));
    pushLog(room, '房主重开了房间，等待新玩家', 'sys');
    return { ok: true };
  }
  if (room.phase !== 'playing') return { error: '游戏还没有开始' };
  if (p.bankrupt) return { error: '你已经出局了' };
  const isTurn = cur(room)?.id === p.id;

  const run = () => dispatch(room, p, action, isTurn);
  // 会移动棋子的操作：开新的位移轨迹，前端据此一段一段演。
  // 被拒时（比如"先处理当前的决定"）要把旧轨迹还回去——否则前端拿到一条空轨迹，
  // 会把还没演完的那段路程直接吞掉，棋子就地闪现到终点。
  if (!MOVE_ACTIONS.has(type)) return run();
  const savedTrails = room.trails;
  const savedSeq = room.moveSeq;
  room.trails = {};
  room.moveSeq = (room.moveSeq || 0) + 1;
  const res = run();
  if (res && res.error) {
    room.trails = savedTrails;
    room.moveSeq = savedSeq;
  }
  return res;
}

function dispatch(room, p, action, isTurn) {
  const type = action?.type;
  switch (type) {
    case 'roll': {
      if (!isTurn) return { error: '还没轮到你' };
      if (!room.canRoll) return { error: '现在不能掷骰' };
      if (room.pending) return { error: '先处理当前的决定' };
      const d1 = 1 + ri(6);
      const d2 = 1 + ri(6);
      room.dice = [d1, d2];
      const isDouble = d1 === d2;
      room.doubles = isDouble ? room.doubles + 1 : 0;
      room.canRoll = false;
      pushLog(room, `${p.name} 把骰子扣在掌心一摇：${d1} + ${d2} = ${d1 + d2}${isDouble ? ' · 对子！' : ''}`, 'roll');

      if (isDouble && room.doubles >= 3) {
        pushLog(room, `连续三次对子，${p.name} 被带走了`, 'jail');
        sendToJail(room, p);
        room.rollAgain = false;
        return { ok: true };
      }

      const gotSalary = moveBy(room, p, d1 + d2);
      resolveLanding(room, p, 0, { salaryPaid: gotSalary });
      room.rollAgain = isDouble && !p.inJail;
      if (!room.pending && room.rollAgain) {
        room.canRoll = true;
        pushLog(room, `对子奖励，${p.name} 可以再掷一次`, 'roll');
      }
      return { ok: true };
    }

    case 'buy': {
      const pend = room.pending;
      if (!pend || pend.type !== 'buy') return { error: '现在没有可买的地产' };
      if (!isTurn) return { error: '还没轮到你' };
      const idx = pend.index;
      const cell = G(idx);
      if (room.cells[idx].owner) return { error: '已经有主了' };
      if (p.cash < cell.price) return { error: '现金不够' };
      p.cash -= cell.price;
      room.cells[idx].owner = p.id;
      room.pending = null;
      pushLog(room, `${p.name} 把 ${kr(cell.price)} 拍在柜台上，「${cell.name}」归自己了`, 'buy', -cell.price);
      if (room.rollAgain && !p.inJail) room.canRoll = true;
      return { ok: true };
    }

    case 'pass': {
      const pend = room.pending;
      if (!pend || pend.type !== 'buy') return { error: '没有待决定的购买' };
      if (!isTurn) return { error: '还没轮到你' };
      pushLog(room, `${p.name} 放弃了「${G(pend.index).name}」`, 'sys');
      room.pending = null;
      if (room.rollAgain && !p.inJail) room.canRoll = true;
      return { ok: true };
    }

    case 'endTurn': {
      if (!isTurn) return { error: '还没轮到你' };
      return endTurn(room);
    }

    case 'jailPay': {
      if (!isTurn) return { error: '还没轮到你' };
      if (!p.inJail) return { error: '你不在监狱' };
      if (p.cash < JAIL_FINE) return { error: '现金不够支付保释金' };
      p.cash -= JAIL_FINE;
      p.inJail = false;
      p.jailTurns = 0;
      room.pending = null;
      room.canRoll = true;
      pushLog(room, `${p.name} 掏了 ${kr(JAIL_FINE)} 保释金，铁门在身后哐当一声`, 'jail', -JAIL_FINE);
      return { ok: true };
    }

    case 'jailCard': {
      if (!isTurn) return { error: '还没轮到你' };
      if (!p.inJail) return { error: '你不在监狱' };
      if (p.cards < 1) return { error: '你没有免罪卡' };
      const used = spendHeld(p, 'jail');
      p.inJail = false;
      p.jailTurns = 0;
      room.pending = null;
      room.canRoll = true;
      pushLog(room, `${p.name} 用${used ? `「${used.title}」` : '免费渡轮票'}出狱`, 'jail');
      return { ok: true };
    }

    case 'jailRoll': {
      if (!isTurn) return { error: '还没轮到你' };
      if (!p.inJail) return { error: '你不在监狱' };
      const d1 = 1 + ri(6);
      const d2 = 1 + ri(6);
      room.dice = [d1, d2];
      pushLog(room, `${p.name} 在狱中掷出 ${d1} + ${d2}`, 'roll');
      if (d1 === d2) {
        p.inJail = false;
        p.jailTurns = 0;
        room.pending = null;
        room.canRoll = false;
        room.rollAgain = false;
        pushLog(room, `对子！${p.name} 重获自由并前进 ${d1 + d2} 格`, 'jail');
        const gotSalary = moveBy(room, p, d1 + d2);
        resolveLanding(room, p, 0, { salaryPaid: gotSalary });
        return { ok: true };
      }
      p.jailTurns++;
      if (p.jailTurns >= 3) {
        if (p.cash < JAIL_FINE) liquidate(room, p, JAIL_FINE);
        p.cash = Math.max(0, p.cash - JAIL_FINE);
        p.inJail = false;
        p.jailTurns = 0;
        room.pending = null;
        pushLog(room, `${p.name} 三次未掷出对子，缴纳保释金后出狱并前进 ${d1 + d2} 格`, 'jail');
        const gotSalary = moveBy(room, p, d1 + d2);
        resolveLanding(room, p, 0, { salaryPaid: gotSalary });
        return { ok: true };
      }
      room.pending = null;
      room.canRoll = false;
      pushLog(room, `${p.name} 仍被关押（${p.jailTurns}/3）`, 'jail');
      return { ok: true };
    }

    // ── 测试模式：手动摆位 / 指定抽卡，用来复现那些很难碰上的情形 ──
    // （开关 setDebug 在局内外都能用，见 act() 顶部）
    case 'debugMove': {
      if (!room.debug) return { error: '测试模式没开' };
      if (!isTurn) return { error: '还没轮到你' };
      if (room.pending) return { error: '先处理当前的决定' };
      let steps = Math.trunc(Number(action.steps) || 0);
      steps = Math.max(-39, Math.min(39, steps));
      if (!steps) return { error: '请输入格数' };
      room.dice = [0, 0];
      pushLog(room, `🧪 测试：${p.name} 直接走 ${steps > 0 ? '前进' : '后退'} ${Math.abs(steps)} 格`, 'sys', 0, { quiet: true });
      const gotSalary = moveBy(room, p, steps);
      resolveLanding(room, p, 0, { salaryPaid: gotSalary });
      room.canRoll = false;
      room.rollAgain = false;
      return { ok: true };
    }
    case 'debugGoTo': {
      if (!room.debug) return { error: '测试模式没开' };
      if (!isTurn) return { error: '还没轮到你' };
      if (room.pending) return { error: '先处理当前的决定' };
      const target = Math.trunc(Number(action.index));
      if (!(target >= 0 && target < BOARD_SIZE)) return { error: '格子不存在' };
      const steps = (target - p.pos + BOARD_SIZE) % BOARD_SIZE;
      room.dice = [0, 0];
      pushLog(room, `🧪 测试：${p.name} 前往第 ${target} 格「${G(target).name}」`, 'sys', 0, { quiet: true });
      const gotSalary = moveBy(room, p, steps);
      resolveLanding(room, p, 0, { salaryPaid: gotSalary });
      room.canRoll = false;
      room.rollAgain = false;
      return { ok: true };
    }
    case 'debugCard': {
      if (!room.debug) return { error: '测试模式没开' };
      if (!isTurn) return { error: '还没轮到你' };
      if (room.pending) return { error: '先处理当前的决定' };
      const which = action.which === 'chest' ? 'chest' : 'chance';
      const deck = which === 'chest' ? CHEST : CHANCE;
      const card = deck[Math.trunc(Number(action.index))];
      if (!card) return { error: '没有这张卡' };
      room.dice = [0, 0];
      // 和真实游戏一致：先顺时针走到最近的同类卡格，站上去才抽这张卡，
      // 这样卡片里的位移（后退 / 前往 / 进监狱）都是从卡格出发的，看得清清楚楚
      const spot = nearestCardCell(p.pos, which);
      if (spot >= 0 && spot !== p.pos) {
        pushLog(
          room,
          `🧪 测试：${p.name} 先顺时针走到第 ${spot} 格「${G(spot).name}」`,
          'sys',
        );
        moveBy(room, p, (spot - p.pos + BOARD_SIZE) % BOARD_SIZE);
        // 这里不调 resolveLanding：卡格落地本该抽一张随机的，
        // 而我们要的是下面那张自己指定的卡，别又冒出一张来
      }
      pushLog(
        room,
        `🧪 测试：${p.name} 抽${which === 'chest' ? '命运卡' : '极光卡'}「${card.title}」`,
        'sys', 0, { quiet: true },
      );
      drawCard(room, p, which, 0, card);
      room.canRoll = false;
      room.rollAgain = false;
      return { ok: true };
    }

    case 'build': {
      const idx = action.index;
      if (!isTurn) return { error: '只能在自己的回合建造' };
      if (room.pending) return { error: '先处理当前的决定' };
      return buildHouse(room, p, idx);
    }

    case 'sellHouse': {
      if (!isTurn) return { error: '只能在自己的回合操作' };
      return sellHouse(room, p, action.index);
    }

    case 'mortgage': {
      if (!isTurn) return { error: '只能在自己的回合操作' };
      return mortgage(room, p, action.index);
    }

    case 'unmortgage': {
      if (!isTurn) return { error: '只能在自己的回合操作' };
      return unmortgage(room, p, action.index);
    }

    case 'offerTrade':
      return offerTrade(room, p, action);

    case 'respondTrade':
      return respondTrade(room, p, !!action.accept);

    default:
      return { error: '未知操作' };
  }
}

function buildHouse(room, p, idx) {
  const cell = G(idx);
  const st = room.cells[idx];
  if (cell.type !== 'prop') return { error: '这里不能建造' };
  if (st.owner !== p.id) return { error: '这不是你的地产' };
  if (st.mortgaged) return { error: '抵押中的地产不能建造' };
  const groupIdx = GROUP_CELLS[cell.group];
  if (!groupIdx.every((i) => room.cells[i].owner === p.id)) return { error: '需要集齐同色地块' };
  if (groupIdx.some((i) => room.cells[i].mortgaged)) return { error: '同色地块有抵押，先赎回' };
  if (st.houses >= 5) return { error: '已经建到酒店了' };
  const min = Math.min(...groupIdx.map((i) => room.cells[i].houses));
  if (st.houses > min) return { error: '必须平均建造' };
  if (p.cash < cell.houseCost) return { error: '现金不够' };
  if (st.houses === 4) {
    if (room.bank.hotels < 1) return { error: '银行没有酒店了' };
    room.bank.hotels--;
    room.bank.houses += 4; // 4 栋房屋退回银行，换 1 座酒店
  } else {
    if (room.bank.houses < 1) return { error: '银行没有房屋了' };
    room.bank.houses--;
  }
  p.cash -= cell.houseCost;
  st.houses++;
  pushLog(room, `${p.name} 在「${cell.name}」${st.houses === 5 ? '挂上招牌，渔屋升级成酒店 🏨' : `钉好了第 ${st.houses} 栋木屋`}`, 'build', -cell.houseCost);
  return { ok: true };
}

function sellHouse(room, p, idx) {
  const cell = G(idx);
  const st = room.cells[idx];
  if (st.owner !== p.id) return { error: '这不是你的地产' };
  if (st.houses <= 0) return { error: '这里没有建筑' };
  const groupIdx = GROUP_CELLS[cell.group];
  const max = Math.max(...groupIdx.map((i) => room.cells[i].houses));
  if (st.houses < max) return { error: '必须平均拆除' };
  if (st.houses === 5) {
    if (room.bank.houses < 4) return { error: '银行房屋不足 4 栋，酒店无法拆回房屋' };
    room.bank.hotels++;
    room.bank.houses -= 4;
    p.cash += Math.floor(cell.houseCost / 2) * 5;
  } else {
    room.bank.houses++;
    p.cash += Math.floor(cell.houseCost / 2);
  }
  st.houses--;
  pushLog(room, `${p.name} 把「${cell.name}」的一处建筑拆成木料变卖`, 'build', st.houses === 4 ? Math.floor(cell.houseCost / 2) * 5 : Math.floor(cell.houseCost / 2));
  return { ok: true };
}

function mortgage(room, p, idx) {
  const cell = G(idx);
  const st = room.cells[idx];
  if (st.owner !== p.id) return { error: '这不是你的地产' };
  if (st.mortgaged) return { error: '已经抵押了' };
  if (cell.type === 'prop' && GROUP_CELLS[cell.group].some((i) => room.cells[i].houses > 0)) {
    return { error: '同色地块还有建筑，先拆掉' };
  }
  st.mortgaged = true;
  const v = Math.floor(cell.price / 2);
  p.cash += v;
  pushLog(room, `${p.name} 把「${cell.name}」押给银行，换回 ${kr(v)}`, 'money', v);
  return { ok: true };
}

function unmortgage(room, p, idx) {
  const cell = G(idx);
  const st = room.cells[idx];
  if (st.owner !== p.id) return { error: '这不是你的地产' };
  if (!st.mortgaged) return { error: '没有抵押' };
  const cost = Math.ceil((cell.price / 2) * 1.1);
  if (p.cash < cost) return { error: `赎回需要 ${kr(cost)}` };
  p.cash -= cost;
  st.mortgaged = false;
  pushLog(room, `${p.name} 还清欠款，赎回了「${cell.name}」`, 'money', -cost);
  return { ok: true };
}

export { rooms };
