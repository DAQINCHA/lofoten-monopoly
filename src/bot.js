// 罗弗敦大富翁 —— 机器人决策
// 纯函数：只读取 room 状态，返回下一步动作，不修改任何状态。
import { BOARD, GROUP_CELLS, JAIL_FINE } from './board.js';

export const BOT_NAMES = [
  '奥拉夫船长',
  '渔女英格丽',
  '海鹦观察员',
  '鳕鱼王',
  '极光猎人',
  '山妖奶奶',
  '灯塔看守人',
  '晒鱼架老陈',
];

const ownedInGroup = (room, group, ownerId) =>
  GROUP_CELLS[group].filter((i) => room.cells[i].owner === ownerId).length;

const isFullGroup = (room, group, ownerId) =>
  ownedInGroup(room, group, ownerId) === GROUP_CELLS[group].length;

// 地块对某人的价值（不含成套溢价）
function baseValue(room, i) {
  const c = BOARD[i];
  const st = room.cells[i];
  let v = c.price;
  if (st.houses > 0) v += (c.houseCost || 0) * st.houses * 0.85;
  if (st.mortgaged) v *= 0.55;
  return v;
}

function playerCashReserve(p) {
  return 12000;
}

// ─────────────────────────── 买地 ───────────────────────────
function shouldBuy(room, p, idx) {
  const cell = BOARD[idx];
  if (p.cash < cell.price) return false;
  const after = p.cash - cell.price;

  const completes =
    !!cell.group && ownedInGroup(room, cell.group, p.id) === GROUP_CELLS[cell.group].length - 1;

  // 就差这一块成套：几乎必买
  if (completes) return after >= 3000;

  // 挡住别人成套
  const blocks =
    !!cell.group &&
    GROUP_CELLS[cell.group].some((x) => {
      const o = room.cells[x].owner;
      if (!o || o === p.id) return false;
      return ownedInGroup(room, cell.group, o) === GROUP_CELLS[cell.group].length - 1;
    });
  if (blocks) return after >= 7000;

  if (after < playerCashReserve(p)) return false;
  if (cell.type === 'ferry') return after >= 18000;
  if (cell.type === 'util') return after >= 26000;
  return after >= 14000;
}

// ─────────────────────────── 建造 / 赎回 ───────────────────────────
function chooseBuild(room, p) {
  if (p.cash < 16000) return null;
  let best = null;
  for (const group of Object.keys(GROUP_CELLS)) {
    if (!isFullGroup(room, group, p.id)) continue;
    const cells = GROUP_CELLS[group];
    if (cells.some((i) => room.cells[i].mortgaged)) continue;
    const min = Math.min(...cells.map((i) => room.cells[i].houses));
    if (min >= 5) continue;
    const candidates = cells.filter((i) => room.cells[i].houses === min);
    for (const i of candidates) {
      const cost = BOARD[i].houseCost || 0;
      if (p.cash - cost < 14000) continue;
      // 银行库存不够就别点，否则会反复点同一块地
      if (min === 4) {
        if (room.bank.hotels < 1 || room.bank.houses < 4) continue;
      } else if (room.bank.houses < 1) continue;
      // 优先选择地价更高（租金基数更高）的色组与地块
      const score = BOARD[i].price + min * 4000;
      if (!best || score > best.score) best = { score, index: i };
    }
  }
  return best ? { type: 'build', index: best.index } : null;
}

function chooseUnmortgage(room, p) {
  if (p.cash < 70000) return null;
  const free = room.cells
    .map((c, i) => ({ c, i }))
    .filter((x) => x.c.owner === p.id && x.c.mortgaged)
    .sort((a, b) => BOARD[b.i].price - BOARD[a.i].price);
  if (!free.length) return null;
  const { c, i } = free[0];
  const cost = Math.ceil((BOARD[i].price / 2) * 1.1);
  if (p.cash - cost < 40000) return null;
  return { type: 'unmortgage', index: i };
}

// ─────────────────────────── 交易评估 ───────────────────────────
function evaluateTrade(room, p, t) {
  // p 是收到报价的一方：获得 t.give 的地产 + t.giveCash，付出 t.get 的地产 + t.getCash
  let gain = t.giveCash;
  let cost = t.getCash;
  const offerer = room.players.find((x) => x.id === t.from);

  for (const i of t.give) {
    let v = baseValue(room, i);
    const group = BOARD[i].group;
    if (group && ownedInGroup(room, group, p.id) === GROUP_CELLS[group].length - 1) {
      v *= 1.75; // 补齐成套，值钱得多
    }
    gain += v;
  }

  for (const i of t.get) {
    let v = baseValue(room, i);
    const group = BOARD[i].group;
    if (
      group &&
      offerer &&
      ownedInGroup(room, group, offerer.id) === GROUP_CELLS[group].length - 1
    ) {
      v *= 2.1; // 把成套的最后一块交出去，得加钱
    }
    cost += v;
  }

  if (p.cash - t.getCash < playerCashReserve(p)) return false;
  if (gain <= 0) return false;
  return gain >= cost * 1.03;
}

// ─────────────────────────── 主动收购：补齐自己的色组 ───────────────────────────
// 只找持有自己缺口的「机器人」出价，避免报价闪一下就没了。
function chooseTrade(room, p) {
  if (p.botTradeTried || room.trade) return null;
  if (p.cash < 40000) return null;

  let best = null;
  for (const group of Object.keys(GROUP_CELLS)) {
    const cells = GROUP_CELLS[group];
    const mine = cells.filter((i) => room.cells[i].owner === p.id).length;
    if (mine !== cells.length - 1) continue;
    const missing = cells.find((i) => room.cells[i].owner && room.cells[i].owner !== p.id);
    if (missing === undefined) continue; // 缺口还空着，等别人买走再说
    const owner = room.players.find((x) => x.id === room.cells[missing].owner);
    if (!owner || !owner.isBot || owner.bankrupt) continue;

    // 对方心里的底价：最后一块会被抬高 2.1 倍
    const price = Math.ceil(baseValue(room, missing) * 2.1 * 1.08);
    if (p.cash - price < 22000) continue;
    const score = BOARD[missing].price;
    if (!best || score > best.score) best = { score, to: owner.id, index: missing, price };
  }
  if (!best) return null;
  return { type: 'offerTrade', to: best.to, give: [], get: [best.index], giveCash: best.price, getCash: 0 };
}

// ─────────────────────────── 主入口 ───────────────────────────
export function chooseBotAction(room, p) {
  // 1) 待回应的交易（可能不在自己的回合）
  if (room.trade && room.trade.to === p.id) {
    return { type: 'respondTrade', accept: evaluateTrade(room, p, room.trade) };
  }

  if (room.phase !== 'playing') return null;
  if (room.players[room.current]?.id !== p.id) return null;

  // 2) 监狱
  if (p.inJail && room.pending?.type === 'jail') {
    if (p.cards > 0) return { type: 'jailCard' };
    if (p.cash > JAIL_FINE + 22000) return { type: 'jailPay' };
    return { type: 'jailRoll' };
  }

  // 3) 买地决策
  if (room.pending?.type === 'buy') {
    const idx = room.pending.index;
    return shouldBuy(room, p, idx) ? { type: 'buy' } : { type: 'pass' };
  }

  // 4) 掷骰
  if (room.canRoll) return { type: 'roll' };

  if (room.pending) return null;

  // 5) 建造 → 赎回 → 收购缺口 → 结束回合
  const build = chooseBuild(room, p);
  if (build) return build;
  const unm = chooseUnmortgage(room, p);
  if (unm) return unm;
  const trade = chooseTrade(room, p);
  if (trade) return trade;

  return { type: 'endTurn' };
}
