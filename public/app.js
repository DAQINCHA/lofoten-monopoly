// 罗弗敦大富翁 —— 前端
import { initAudio, sfx, audioState, setMusicVol, setSfxVol, toggleMuted, onAudioChange } from './audio.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const store = {
  board: [],
  groups: {},
  meta: {},
  decks: { chance: [], chest: [] },
  state: null,
  me: null,
  room: null,
  token: null,
  es: null,
  cellEls: [],
  tokenEls: new Map(),
  viewPos: new Map(),
  moveQ: new Map(),      // 棋子待走的分段轨迹：pid -> [{from, to, mode}]
  pathStash: new Map(),  // 暂时接不上的轨迹（上一段还没走完 / 棋子不在弧上），等走到再接
  moveSeq: -1,           // 已消费过的轨迹编号
  moveHold: false,       // 多段位移之间按住棋子，先把播报放出来
  moveHoldTimer: null,   // 兜底：一直没有播报也要继续走
  moveResumeTimer: null, // 播报出现后的倒计时
  moveHoldPid: null,     // 被按住的是哪个棋子（预备动画要落在它身上）
  moveHint: null,        // 下一段的去向提示，插进下一条播报卡片里
  cashPrev: new Map(),   // 上一次的现金，用来算卡片上的浮动金额
  cashFxQueue: [],       // 待播的金额变化，等对应播报上屏才飘
  cashFxTimer: null,     // 兜底：等太久也放出来
  moveTimer: null,
  actionsStaleTimer: null, // 走子期间按钮是禁用的，等落地后再渲染一次放开
  jailFxTimers: new Map(), // 押送进监狱的落地动作，播完就摘掉 class（按棋子 / 格子分别计时）
  glideTimers: new Map(),  // 直线押送过程中别让逐格走的短过渡抢戏
  jailLandTimers: new Map(), // 押送落地（响闷响 + 抖动）的时刻
  diceBusyUntil: 0,
  lastTurnKey: '',
  turnKey: '',
  turnAt: 0,
  bannerUntil: 0,
  bannerQueue: [],
  bannerStack: [],
  bannerBusy: false,
  bannerWaitTimer: null,
  bannerLastShowAt: 0,
  lastLogSeq: null,
  lastAck: null,
  lastFrameAt: 0,        // 最近一次收到服务器数据的时刻，连接状态靠它续命
  moveSettleAt: 0,
  lastDice: '',
  endShown: false,
  screen: 'lobby',
  lastPlayersKey: '',
  lastLogRenderKey: '',
  lastTurnLine: '',
  cellState: [],
  boardSize: { bw: 1, tw: 16 },
};

const money = (n) => 'kr ' + Number(n).toLocaleString('en-US');
const fmt = (n) => Number(n).toLocaleString('en-US');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ────────────── API ──────────────
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  // 不能把「200 但不是 JSON」当成成功：静态托管对未知路径常常回一个 HTML 页面，
  // 那样接口就成了空对象，调用方会带着 undefined 的房间号一路走下去。
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  if (!json || typeof json !== 'object') throw new Error(`服务器没有正常响应（HTTP ${res.status}）`);
  if (!res.ok) throw new Error(json.error || '网络异常');
  if (json.error) throw new Error(json.error);
  return json;
}

// 每个操作对应一个音效；建房升到酒店时用更隆重的那一声
const ACTION_SOUND = {
  roll: 'roll', jailRoll: 'roll', rollOrder: 'roll',
  buy: 'buy', pass: 'back',
  sellHouse: 'sell', mortgage: 'sell', unmortgage: 'coin',
  jailPay: 'pay', jailCard: 'free',
  offerTrade: 'trade', respondTrade: 'trade',
  start: 'start', endTurn: 'click',
  addBot: 'click', removeBot: 'back', setLimit: 'click',
};

function actionSound(action) {
  if (action.type === 'build') {
    const st = store.state?.cells?.[action.index];
    return st && st.houses === 4 ? 'hotel' : 'build';
  }
  return ACTION_SOUND[action.type] || 'click';
}

async function act(action) {
  if (!store.room) return;
  sfx(actionSound(action));
  try {
    await api('/api/action', { roomId: store.room, token: store.token, action });
  } catch (e) {
    sfx('error');
    toast(e.message);
  }
}

// ────────────── 启动 ──────────────
async function boot() {
  // 拉棋盘的同时顺手当一次「服务端在不在」的探测：
  // 大厅里没有房间可连，但顶栏至少要说真话——是服务器正常，还是压根没有后端。
  try {
    const data = await (await fetch('/api/board')).json();
    if (!data || !Array.isArray(data.board)) throw new Error('bad board');
    store.board = data.board;
    store.groups = data.groups;
    store.meta = data.meta;
    store.decks = data.decks;
    setConn('ok', '服务器正常');
  } catch {
    setConn('bad', '未连接服务器');
    toast('连不上服务器：这个部署没有后端，请在跑 node server.js 的机器上打开');
    return;
  }
  buildBoard();
  bindUI();
  initAudio(); // 音频要等第一次用户手势才能出声，这里只做绑定

  const params = new URLSearchParams(location.search);
  const roomId = (params.get('r') || '').toUpperCase();
  const savedName = localStorage.getItem('lofoten:name') || '';
  $('#name-input').value = savedName;

  if (roomId) {
    $('#code-input').value = roomId;
    const tokenParam = params.get('t'); // 兼容从链接直接恢复身份
    if (tokenParam) localStorage.setItem('lofoten:token:' + roomId, tokenParam);
    const token = localStorage.getItem('lofoten:token:' + roomId);
    if (token) {
      try {
        const r = await api('/api/join', { roomId, token, name: savedName });
        enterRoom(r);
        return;
      } catch { /* 身份失效，走手动加入 */ }
    }
  }
  showScreen('lobby');
}

// ────────────── 测试模式：手动走子 / 指定抽卡 ──────────────
// 很多情形（入狱卡、回到起点、绕大半圈）随机很难碰上，开这个面板可以一键复现
// 开关在大厅的「🧪 测试模式 · 单人直接开局」，进房后没有单独的入口按钮，
// 面板只保留收起 / 展开（毕竟没人会在测试局里想着"关掉测试模式"）
const DP_FOLD_KEY = 'lofoten:debug-fold';

// 收起后面板只留标题栏一条，方便让开棋盘；状态存下来，下次进来还是收着的
function setDebugFold(folded) {
  const panel = $('#debug-panel');
  if (!panel) return;
  panel.classList.toggle('folded', folded);
  const btn = $('#dp-collapse');
  if (btn) {
    btn.textContent = folded ? '▸' : '▾';
    btn.title = folded ? '展开面板' : '收起面板';
    btn.setAttribute('aria-label', btn.title);
  }
  // 收起会矮一截，原来贴在屏幕下沿时得重新夹回可见范围
  const r = panel.getBoundingClientRect();
  applyPanelPos(r.left, r.top);
  try { localStorage.setItem(DP_FOLD_KEY, folded ? '1' : '0'); } catch { /* 无痕模式 */ }
}

function toggleDebugFold() {
  const panel = $('#debug-panel');
  if (panel) setDebugFold(!panel.classList.contains('folded'));
}

function onDebugClick(e) {
  const btn = e.target.closest('[data-dbg]');
  if (!btn) return;
  const kind = btn.dataset.dbg;
  const num = (sel) => Number($(sel)?.value || 0);
  if (kind === 'collapse') return toggleDebugFold();
  if (kind === 'move') return act({ type: 'debugMove', steps: Math.abs(num('#dbg-steps')) || 1 });
  if (kind === 'moveBack') return act({ type: 'debugMove', steps: -Math.abs(num('#dbg-steps')) || -1 });
  if (kind === 'goto') return act({ type: 'debugGoTo', index: num('#dbg-cell') });
  if (kind === 'chance') return act({ type: 'debugCard', which: 'chance', index: num('#dbg-chance') });
  if (kind === 'chest') return act({ type: 'debugCard', which: 'chest', index: num('#dbg-chest') });
  if (kind === 'addBot') return act({ type: 'addBot' });
  if (kind === 'removeBot') {
    // 移除最后加入的那个机器人，方便把刚才加的撤掉
    const bots = (store.state?.players || []).filter((p) => p.isBot);
    const last = bots[bots.length - 1];
    if (!last) return toast('房间里没有机器人');
    return act({ type: 'removeBot', playerId: last.id });
  }
}

// ────────────── 测试面板：按住标题栏可以拖到任意位置 ──────────────
const DP_POS_KEY = 'lofoten:debug-pos';

// 面板位置一律用 left/top 表示（CSS 里是左下角定位，拖动时要把 bottom 摘掉，
// 否则 left/top/bottom 同时生效会把面板拉成一条）
function applyPanelPos(left, top) {
  const panel = $('#debug-panel');
  if (!panel) return;
  const w = panel.offsetWidth || 320;
  const h = panel.offsetHeight || 250;
  panel.style.left = Math.max(6, Math.min(left, Math.max(6, innerWidth - w - 6))) + 'px';
  panel.style.top = Math.max(56, Math.min(top, Math.max(56, innerHeight - h - 6))) + 'px';
  panel.style.bottom = 'auto';
}

// 面板刚显示出来（尺寸才算得出来）时把位置定下来：有存过就用存的位置，否则贴左下角
function initPanelPos() {
  const panel = $('#debug-panel');
  if (!panel || panel.dataset.pos) return;
  panel.dataset.pos = '1';
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(DP_POS_KEY) || 'null'); } catch { /* 无痕模式 */ }
  if (saved && Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
    applyPanelPos(saved.left, saved.top);
  } else {
    applyPanelPos(14, innerHeight - (panel.offsetHeight || 250) - 14);
  }
}

function initDebugPanelDrag() {
  const panel = $('#debug-panel');
  const head = $('#dp-head');
  if (!panel || !head) return;

  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.dp-close')) return; // 标题栏上的关闭按钮不参与拖动
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    // 指针捕获：拖得再快、指针跑到别的元素上，事件也只会回到标题栏
    try { head.setPointerCapture(e.pointerId); } catch { /* 老浏览器 */ }
    panel.classList.add('dragging');
    const move = (ev) => applyPanelPos(ev.clientX - dx, ev.clientY - dy);
    const up = () => {
      try { head.releasePointerCapture(e.pointerId); } catch { /* 已经放开了 */ }
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      head.removeEventListener('pointercancel', up);
      panel.classList.remove('dragging');
      const rect = panel.getBoundingClientRect();
      try {
        localStorage.setItem(DP_POS_KEY, JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) }));
      } catch { /* 无痕模式 */ }
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
    head.addEventListener('pointercancel', up);
    e.preventDefault();
  });
}

// 下拉选项（40 个格子 + 两副卡）只建一次，别每次渲染都重刷
function buildDebugOptions() {
  const cell = $('#dbg-cell');
  if (cell && !cell.options.length) {
    cell.innerHTML = store.board
      .map((c, i) => `<option value="${i}">${i} · ${esc(c.name)}</option>`)
      .join('');
  }
  const fill = (sel, deck) => {
    const el = $(sel);
    if (!el || el.options.length) return;
    el.innerHTML = (deck || []).map((c, i) => `<option value="${i}">${esc(c.title)}</option>`).join('');
  };
  fill('#dbg-chance', store.decks?.chance);
  fill('#dbg-chest', store.decks?.chest);
}

function renderDebugPanel() {
  const panel = $('#debug-panel');
  if (!panel) return;
  const on = !!store.state?.debug;
  const wasHidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !on);
  if (!on) return;
  if (wasHidden) {
    let folded = false;
    try { folded = localStorage.getItem(DP_FOLD_KEY) === '1'; } catch { /* 无痕模式 */ }
    setDebugFold(folded);
    initPanelPos(); // 刚显示出来才量得到尺寸，位置在这一刻定
  }
  buildDebugOptions();
}

function bindUI() {
  $('#btn-create').addEventListener('click', createRoom);
  $('#btn-solo').addEventListener('click', soloGame);
  $('#btn-test').addEventListener('click', testModeGame);
  $('#btn-join').addEventListener('click', joinRoom);
  $('#btn-random-name').addEventListener('click', randomName);
  $('#chat-form').addEventListener('submit', sendChat);
  $('#code-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
  $('#name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') ($('#code-input').value ? joinRoom() : createRoom()); });
  $('#btn-start').addEventListener('click', () => act({ type: 'start' }));
  $('#limit-select').addEventListener('change', (e) => act({ type: 'setLimit', turnLimit: Number(e.target.value) }));
  $('#btn-add-bot').addEventListener('click', () => act({ type: 'addBot' }));
  $('#btn-fill-bots').addEventListener('click', fillBots);
  $('#wait-players').addEventListener('click', (e) => {
    const roll = e.target.closest('[data-roll-order]');
    if (roll) { act({ type: 'rollOrder' }); return; }
    const btn = e.target.closest('[data-remove-bot]');
    if (btn) act({ type: 'removeBot', playerId: btn.dataset.removeBot });
  });
  // 点左侧玩家卡：看这名玩家名下的全部资产与手牌
  $('#players').addEventListener('click', (e) => {
    const card = e.target.closest('.pcard');
    if (card?.dataset.pid) openAssets(card.dataset.pid);
  });
  [$('#btn-copy'), $('#btn-copy2'), $('#btn-copy3')].forEach((b) => b?.addEventListener('click', copyInvite));
  $('#btn-exit').addEventListener('click', exitRoom);
  $('#debug-panel').addEventListener('click', onDebugClick);
  initDebugPanelDrag();

  $('#actions').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const type = btn.dataset.action;
    const index = btn.dataset.index !== undefined ? Number(btn.dataset.index) : undefined;
    if (type === 'openAssets') return openAssets();
    if (type === 'openTrade') return openTrade();
    if (type === 'openRule') return openRule();
    if (type === 'openEnd') return openEnd();
    if (type === 'restart') { resetBannerCursor(); return act({ type: 'restart' }); }
    if (type === 'respondTrade') return act({ type: 'respondTrade', accept: btn.dataset.accept === '1' });
    act(index === undefined ? { type } : { type, index });
  });

  $('#modal-root').addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-back') || e.target.dataset.close !== undefined) closeModal();
  });

  // 播报与走子都放完后回报服务端，机器人靠这个节拍继续行动
  setInterval(maybeAck, 300);

  // 视口变化时棋盘尺寸会变，重测缓存并重排棋子
  window.addEventListener('resize', () => {
    store.boardSize.bw = 1;
    if (store.state && store.state.phase !== 'lobby') paintTokens();
    layoutStack(); // 播报高度跟着棋盘变了，重新排一次
    const dp = $('#debug-panel');
    if (dp && !dp.classList.contains('hidden') && dp.dataset.pos) {
      applyPanelPos(dp.offsetLeft, dp.offsetTop); // 面板别被挤到屏幕外
    }
  });

  $('#btn-theme').addEventListener('click', () => {
    applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
  });
  bindAudioUI();
  applyTheme(currentTheme()); // 同步图标与浏览器主题色
}

// ────────────── 声音设置面板 ──────────────
function bindAudioUI() {
  const btn = $('#btn-audio');
  const pop = $('#audio-pop');
  if (!btn || !pop) return;
  const icon = $('#audio-icon');
  const mRange = $('#vol-music');
  const sRange = $('#vol-sfx');
  const muteBtn = $('#btn-mute');

  const sync = () => {
    const s = audioState();
    icon.textContent = s.muted ? '🔇' : '🔊';
    btn.title = s.muted ? '已静音 · 点开调音量' : '声音设置';
    if (mRange) mRange.value = String(Math.round(s.music * 100));
    if (sRange) sRange.value = String(Math.round(s.sfx * 100));
    if (muteBtn) {
      muteBtn.textContent = s.muted ? '取消静音' : '全部静音';
      muteBtn.classList.toggle('on', s.muted);
    }
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    pop.classList.toggle('hidden');
    if (!pop.classList.contains('hidden')) sync();
  });
  document.addEventListener('click', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (!pop.contains(e.target) && !btn.contains(e.target)) pop.classList.add('hidden');
  });
  mRange?.addEventListener('input', () => setMusicVol(Number(mRange.value) / 100));
  sRange?.addEventListener('input', () => setSfxVol(Number(sRange.value) / 100));
  sRange?.addEventListener('change', () => sfx('coin')); // 松手时试听一下当前音量
  muteBtn?.addEventListener('click', () => { toggleMuted(); sync(); });

  // 点任何按钮都给一声轻响，操作有回应；面板里和动作按钮交给各自的音效
  document.addEventListener('click', (e) => {
    const el = e.target;
    if (!el || typeof el.closest !== 'function') return;
    if (el.closest('[data-action], #audio-pop')) return;
    if (el.closest('button, .btn, .icon-btn, .theme-btn, .cell, .pcard')) sfx('click');
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'm' && e.key !== 'M') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    toggleMuted();
    sync();
  });

  onAudioChange(sync);
  sync();
}

// ────────────── 主题 ──────────────
function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  try { localStorage.setItem('lofoten:theme', light ? 'light' : 'dark'); } catch { /* 无痕模式 */ }
  const icon = $('#theme-icon');
  const label = $('#theme-label');
  const btn = $('#btn-theme');
  // 图标和文字都表示"现在处在哪套主题"：太阳配浅色、月亮配深色。
  // 点一下要切到哪套，改由悬浮提示说明（按钮是切换用的，不能把它读成目标态）
  if (icon) icon.textContent = light ? '☀' : '☾';
  if (label) label.textContent = light ? '浅色' : '深色';
  if (btn) btn.title = light ? '当前浅色主题，点一下切换到深色' : '当前深色主题，点一下切换到浅色';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', light ? '#eef3f9' : '#060b14');
}

// ────────────── 入场 ──────────────
async function createRoom() {
  const name = $('#name-input').value.trim();
  if (!name) return toast('先给自己起个名字');
  localStorage.setItem('lofoten:name', name);
  try {
    const r = await api('/api/create', { name });
    enterRoom(r);
  } catch (e) { toast(e.message); }
}

async function soloGame() {
  const name = $('#name-input').value.trim();
  if (!name) return toast('先给自己起个名字');
  localStorage.setItem('lofoten:name', name);
  try {
    const r = await api('/api/create', { name });
    for (let i = 0; i < 3; i++) {
      await api('/api/action', { roomId: r.roomId, token: r.token, action: { type: 'addBot' } });
    }
    await api('/api/action', { roomId: r.roomId, token: r.token, action: { type: 'start' } });
    enterRoom(r);
  } catch (e) { toast(e.message); }
}

// 测试模式：一个人直接开局、不带机器人，进去就能手动摆位和指定抽卡
async function testModeGame() {
  const name = $('#name-input').value.trim();
  if (!name) return toast('先给自己起个名字');
  localStorage.setItem('lofoten:name', name);
  try {
    const r = await api('/api/create', { name });
    // 开关要赶在 start 之前：单人开局只对测试房间放行
    await api('/api/action', { roomId: r.roomId, token: r.token, action: { type: 'setDebug', on: true } });
    await api('/api/action', { roomId: r.roomId, token: r.token, action: { type: 'start' } });
    enterRoom(r);
  } catch (e) { toast(e.message); }
}

// 随机起名：名字池在服务端，会避开当前房间里已经用过的名字
async function randomName() {
  const btn = $('#btn-random-name');
  const input = $('#name-input');
  btn.disabled = true;
  try {
    const code = ($('#code-input').value || '').trim().toUpperCase();
    const q = code.length === 4 ? `?room=${encodeURIComponent(code)}` : '';
    const r = await (await fetch('/api/name' + q)).json();
    if (!r.name) throw new Error('没有拿到名字');
    input.value = r.name;
    input.classList.remove('name-flash');
    void input.offsetWidth;
    input.classList.add('name-flash');
    localStorage.setItem('lofoten:name', r.name);
  } catch {
    toast('随机起名失败，稍后再试');
  } finally {
    btn.disabled = false;
  }
}

async function joinRoom() {
  const name = $('#name-input').value.trim() || '旅人';
  const roomId = ($('#code-input').value || '').trim().toUpperCase();
  if (roomId.length !== 4) return toast('房间码是 4 位');
  localStorage.setItem('lofoten:name', name);
  try {
    const r = await api('/api/join', { roomId, name });
    enterRoom(r);
  } catch (e) { toast(e.message); }
}

async function fillBots() {
  const S = store.state;
  if (!S) return;
  const need = Math.max(0, 4 - S.players.length);
  if (!need) return toast('已经够 4 人了');
  for (let i = 0; i < need; i++) {
    try {
      await api('/api/action', { roomId: store.room, token: store.token, action: { type: 'addBot' } });
    } catch (e) { toast(e.message); return; }
  }
}

function enterRoom(r) {
  store.room = r.roomId;
  store.token = r.token;
  store.me = r.playerId;
  // 换房间：把播报队列和游标清干净，避免上家的播报串进来
  resetBannerCursor();
  store.lastAck = null;
  store.lastChatKey = null;
  store.lastPlayersKey = '';
  store.lastLogRenderKey = '';
  store.lastTurnLine = '';
  store.cellState = store.cellState.map(() => ({ ownId: null, mortgaged: null, houses: -1 }));
  localStorage.setItem('lofoten:token:' + r.roomId, r.token);
  history.replaceState(null, '', `?r=${r.roomId}`);
  $('#btn-copy').classList.remove('hidden');
  $('#btn-exit').classList.remove('hidden');
  connect();
}

// SSE 推送可能一帧内连到多条，用 rAF 合并成一次渲染
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}

function connect() {
  if (store.es) store.es.close();
  store.lastFrameAt = 0;
  setConn('wait', '连接中');
  const es = new EventSource(`/api/stream?room=${store.room}&token=${store.token}`);
  store.es = es;
  // onopen 只能证明「对方回了 200 且声明是 text/event-stream」，不能证明它真的在给数据。
  // 所以绿灯要等第一帧完整状态真正到达；之后的存活靠心跳续命。
  es.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch { return; }
    store.state = data;
    store.lastFrameAt = Date.now();
    setConn('ok', '已连接');
    scheduleRender();
  };
  // 服务端每 20 秒补一个 ping，收到就说明这条流还活着（注释形式的 `: ping` 前端看不到）
  es.addEventListener('ping', () => { store.lastFrameAt = Date.now(); });
  // CLOSED 表示浏览器已经放弃重试（比如房间在服务端没了，回的是 403/404），
  // 这时候还写「连接中」也是骗人，直接说断开。
  es.onerror = () => setConn('wait', es.readyState === EventSource.CLOSED ? '连接已断开' : '连接中');
}

// 连接状态只有一条规矩：没有数据就不给绿灯。
//   进房前 —— 顶栏写的是 boot() 的探测结果（服务器正常 / 未连接服务器）
//   连接中 —— 请求已发出、还在等数据（握手、断线重连都算）
//   已连接 —— 收到过完整状态，且还在心跳有效期内
const CONN_STALE_MS = 45000; // 服务端 20 秒一次心跳，这里留出漏掉一两次的余量
let connKey = null;
let connKind = null;

// kind: 'ok' 绿灯 / 'bad' 红灯 / null 藏着不说
function setConn(kind, text) {
  const el = $('#conn');
  if (!el) return;
  const key = kind + '|' + text;
  if (connKey === key) return;
  connKey = key;
  connKind = kind;
  el.className = 'conn ' + (kind === 'ok' ? 'on' : 'off') + (kind ? '' : ' hidden');
  el.innerHTML = `<i></i>${text || ''}`;
}

// 心跳体检：只在绿灯亮着的时候查，超时就把绿灯收回去，不许界面停在「已连接」上骗人
setInterval(() => {
  if (connKind !== 'ok' || !store.room) return;
  if (Date.now() - store.lastFrameAt > CONN_STALE_MS) setConn('wait', '连接中');
}, 5000);

async function exitRoom() {
  try { await api('/api/leave', { roomId: store.room, token: store.token }); } catch { /* ignore */ }
  localStorage.removeItem('lofoten:token:' + store.room);
  if (store.es) store.es.close();
  location.href = location.pathname;
}

function copyInvite() {
  const url = `${location.origin}${location.pathname}?r=${store.room}`;
  const done = () => toast('邀请链接已复制，发给同 Wi-Fi 的朋友', true);
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(() => fallbackCopy(url, done));
  } else {
    fallbackCopy(url, done);
  }
}
function fallbackCopy(text, cb) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); cb(); } catch { toast('复制失败，手动分享地址栏链接'); }
  ta.remove();
}

// ────────────── 渲染 ──────────────
function showScreen(name) {
  if (store.screen === name) return;
  store.screen = name;
  ['lobby', 'wait', 'game'].forEach((s) => $('#screen-' + s).classList.toggle('hidden', s !== name));
}

function render() {
  const S = store.state;
  if (!S) return;
  if (S.phase === 'lobby') {
    showScreen('wait');
    renderWait();
  } else {
    showScreen('game');
    renderGame();
  }
}

// ⚀–⚅ 六个骰面（等待房掷骰定序用）
const DIE_LAYOUTS = {
  1: [[50, 50]],
  2: [[26, 26], [74, 74]],
  3: [[26, 26], [50, 50], [74, 74]],
  4: [[26, 26], [74, 26], [26, 74], [74, 74]],
  5: [[26, 26], [74, 26], [50, 50], [26, 74], [74, 74]],
  6: [[26, 26], [74, 26], [26, 50], [74, 50], [26, 74], [74, 74]],
};
const pipsHTML = (v) => (DIE_LAYOUTS[v] || []).map(([x, y]) => `<i style="left:${x}%;top:${y}%"></i>`).join('');
// 小号骰子：和棋盘中央的骰子同一套点数布局，只是尺寸缩到能放进卡片
const miniDiceHTML = (vals) =>
  `<span class="wp-dice">${vals.map((v) => `<span class="wp-die">${pipsHTML(v)}</span>`).join('')}</span>`;

// 等待房里按「掷骰定序」的规则算出出手顺序（未掷的人排在最后）
function projectedOrder(S) {
  const sum = (p) => (p.orderRoll ? p.orderRoll[0] + p.orderRoll[1] : -1);
  const high = (p) => (p.orderRoll ? Math.max(p.orderRoll[0], p.orderRoll[1]) : 0);
  return [...S.players].sort((a, b) => sum(b) - sum(a) || high(b) - high(a) || a.seat - b.seat);
}

function renderWait() {
  const S = store.state;
  $('#wait-code').textContent = S.id;
  const me = S.hostId === store.me;
  const order = projectedOrder(S);
  const rankOf = (id) => order.findIndex((p) => p.id === id) + 1;

  $('#wait-players').innerHTML = S.players
    .map((p) => {
      const rolled = !!p.orderRoll;
      const rk = rolled ? rankOf(p.id) : 0;
      const right = rolled
        ? `${miniDiceHTML(p.orderRoll)}<div class="wp-sum">${p.orderRoll[0] + p.orderRoll[1]} 点 · 第 ${rk} 位</div>`
        : (p.id === store.me
          ? '<button class="btn tiny wp-roll" data-roll-order="1">🎲 掷骰</button>'
          : '<span class="wp-wait">待掷骰</span>');
      return `
      <div class="wait-player${p.isBot ? ' is-bot' : ''}${rolled ? ' rolled' : ''}${rk === 1 ? ' first' : ''}" style="--c:${p.color}">
        <div class="wp-token" style="--c:${p.color}">${p.emoji}</div>
        <div class="wp-body">
          <div class="wp-name">${esc(p.name)}${p.id === store.me ? ' <span class="wp-tag">（你）</span>' : ''}${p.isBot ? ' <span class="wp-bot">机器人</span>' : ''}</div>
          <div class="wp-tag">${p.id === S.hostId ? '房主' : p.isBot ? '自动托管' : '已就位'}</div>
        </div>
        <div class="wp-order">${right}</div>
        ${p.isBot && me ? `<button class="wp-x" data-remove-bot="${p.id}" title="移除机器人">✕</button>` : ''}
      </div>`;
    })
    .join('') + (S.players.length < 6 ? `
      <div class="wait-player" style="--c:#2a3d55; opacity:.5">
        <div class="wp-token" style="--c:#2a3d55">＋</div>
        <div class="wp-body"><div class="wp-name">等待加入…</div><div class="wp-tag">最多 6 人</div></div>
      </div>` : '');

  const btn = $('#btn-start');
  btn.classList.toggle('hidden', !me);
  btn.disabled = S.players.length < 2;
  $('#bot-row').classList.toggle('hidden', !me);
  $('#btn-add-bot').disabled = S.players.length >= 6;
  $('#btn-fill-bots').disabled = S.players.length >= 4;
  const sel = $('#limit-select');
  if (sel.value !== String(S.turnLimit ?? 80)) sel.value = String(S.turnLimit ?? 80);
  sel.disabled = !me;

  const unrolled = S.players.filter((p) => !p.orderRoll).length;
  const rolledList = order.filter((p) => p.orderRoll).map((p) => p.name);
  if (!me) {
    $('#wait-tip').textContent = '等待房主开始游戏…';
  } else if (S.players.length < 2) {
    $('#wait-tip').textContent = '至少需要 2 名玩家——可以加机器人开局。';
  } else if (unrolled > 0) {
    $('#wait-tip').textContent = `还有 ${unrolled} 人没掷骰，掷完就知道谁先出手。`;
  } else {
    $('#wait-tip').textContent = `出手顺序：${rolledList.join(' → ')}`;
  }
  $('#wait-addr').textContent = location.origin + location.pathname + '?r=' + S.id;
}

function renderGame() {
  const S = store.state;
  // 开新一局（回合数归零）时棋子直接就位，不要倒着走一圈
  if (store.lastTurnNo != null && S.turnNo < store.lastTurnNo) snapTokens();
  store.lastTurnNo = S.turnNo;
  // 先把新轨迹排进队列：后面渲染播报时才知道"棋子还要走"，不会抢在走子之前把话说出来
  adoptPaths(S);
  $('#room-code').textContent = S.id;
  renderPlayers();
  renderCashFx(S);
  renderBoardState();
  renderActions();
  renderCenter();
  renderBanners();
  renderLog();
  renderTokens();
  renderChat();
  renderDebugPanel();
  const bh = $('#bank-houses');
  const bhh = $('#bank-hotels');
  if (bh && bh.textContent !== String(S.bank.houses)) bh.textContent = S.bank.houses;
  if (bhh && bhh.textContent !== String(S.bank.hotels)) bhh.textContent = S.bank.hotels;
}

// ────────────── 局内聊天 ──────────────
// 只在消息列表真的变了才重绘，避免每次 SSE 推送都打断输入框与滚动位置
function renderChat() {
  const S = store.state;
  const list = $('#chat-list');
  if (!list) return;
  const msgs = S.chat || [];
  const key = msgs.length ? `${msgs.length}:${msgs[msgs.length - 1].id}` : '0';
  if (store.lastChatKey === key) return;
  store.lastChatKey = key;

  if (!msgs.length) {
    list.innerHTML = '<div class="chat-empty">还没有人说话，先打个招呼吧。</div>';
    return;
  }
  // 用户往上翻看历史时不要强行拽回底部
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 42;
  list.innerHTML = msgs.map((m) => `
    <div class="chat-msg${m.pid === store.me ? ' mine' : ''}">
      <span class="chat-who" style="--c:${m.color || '#9fe8d4'}">${esc(m.name)}</span>
      <span class="chat-text">${esc(m.text)}</span>
    </div>`).join('');
  if (nearBottom) list.scrollTop = list.scrollHeight;
}

async function sendChat(e) {
  e?.preventDefault();
  const input = $('#chat-input');
  if (!input) return;
  const text = input.value.trim();
  if (!text || !store.room) return;
  input.value = '';
  sfx('chat');
  try {
    await api('/api/action', {
      roomId: store.room,
      token: store.token,
      action: { type: 'chat', text },
    });
  } catch (err) {
    input.value = text; // 发失败把话还给玩家
    toast(err.message);
  }
}

function myPlayer() {
  return store.state?.players.find((p) => p.id === store.me) || null;
}
function playerById(id) {
  return store.state?.players.find((p) => p.id === id) || null;
}
function isMyTurn() {
  const S = store.state;
  return S?.players[S.current]?.id === store.me;
}

function renderPlayers() {
  const S = store.state;
  // 内容没变就跳过，避免每次 SSE 推送都重建整列玩家卡
  const key = S.players.map((p) =>
    [p.id, p.name, p.emoji, p.color, p.cash, p.props.length, p.cards,
     (p.held || []).map((c) => c.kind).join(''),
     p.inJail ? 1 : 0, p.bankrupt ? 1 : 0, p.connected ? 1 : 0, p.isBot ? 1 : 0].join(',')
  ).join('|') + '@' + (S.phase === 'playing' ? String(S.current) : '-');
  if (store.lastPlayersKey === key) return;
  store.lastPlayersKey = key;
  $('#players').innerHTML = S.players.map((p) => {
    const active = S.players[S.current]?.id === p.id && S.phase === 'playing';
    const vouchers = (p.held || []).filter((c) => c.kind === 'rent').length;
    return `
      <div class="pcard ${active ? ' active' : ''} ${p.bankrupt ? 'bankrupt' : ''} ${p.connected ? '' : 'offline'} ${active && p.isBot ? 'thinking' : ''}"
           data-pid="${p.id}" title="点击查看 ${esc(p.name)} 的资产" style="--c:${p.color}">
        <div class="pav" style="--c:${p.color}">${p.emoji}</div>
        <div class="pinfo">
          <div class="pname">${esc(p.name)}${p.id === store.me ? '<span class="you">你</span>' : ''}${p.isBot ? '<span class="pbot">🤖</span>' : ''}${p.connected ? '' : ' <span style="color:#7f94ab;font-size:9px">离线</span>'}</div>
          <div class="pcash">${money(p.cash)}</div>
          <div class="pmeta">
            <span>${p.props.length} 处地产</span>
            ${p.cards ? `<span>🎫 ${p.cards}</span>` : ''}
            ${vouchers ? `<span>🎟 ${vouchers}</span>` : ''}
            ${p.inJail ? '<span class="jail">🔒 狱中</span>' : ''}
            ${p.bankrupt ? '<span class="jail">已出局</span>' : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

// 现金变了不要马上飘：state 一到位就飘会出现"骰子刚扔、棋子还没走，钱先变了"。
// 先把变化排进队列，等讲这件事的那条播报上屏（showBanner）时才飘出来。
const CASH_FX_MAX_WAIT_MS = 2600; // 兜底：一直没等到播报也不能让这笔钱悄无声息

function renderCashFx(S) {
  S.players.forEach((p) => {
    const prev = store.cashPrev.get(p.id);
    store.cashPrev.set(p.id, p.cash);
    if (prev == null || prev === p.cash) return;
    store.cashFxQueue.push({ pid: p.id, delta: p.cash - prev });
  });
  if (store.cashFxQueue.length) {
    clearTimeout(store.cashFxTimer);
    store.cashFxTimer = setTimeout(flushCashFx, CASH_FX_MAX_WAIT_MS);
  }
}

// 有播报上屏了 → 把排着的金额变化一起放出来，和字幕同步
function flushCashFx() {
  clearTimeout(store.cashFxTimer);
  store.cashFxTimer = null;
  if (!store.cashFxQueue.length) return;
  const batch = store.cashFxQueue;
  store.cashFxQueue = [];
  batch.forEach(({ pid, delta }) => popCash(pid, delta));
}

// 单个玩家卡右侧飘一个 +kr / −kr，所有玩家都算（不只是当前出手的人）
function popCash(pid, delta) {
  const list = $('#players');
  if (!list) return;
  const card = list.querySelector(`.pcard[data-pid="${pid}"]`);
  if (!card) return;
  const gain = delta > 0;

  // 同一张卡上只留最新一个，避免连续变动时几个数字叠在一起
  card.querySelectorAll('.cash-pop').forEach((n) => n.remove());
  const pop = document.createElement('div');
  pop.className = `cash-pop ${gain ? 'gain' : 'loss'}`;
  pop.textContent = `${gain ? '+' : '−'} kr ${fmt(Math.abs(delta))}`;
  card.appendChild(pop);
  setTimeout(() => pop.remove(), 1700);

  // 卡片上的金额本身也跟着闪一下
  const cashEl = card.querySelector('.pcash');
  if (cashEl) {
    cashEl.classList.remove('flash-gain', 'flash-loss');
    void cashEl.offsetWidth;
    cashEl.classList.add(gain ? 'flash-gain' : 'flash-loss');
    setTimeout(() => cashEl.classList.remove('flash-gain', 'flash-loss'), 950);
  }
}

// ────────────── 棋盘 ──────────────
function coord(i) {
  if (i === 0) return [11, 11];
  if (i < 10) return [11, 11 - i];
  if (i === 10) return [11, 1];
  if (i < 20) return [11 - (i - 10), 1];
  if (i === 20) return [1, 1];
  if (i < 30) return [1, 1 + (i - 20)];
  if (i === 30) return [1, 11];
  return [1 + (i - 30), 11];
}
function sideClass(i) {
  if (i <= 10) return 'side-bottom';
  if (i <= 20) return 'side-left';
  if (i <= 30) return 'side-top';
  return 'side-right';
}

// 6 字以上（都是渡口名）在末两字前断行，避免出现 4+1 的孤字
function cellLabel(name) {
  if (name.length >= 6) return `${esc(name.slice(0, name.length - 2))}<br>${esc(name.slice(-2))}`;
  return esc(name);
}

// 只有四个角和两种卡牌格保留 emoji 图标，其余格子只用文字，保持整圈统一
const CELL_ICON_TYPES = new Set(['go', 'jail', 'parking', 'gotojail', 'chance', 'chest']);

function cellContent(c) {
  const icon = CELL_ICON_TYPES.has(c.type) ? `<div class="cell-icon">${c.icon}</div>` : '';
  // 挪威文原名：只出现在棋盘格上，不折行，过长省略
  const en = c.en ? `<div class="cell-en">${esc(c.en)}</div>` : '';
  if (c.type === 'prop') {
    return `<div class="cell-main">
        <div class="cell-name">${cellLabel(c.name)}</div>
        ${en}
        <div class="cell-price">${fmt(c.price)}</div>
      </div>`;
  }
  if (c.type === 'ferry' || c.type === 'util') {
    return `<div class="cell-main">
        <div class="cell-name">${cellLabel(c.name)}</div>
        ${en}
        <div class="cell-price">${fmt(c.price)}</div>
      </div>`;
  }
  if (c.type === 'tax') {
    return `<div class="cell-main">
        <div class="cell-name">${cellLabel(c.name)}</div>
        ${en}
        <div class="cell-price">−${fmt(c.amount)}</div>
      </div>`;
  }
  return `<div class="cell-main">
      ${icon}
      <div class="cell-name">${cellLabel(c.name)}</div>
      ${en}
    </div>`;
}

function buildBoard() {
  const board = $('#board');
  $$('.cell', board).forEach((n) => n.remove());
  const frag = document.createDocumentFragment();
  store.cellEls = [];
  store.cellState = [];
  store.board.forEach((c, i) => {
    const [row, col] = coord(i);
    const el = document.createElement('div');
    const corner = ['go', 'jail', 'parking', 'gotojail'].includes(c.type);
    el.className = `cell ${sideClass(i)}${corner ? ' corner' : ''}${['prop', 'ferry', 'util'].includes(c.type) ? '' : ' special'}`;
    el.style.gridRow = String(row);
    el.style.gridColumn = String(col);
    el.dataset.i = String(i);
    let html = '';
    if (c.type === 'prop') html += `<div class="bar" style="--c:${store.groups[c.group].color}"></div>`;
    html += cellContent(c);
    html += '<div class="cell-houses"></div><div class="cell-mark" style="display:none"></div>';
    el.innerHTML = html;
    el.addEventListener('click', () => openProperty(i));
    frag.appendChild(el);
    // 缓存子元素引用，之后每次状态推送就不用再 querySelector 了
    store.cellEls[i] = {
      el,
      mark: el.querySelector('.cell-mark'),
      houses: el.querySelector('.cell-houses'),
    };
    store.cellState[i] = { ownId: null, mortgaged: null, houses: -1 };
  });
  board.appendChild(frag);
}

function renderBoardState() {
  const S = store.state;
  store.board.forEach((c, i) => {
    const refs = store.cellEls[i];
    if (!refs) return;
    const st = S.cells[i];
    const cache = store.cellState[i];
    const ownId = st.owner || '';
    const mortgaged = !!st.mortgaged;
    const houses = st.houses || 0;
    // 业主 / 抵押 / 房屋都没变，这格完全不用碰 DOM
    if (cache.ownId === ownId && cache.mortgaged === mortgaged && cache.houses === houses) return;
    cache.ownId = ownId;
    cache.mortgaged = mortgaged;
    cache.houses = houses;

    const { el, mark, houses: houseBox } = refs;
    const owner = ownId ? playerById(ownId) : null;
    el.classList.toggle('owned', !!owner);
    el.classList.toggle('mortgaged', mortgaged);
    if (owner) {
      el.style.setProperty('--own', owner.color);
    } else {
      el.style.removeProperty('--own');
    }
    if (mark) {
      mark.style.display = owner ? 'block' : 'none';
      if (owner) mark.style.background = owner.color;
    }
    if (houseBox) {
      if (houses === 5) houseBox.innerHTML = '<span class="hotel"></span>';
      else if (houses > 0) houseBox.innerHTML = '<span class="house"></span>'.repeat(houses);
      else houseBox.innerHTML = '';
    }
  });
}

// 棋子：等骰子动画结束后再逐格移动，避免"骰子还在转，棋子已经飞过去"
// 棋子放在棋盘层（#tokens）里，位置算到每格左上角，靠 left/top 过渡做连贯滑行
const TOKEN_STEP_MS = 108;

function renderTokens() {
  const S = store.state;
  const layer = $('#tokens');
  if (!S || !layer) return;

  S.players.forEach((p) => {
    let el = store.tokenEls.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'token';
      el.dataset.pid = p.id;
      layer.appendChild(el);
      store.tokenEls.set(p.id, el);
      store.viewPos.set(p.id, p.pos); // 首次出现直接就位，不做补间
      measureBoard(); // 有了真实棋子，更新直径缓存
    }
    el.textContent = p.emoji;
    el.style.setProperty('--c', p.color);
    el.classList.toggle('me', p.id === store.me);
    el.classList.toggle('dead', !!p.bankrupt);
    el.title = `${p.name} · ${money(p.cash)}`;
    if (p.bankrupt) store.viewPos.set(p.id, p.pos);
  });

  adoptPaths(S); // 服务端这一趟的位移轨迹，先接过来排好队
  paintTokens();

  // 段间停住时（等播报）不要顺手把下一步排上，交给 resumeMove()
  if (pendingMove() && !store.moveTimer && !store.bannerBusy && !store.moveHold) {
    // 播报正在放就先等等，等它收完再走子，两件事不叠在一起
    const wait = Math.max(0, store.diceBusyUntil - Date.now());
    store.moveTimer = setTimeout(stepTokens, wait);
  }
}

let stepTick = 0;

// 多段位移：走完一段先停住，等这段触发的播报出现，再过 MOVE_RESUME_MS 才走下一段。
// 兜底 MOVE_HOLD_MAX_MS：万一这一趟没有播报，也不能把棋子一直按在原地。
// 光靠"停一下"看不出来，所以停顿期间还会点亮棋子 + 闪目标格 + 播报里带一行去向，
// 让"播报说要动 → 棋子动"这条因果链被看见，而不仅仅是等了一段时间。
const MOVE_RESUME_MS = 520;
const MOVE_HOLD_MAX_MS = 1600;
const JUMP_GLIDE_MS = 620;    // 被押送进监狱时直线飞过去的时间
const JUMP_SETTLE_MS = 780;   // 飞行 + 落地动作演完再继续，别让下一段抢戏

const cw = (a, b) => (b - a + 40) % 40;  // 顺时针 a→b 的格数
const ccw = (a, b) => (a - b + 40) % 40; // 逆时针 a→b 的格数

// 「还要不要走」不能只看 viewPos 是否等于最终 pos：起点 → 卡格 → 抽到回起点这类往返，
// 首尾是同一格但中间整段过程都要演出来，所以队列里还剩分段就算没走完。
// 存着却还没接上的轨迹也算：它是"棋子待会儿还要动"的证据，播报得等它。
function pendingMove() {
  const S = store.state;
  return S.players.some((p) => {
    if (p.bankrupt) return false;
    const q = store.moveQ.get(p.id);
    if (q && q.length) return true; // 还有分段没走完（首尾可能同格）
    const cur = store.viewPos.get(p.id);
    if (cur === undefined) return false;
    if (store.pathStash.get(p.id) && cur !== p.pos) return true;
    return cur !== p.pos;
  });
}

// 这一段还能不能接着走：棋子得站在 from→to 这条弧上（含两端）。
// 已经越过的段直接丢掉——客户端落后一两格时（比如上一次还差一步没走完），
// 从中间接上继续走就行，不必非要从头对齐。
function firstLiveSeg(path, cur) {
  for (let i = 0; i < path.length; i++) {
    const s = path[i];
    if (s.from === s.to) continue;
    if (s.mode === 'jump') { if (cur === s.from) return i; continue; }
    if (s.mode === 'back') {
      if (ccw(s.from, cur) + ccw(cur, s.to) === ccw(s.from, s.to)) return i;
      continue;
    }
    if (cw(s.from, cur) + cw(cur, s.to) === cw(s.from, s.to)) return i;
  }
  return -1;
}

// 服务端给了这一趟的位移轨迹就照着走：先走到卡格，再后退 / 再前往某地 / 再被押送。
// 接不上的先存起来，等上一段走完再接，绝不因为"位置差一格"就把整条轨迹扔掉。
function adoptPaths(S) {
  if (store.moveSeq === S.moveSeq) return;
  store.moveSeq = S.moveSeq;
  S.players.forEach((p) => {
    const path = (p.path || []).filter((s) => s.from !== s.to);
    if (!path.length) { store.pathStash.delete(p.id); return; }
    const cur = store.viewPos.get(p.id);
    if (cur === undefined) return;
    const i = firstLiveSeg(path, cur);
    if (i < 0) { store.pathStash.delete(p.id); return; }
    const q = store.moveQ.get(p.id);
    if (q && q.length) store.pathStash.set(p.id, path.slice(i)); // 还在走上一段，先存着
    else { store.moveQ.set(p.id, path.slice(i)); store.pathStash.delete(p.id); }
  });
}

// 上一段走完（或棋子落到弧上了）就把存着的轨迹接上
function drainPathStash() {
  const S = store.state;
  if (!S) return;
  S.players.forEach((p) => {
    const stash = store.pathStash.get(p.id);
    if (!stash) return;
    const q = store.moveQ.get(p.id);
    if (q && q.length) return; // 还在走，等它走完再说
    const cur = store.viewPos.get(p.id);
    if (cur === undefined) return;
    const i = firstLiveSeg(stash, cur);
    if (i < 0) { store.pathStash.delete(p.id); return; }
    store.moveQ.set(p.id, stash.slice(i));
    store.pathStash.delete(p.id);
  });
}

function stepTokens() {
  store.moveTimer = null;
  const S = store.state;
  if (!S) return;
  drainPathStash(); // 上一段刚走完，看看存着的轨迹能不能接上
  let moved = false;
  let jumped = false;
  let stepMs = TOKEN_STEP_MS;
  let glideMs = 0; // 有人正在被押送：这一拍要等他飞到，别被别人的快节奏带过去
  S.players.forEach((p) => {
    const cur = store.viewPos.get(p.id);
    if (cur === undefined) return;
    const q = store.moveQ.get(p.id);
    let seg = q && q.length ? q[0] : null;
    // 已经站在段终点却还留在队列里（异常兜底）：直接出队，别卡住
    while (seg && cur === seg.to) {
      q.shift();
      seg = q.length ? q[0] : null;
    }
    // 没有分段可走、且已经站在最终格上，才算走完
    if (!seg && cur === p.pos) return;

    // 入狱是"直接押送"：不逐格绕棋盘（官方 "Do not pass GO"），
    // 但也不是凭空闪现——棋子沿直线飞过去，看得见它是一路被押到监狱的
    if (seg && seg.mode === 'jump') {
      q.shift();
      glideToJail(p.id, seg.to);
      moved = true;
      jumped = true;
      glideMs = Math.max(glideMs, JUMP_SETTLE_MS);
      if (q.length) holdMove(p.id);
      return;
    }

    let dir;
    if (seg) dir = seg.mode === 'back' ? -1 : 1;
    else {
      const fwd = (p.pos - cur + 40) % 40;
      const back = (cur - p.pos + 40) % 40;
      // 没有轨迹时兜底：后退类卡牌（≤6 格）往回走，其余一律顺时针前进
      dir = back > 0 && back < fwd && back <= 6 ? -1 : 1;
    }
    store.viewPos.set(p.id, (cur + dir + 40) % 40);
    moved = true;
    // 「前往某块地」「回到起点」按官方规则要顺时针绕，可能要走三十几格，
    // 段内剩得越多走得越快，别让人干等（>26 格那档就是给绕大半圈用的）
    if (seg) {
      const left = dir < 0 ? (cur - seg.to + 40) % 40 : (seg.to - cur + 40) % 40;
      stepMs = Math.min(stepMs, left > 26 ? 42 : left > 18 ? 54 : left > 9 ? 72 : TOKEN_STEP_MS);
    }
    // 这一段走完了：后面还有一段就先停住，把播报放出来，等播报出来了再接着走
    if (seg && store.viewPos.get(p.id) === seg.to) {
      q.shift();
      if (q.length) holdMove(p.id);
    }
  });
  if (moved) {
    paintTokens();
    stepTick = (stepTick + 1) % 8;
    // 走得太密时脚步声隔一下再响，免得连成一串噪音（押送进监狱那一步没有脚步声）
    if (!jumped && (stepMs >= TOKEN_STEP_MS || stepTick % 2 === 0)) sfx('step', { k: stepTick });
    // 停在段间等播报时不要再排下一步，由 resumeMove() 接着放
    if (!store.moveHold) store.moveTimer = setTimeout(stepTokens, Math.max(stepMs, glideMs));
  } else {
    // 走完了，留一点过渡时间再放播报，避免"人还没站稳就开始播下一条"
    store.pathStash.clear(); // 人都到位了，没接上的轨迹就作废，别把播报一直压住
    store.moveSettleAt = Date.now() + 220;
    renderActions(); // 走子期间禁用的按钮，落地后恢复
    clearTimeout(store.bannerWaitTimer);
    store.bannerWaitTimer = setTimeout(pumpBanner, 260);
  }
}

// 直接押送进监狱：棋子不逐格绕棋盘（官方 "Do not pass GO"），
// 而是从当前位置沿直线飞到监狱格——既不会路过起点，动作也看得见，不是凭空闪现。
function glideToJail(pid, to) {
  const tok = store.tokenEls.get(pid);
  store.viewPos.set(pid, to);
  // 直线位移用更长、更"抬着走"的过渡（.gliding），飞完摘掉，别影响后面的逐格走
  if (tok) {
    tok.classList.add('gliding');
    const prev = store.glideTimers.get(pid);
    if (prev) clearTimeout(prev);
  }
  paintTokens();
  sfx('escort'); // 起飞的一声"呼"，落地那记闷响等飞到再响

  const land = () => {
    // 同一个棋子 / 同一格连续触发时要先掐掉上一次的收尾，不然 class 会残留
    if (tok) {
      tok.classList.remove('gliding');
      store.glideTimers.delete(pid);
    }
    const fx = (key, el, ms) => {
      if (!el) return;
      const prev = store.jailFxTimers.get(key);
      if (prev) clearTimeout(prev);
      el.classList.remove('jailed');
      void el.offsetWidth; // 重启一次动画
      el.classList.add('jailed');
      store.jailFxTimers.set(key, setTimeout(() => {
        el.classList.remove('jailed');
        store.jailFxTimers.delete(key);
      }, ms));
    };
    fx('tok:' + pid, tok, 560);
    fx('cell:' + to, store.cellEls[to]?.el, 760);
    sfx('jailDrop'); // 落地闷响，和播报那条低沉的"铁门"声错开
  };

  const prevLand = store.jailLandTimers.get(pid);
  if (prevLand) clearTimeout(prevLand);
  store.jailLandTimers.set(pid, setTimeout(() => {
    store.jailLandTimers.delete(pid);
    land();
  }, JUMP_GLIDE_MS));
}

// 走完一段先按住棋子：点亮它和目标格，再把压住的播报放出来
function holdMove(pid) {
  store.moveHold = true;
  clearTimeout(store.moveTimer);
  store.moveTimer = null;
  clearTimeout(store.moveHoldTimer);
  store.moveHoldTimer = setTimeout(resumeMove, MOVE_HOLD_MAX_MS); // 兜底
  primeMove(pid);        // 棋子蓄力 + 目标格闪烁 + 准备去向提示
  clearTimeout(store.bannerWaitTimer);
  store.bannerWaitTimer = setTimeout(pumpBanner, 40);
  renderActions();
}

// 停顿期间的"预告"：棋子亮起来 + 目标格闪起来 + 一记蓄力音，
// 让观众知道接下来是这颗棋子要动、要去哪一格，而不是干等一段时间
function primeMove(pid) {
  clearPrime();
  const q = store.moveQ.get(pid);
  const seg = q && q.length ? q[0] : null;
  if (!seg) return;
  store.moveHoldPid = pid;

  const tok = store.tokenEls.get(pid);
  if (tok) tok.classList.add('primed');

  const cell = store.cellEls[seg.to]?.el;
  if (cell) {
    cell.classList.add('target');
    cell.classList.toggle('target-back', seg.mode === 'back');
    cell.classList.toggle('target-jail', seg.mode === 'jump');
  }
  sfx('prime');

  // 播报里带一行去向，把"接下来会发生什么"直接写出来
  const from = store.viewPos.get(pid) ?? 0;
  const name = store.board[seg.to]?.name || '';
  if (seg.mode === 'jump') {
    // 押送不经过任何格子，所以不写格数，只写"直接押送"
    store.moveHint =
      `<div class="tb-move-hint jail"><span class="mh-arrow">⤓</span>直接押送 → ${esc(name)}</div>`;
    return;
  }
  const n = seg.mode === 'back' ? (from - seg.to + 40) % 40 : (seg.to - from + 40) % 40;
  const verb = seg.mode === 'back' ? '后退' : '前往';
  store.moveHint =
    `<div class="tb-move-hint${seg.mode === 'back' ? ' back' : ''}">`
    + `<span class="mh-arrow">${seg.mode === 'back' ? '↩' : '↦'}</span>`
    + `${verb} ${n} 格 → ${esc(name)}</div>`;
}

// 收掉预告：棋子开始走了，就不需要再指着它
function clearPrime() {
  const pid = store.moveHoldPid;
  if (pid) {
    const tok = store.tokenEls.get(pid);
    if (tok) tok.classList.remove('primed');
  }
  $$('.cell.target').forEach((c) => c.classList.remove('target', 'target-back', 'target-jail'));
  store.moveHoldPid = null;
  store.moveHint = null;
}

// 播报出来之后再等 MOVE_RESUME_MS 才走下一段（后退 / 前往某地 / 进监狱……）
function armMoveResume() {
  if (!store.moveHold || store.moveResumeTimer) return;
  store.moveResumeTimer = setTimeout(resumeMove, MOVE_RESUME_MS);
}

function resumeMove() {
  if (!store.moveHold) return;
  clearTimeout(store.moveResumeTimer);
  clearTimeout(store.moveHoldTimer);
  store.moveResumeTimer = null;
  store.moveHoldTimer = null;
  store.moveHold = false;
  clearPrime();   // 出发了，收掉棋子和目标格上的预告
  stepTokens();
}

// 立即就位：重开一局、重连等场景不做补间
function snapTokens() {
  const S = store.state;
  if (!S) return;
  clearTimeout(store.moveTimer);
  clearTimeout(store.moveHoldTimer);
  clearTimeout(store.moveResumeTimer);
  store.moveTimer = null;
  store.moveHoldTimer = null;
  store.moveResumeTimer = null;
  store.moveHold = false;
  clearPrime();
  store.moveSettleAt = 0;
  store.moveQ.clear();
  store.pathStash.clear();
  store.glideTimers.forEach((t) => clearTimeout(t));
  store.glideTimers.clear();
  store.jailLandTimers.forEach((t) => clearTimeout(t));
  store.jailLandTimers.clear();
  S.players.forEach((p) => store.viewPos.set(p.id, p.pos));
  paintTokens();
}

// 每格左上角起手：第一颗贴角，第二颗排在它右边，依此类推
const CELL_PCT = 100 / 11;

// 棋盘宽度与棋子直径缓存下来，避免走子动画每步都触发强制回流；
// 棋盘隐藏时 clientWidth 为 0，用 bw<=1 作"待重测"标记
function measureBoard() {
  const board = $('#board');
  if (!board) return;
  store.boardSize.bw = board.clientWidth || 1;
  const sample = store.tokenEls.values().next().value;
  store.boardSize.tw = sample ? sample.offsetWidth || 16 : 16;
}

function paintTokens() {
  const S = store.state;
  const board = $('#board');
  if (!S || !board) return;
  if (store.boardSize.bw <= 1) measureBoard();
  const bw = store.boardSize.bw;
  const tw = store.boardSize.tw;              // 棋子直径（px），跟随 CSS clamp
  const tok = (tw / bw) * 100;                // 转成棋盘百分比
  const gap = tok * 0.16;
  const inset = tok * 0.16;

  const groups = new Map();
  S.players.forEach((p) => {
    if (p.bankrupt) return;
    const pos = store.viewPos.get(p.id) ?? p.pos;
    if (!groups.has(pos)) groups.set(pos, []);
    groups.get(pos).push(p);
  });

  groups.forEach((list, pos) => {
    const [row, col] = coord(pos);
    // 每格左上角起手：色条也压不住，直接贴角排
    const x0 = (col - 1) * CELL_PCT + inset + tok / 2;
    const y0 = (row - 1) * CELL_PCT + inset + tok / 2;
    // 靠右边缘时排不下就折到下一行，保证棋子不会被裁出棋盘
    const perRow = Math.max(1, Math.floor((100 - (x0 - tok / 2)) / (tok + gap)));

    list.forEach((p, k) => {
      const el = store.tokenEls.get(p.id);
      if (!el) return;
      const kk = k % perRow;
      const rr = Math.floor(k / perRow);
      const x = x0 + kk * (tok + gap);
      const y = y0 + rr * (tok + gap);
      el.style.left = Math.min(100 - tok / 2, x).toFixed(3) + '%';
      el.style.top = Math.min(100 - tok / 2, y).toFixed(3) + '%';
    });
  });

  // 已经不在房间里的玩家，把遗留棋子收掉
  store.tokenEls.forEach((el, pid) => {
    if (!S.players.some((p) => p.id === pid)) {
      el.remove();
      store.tokenEls.delete(pid);
      store.viewPos.delete(pid);
    }
  });
}

// ────────────── 中央与骰子 ──────────────
function diceHTML(v) {
  return `<div class="die">${pipsHTML(v)}</div>`;
}

function renderCenter() {
  const S = store.state;
  const [d1, d2] = S.dice || [0, 0];
  const key = `${d1}-${d2}-${S.players[S.current]?.pos ?? 0}`;
  const diceKey = key;
  const box = $('#board-dice');
  if (store.lastDice !== diceKey) {
    // 未掷骰时显示半透明骰子占位，避免出现两块纯白方块
    box.classList.toggle('idle', !d1 || !d2);
    box.innerHTML = diceHTML(d1 || 5) + diceHTML(d2 || 2);
    if (d1 && d2) {
      store.diceBusyUntil = Date.now() + 660; // 棋子等骰子停稳再走
      $$('.die', box).forEach((d) => {
        d.classList.add('rolling');
        setTimeout(() => d.classList.remove('rolling'), 550);
      });
      // 骰子落定的闷响；掷出对子再叠一串风铃
      setTimeout(() => sfx('diceLand'), 540);
      if (d1 === d2) setTimeout(() => sfx('double'), 660);
    }
    store.lastDice = diceKey;
  }

  const p = S.players[S.current];
  const me = p?.id === store.me;
  // 记录本回合的触发时刻，中央那行“谁的回合”后面带上时间
  const turnKey = `${S.turnNo}-${p?.id || ''}`;
  if (store.turnKey !== turnKey) {
    store.turnKey = turnKey;
    store.turnAt = Date.now();
  }
  const clock = new Date(store.turnAt || Date.now())
    .toLocaleTimeString('zh-CN', { hour12: false })
    .slice(0, 5);

  let turnText = '—';
  let hint = '';
  if (S.phase === 'ended') {
    const w = playerById(S.winnerId);
    turnText = '对局结束';
    hint = w ? `${w.name} 赢得了罗弗敦` : '';
  } else if (p) {
    turnText = me ? '你的回合' : `${p.name} 的回合`;
    if (S.pending?.type === 'buy') hint = me ? '决定是否买下这块地' : (p.isBot ? '机器人正在考虑…' : '等待对方决定…');
    else if (S.pending?.type === 'jail') hint = me ? '想办法出狱' : '对方在狱中';
    else if (S.canRoll) hint = me ? '掷骰子，出发' : (p.isBot ? '机器人正在掷骰…' : '等待掷骰…');
    else hint = me ? '可以结束回合了' : (p.isBot ? '机器人正在行动…' : '等待操作…');
  }
  const line = `${esc(turnText)}` + (S.phase === 'ended' ? '' : `<span class="turn-clock">${clock}</span>`);
  if (store.lastTurnLine !== line) {
    $('#board-turn').innerHTML = line;
    store.lastTurnLine = line;
  }
  $('#board-hint').textContent = hint;
}

// ────────────── 棋盘中央大屏播报 ──────────────
// 事件播报（收租 / 扣钱 / 买地……）可以叠着放：同一回合里连续的第二条
// 会把上一条顶上去，两条先后挂在屏上，再按出场顺序依次消失，省掉一长串
// 排队等待的时间。回合播报（换人 / 掷骰）仍然独占屏幕，等屏上清干净才播。
const BANNER_TURN_MS = 1500;
const BANNER_OUT_MS = 460;     // 淡出时长，与 CSS transition 对齐，等动画走完再摘掉
const BANNER_STACK_MAX = 2;    // 同一时刻最多挂几条事件播报
const BANNER_STAGGER_MS = 220; // 两条播报的最小出场间隔（>100ms）
const BANNER_GAP_PX = 12;      // 上下两条之间的间距
const BANNER_ENTER_PX = 18;    // 进场时从下方多远处滑上来
const BANNER_ENTER_SCALE = 0.94;
const BANNER_OUT_SCALE = 0.96;
const BANNER_SINK_PX = 14;        // 淡出时轻轻下沉
// 这两类不单独播报：掷骰由骰子动画代替，换人由回合播报代替
const SILENT_KINDS = new Set(['roll', 'turn']);
const EVENT_LABEL = {
  money: '收支',
  rent: '租金',
  buy: '成交',
  build: '建造',
  card: '卡牌',
  jail: '监狱',
  trade: '交易',
  bad: '出局',
  win: '终局',
  sys: '岛上报事',
};

function renderBanners() {
  const S = store.state;
  if (!S) return;
  detectTurnBanner(S);
  detectLogBanners(S);
  pumpBanner();
}

// 回合播报：每次换人都播，全场可见
function detectTurnBanner(S) {
  if (S.phase !== 'playing') return;
  const p = S.players[S.current];
  if (!p) return;
  const key = `${S.turnNo}-${p.id}`;
  if (store.lastTurnKey === key) return;
  store.lastTurnKey = key;

  const clock = new Date(store.turnAt || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  queueBanner({
    type: 'turn',
    ms: BANNER_TURN_MS,
    color: p.color,
    html: `
      <div class="tb-kicker">第 ${S.turnNo}${S.turnLimit ? ' / ' + S.turnLimit : ''} 回合</div>
      <div class="tb-token">${p.emoji}</div>
      <div class="tb-name">${esc(p.name)}</div>
      <div class="tb-time">${clock} · 开始行动</div>
      <div class="tb-sub">${p.id === store.me ? '轮到你出手' : '轮到 TA 出手'}</div>`,
    sound: 'turn',
  });
}

// 日志条目 → 音效：声画同步，播报出现的同时响
function soundForLog(l) {
  const t = l.text || '';
  switch (l.kind) {
    case 'money':
      if (t.includes('起点津贴') || t.includes('过路津贴')) return 'salary';
      return (l.delta || 0) >= 0 ? 'coin' : 'pay';
    case 'rent': return 'pay';
    case 'buy': return 'buy';
    case 'build': return t.includes('酒店') ? 'hotel' : 'build';
    case 'card': return 'card';
    case 'jail':
      if (t.includes('出狱') || t.includes('重获自由') || t.includes('保释') || t.includes('用「')) return 'free';
      return 'jail';
    case 'trade': return 'trade';
    case 'bad': return 'bankrupt';
    case 'win': return 'win';
    default: return '';
  }
}

// 事件播报：收租、扣钱、买地、建房、抽卡、进出监狱……都单独播一条
function detectLogBanners(S) {
  const log = S.log || [];
  const last = log[log.length - 1];
  if (!last) return;
  if (store.lastLogSeq == null) {
    store.lastLogSeq = last.seq || 0; // 刚进房间，不回放历史
    return;
  }
  if ((last.seq || 0) <= store.lastLogSeq) return;

  const fresh = log.filter((l) => (l.seq || 0) > store.lastLogSeq);
  store.lastLogSeq = last.seq;
  fresh.forEach((l) => {
    if (l.quiet) return; // 与金额播报重复的描述句，只在侧栏日志里出现
    if (SILENT_KINDS.has(l.kind)) return;
    const actor = S.players.find((p) => l.text.startsWith(p.name));
    const delta = l.delta || 0;
    const chip = delta
      ? `<div class="tb-delta ${delta > 0 ? 'gain' : 'loss'}">${delta > 0 ? '+' : '−'}kr ${fmt(Math.abs(delta))}</div>`
      : '';
    queueBanner({
      type: 'event',
      // 文案越长，留的阅读时间越久；两条能同时看，单条就不用停太久
      ms: Math.min(1750, 950 + l.text.length * 15),
      color: l.kind === 'win' ? '#ffd479' : actor?.color || '#4ce0b3',
      html: `
        <div class="tb-kicker">${actor ? `<i class="tb-e-dot" style="--c:${actor.color}"></i>` : ''}${EVENT_LABEL[l.kind] || '岛上报事'}</div>
        <div class="tb-text">${esc(l.text)}</div>
        ${chip}`,
      sound: soundForLog(l),
    });
  });
}

function queueBanner(item) {
  store.bannerQueue.push(item);
  if (store.bannerQueue.length > 10) store.bannerQueue.shift();
  pumpBanner();
}

// 棋子正在走（或刚落地还没停稳）时，任何播报都要排队等。
// 段间停住时反过来：棋子不走，让播报先出来。
function tokensSettling() {
  if (store.moveHold) return false;
  return pendingMove() || !!store.moveTimer || Date.now() < store.moveSettleAt;
}

function schedulePump(ms) {
  clearTimeout(store.bannerWaitTimer);
  store.bannerWaitTimer = setTimeout(pumpBanner, ms);
}

function pumpBanner() {
  if (!store.bannerQueue.length) {
    // 段间停顿但这一趟没有播报可放（日志被过滤了）：别干等到兜底，直接接着走
    if (store.moveHold && !store.moveResumeTimer) resumeMove();
    return;
  }
  if (tokensSettling()) {
    schedulePump(130);
    return;
  }
  const next = store.bannerQueue[0];
  const live = store.bannerStack;
  // 回合播报独占屏幕；事件播报最多叠 BANNER_STACK_MAX 条
  const soloing = live.some((r) => r.type !== 'event');
  const full = next.type === 'event'
    ? live.length >= BANNER_STACK_MAX
    : live.length > 0;
  if (soloing || full) {
    schedulePump(140);
    return;
  }
  // 两条播报的出场至少隔开 BANNER_STAGGER_MS，绝不挤在同一瞬间冒出来
  const since = Date.now() - store.bannerLastShowAt;
  if (since < BANNER_STAGGER_MS) {
    schedulePump(BANNER_STAGGER_MS - since + 10);
    return;
  }

  showBanner(store.bannerQueue.shift());
  // 后面还排着队？到点了再放下一条
  if (store.bannerQueue.length) schedulePump(BANNER_STAGGER_MS);
}

function showBanner(item) {
  const stack = $('#banner-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = `bc-banner ${item.type}`;
  el.style.setProperty('--c', item.color);
  // 停在段间时，这条播报就是"棋子要动"的由头，把去向写进卡片里
  el.innerHTML = item.html + (store.moveHint || '');
  store.moveHint = null; // 只跟一条播报，别串到后面无关的播报上

  const rec = {
    el, type: item.type, endsAt: Date.now() + item.ms,
    timer: null, outTimer: null, retiring: false,
    dy: BANNER_ENTER_PX, scale: BANNER_ENTER_SCALE, opacity: 0,
  };
  paintBanner(rec);      // 起始态：缩小、透明、再往下一点点
  stack.appendChild(el);
  void el.offsetWidth;   // 先落一帧，让上面这行成为过渡的起点

  store.bannerStack.push(rec);
  store.bannerLastShowAt = Date.now();
  armMoveResume();                 // 这条播报正是上一段位移触发的，等它读完再走下一段
  flushCashFx();                   // 钱和字幕一起出现，别抢在播报前面
  if (item.sound) sfx(item.sound); // 声画同步：卡片出现的同时响
  layoutStack();         // 新的一条滑到位，旧的那条被顶上去
  syncBannerFlags();
  rec.timer = setTimeout(() => retireBanner(rec), item.ms);
  renderActions();       // 播报期间锁住操作
}

// 从上往下算偏移量：最新的那条贴着锚点，其余依次往上排
function layoutStack() {
  const live = store.bannerStack;
  let acc = 0;
  for (let i = live.length - 1; i >= 0; i--) {
    const rec = live[i];
    if (rec.retiring) continue; // 正在淡出的不动它，别把它的收场动画打断
    // 被顶上去也保持原样：不缩小、不半透明，每条播报只按自己的节奏来
    rec.dy = -acc;
    rec.scale = 1;
    rec.opacity = 1;
    paintBanner(rec);
    acc += rec.el.offsetHeight + BANNER_GAP_PX;
  }
}

// 位置和透明度写在一起，交给 CSS 的 transition 补间
function paintBanner(rec) {
  const base = rec.type === 'turn' ? '50%' : '0px'; // 回合播报以锚点为中心，事件播报贴下沿
  rec.el.style.transform = `translate(-50%, calc(${base} + ${rec.dy}px)) scale(${rec.scale})`;
  rec.el.style.opacity = rec.opacity;
}

// 到点了就收：先淡出、稍稍下沉，腾出位置后再放被压住的走子 / 下一条播报
function retireBanner(rec) {
  if (!store.bannerStack.includes(rec) || rec.retiring) return;
  rec.retiring = true;
  rec.dy += BANNER_SINK_PX;
  rec.scale = BANNER_OUT_SCALE;
  rec.opacity = 0;
  paintBanner(rec);
  rec.outTimer = setTimeout(() => {
    rec.el.remove();
    const i = store.bannerStack.indexOf(rec);
    if (i >= 0) store.bannerStack.splice(i, 1);
    syncBannerFlags();
    layoutStack();
    renderActions();
    flushVisuals(); // 被播报压住的掷骰 / 走子，现在接着放
    pumpBanner();
  }, BANNER_OUT_MS);
}

// 屏上还有播报吗？顺便把"最晚什么时候解锁"记下来
function syncBannerFlags() {
  store.bannerBusy = store.bannerStack.length > 0;
  store.bannerUntil = store.bannerStack.reduce((m, r) => Math.max(m, r.endsAt), 0);
  const stack = $('#banner-stack');
  // 事件播报整体下移一点，让开中央的骰子
  if (stack) stack.classList.toggle('event-mode', store.bannerStack.some((r) => r.type === 'event'));
}

// 换房间 / 重开一局：屏上的播报、排队等待的播报一起作废
function resetBannerCursor() {
  clearBannerStack();
  store.bannerQueue = [];
  store.bannerBusy = false;
  store.bannerUntil = 0;
  store.lastLogSeq = null;
  store.lastTurnKey = '';
  store.moveQ.clear();
  store.pathStash.clear();
  store.moveSeq = -1;
  clearTimeout(store.moveHoldTimer);
  clearTimeout(store.moveResumeTimer);
  store.moveHoldTimer = null;
  store.moveResumeTimer = null;
  store.moveHold = false;
  clearPrime();
  clearTimeout(store.cashFxTimer);
  store.cashFxTimer = null;
  store.cashFxQueue = [];
  store.cashPrev.clear(); // 新一局重新记基准，别开局就飘一堆金额
}

// 换房间 / 重开一局：把屏上的播报连定时器一起清干净
function clearBannerStack() {
  store.bannerStack.forEach((r) => {
    clearTimeout(r.timer);
    clearTimeout(r.outTimer);
    r.el.remove();
  });
  store.bannerStack = [];
  store.bannerLastShowAt = 0;
  clearTimeout(store.bannerWaitTimer);
  syncBannerFlags();
}

// 一条播报收完，把等待展示的骰子和走子放出来
function flushVisuals() {
  if (!store.state) return;
  renderCenter();
  renderTokens();
}

// 画面彻底安静了（没播报、没走子）才回执；服务端据此放机器人继续走
function maybeAck() {
  const S = store.state;
  if (!S || S.phase !== 'playing' || !store.room) return;
  if (store.bannerBusy || store.bannerQueue.length || tokensSettling() || store.moveHold) return;
  if (Date.now() < store.bannerUntil) return;
  if (store.lastAck === S.version) return;
  const version = S.version;
  api('/api/ack', { roomId: store.room, token: store.token, version })
    .then(() => { store.lastAck = version; })
    .catch(() => { /* 下个轮次再回执 */ });
}

// ────────────── 操作面板 ──────────────
function renderActions() {
  const S = store.state;
  const me = myPlayer();
  const p = S.players[S.current];
  const myTurn = p?.id === store.me;
  const box = $('#actions');
  let h = '';

  if (p) {
    h += `<div class="turn-strip" style="--c:${p.color}">
      <div class="ts-token" style="--c:${p.color}">${p.emoji}</div>
      <div>
        <div class="ts-name">${esc(p.name)}${myTurn ? ' · 你' : ''}</div>
        <div class="ts-sub">${S.phase === 'ended' ? '对局结束' : `第 ${S.turnNo}${S.turnLimit ? ' / ' + S.turnLimit : ''} 回合`}</div>
      </div>
    </div>`;
  }

  if (myTurn && S.phase === 'playing') {
    const near = nearSets(me);
    if (near.length) {
      h += `<div class="near-set">差 1 块集齐：${near.map((n) => `<b style="color:${n.color}">${esc(n.name)}</b>`).join('、')} · 试试交易</div>`;
    }
  }

  if (S.phase === 'ended') {
    const w = playerById(S.winnerId);
    h += `<div class="decision">
      <div class="d-title">${w ? `🏆 ${esc(w.name)} 胜出` : '对局结束'}</div>
      <div class="d-sub">群岛的租金帝国已经易主。</div>
      <div class="d-row"><button class="btn primary" data-action="openEnd">查看结算</button></div>
    </div>`;
    if (S.hostId === store.me) {
      h += `<button class="btn" data-action="restart">开新一局</button>`;
    }
    box.innerHTML = h;
    if (!store.endShown) { store.endShown = true; setTimeout(openEnd, 320); }
    return;
  }

  // 待决策：买地
  if (S.pending?.type === 'buy') {
    const idx = S.pending.index;
    const c = store.board[idx];
    if (myTurn) {
      h += `<div class="decision">
        <div class="d-title">${c.icon} ${esc(c.name)}</div>
        <div class="d-sub">${money(c.price)} · 租金 ${c.rent ? money(c.rent[0]) : '—'}${c.type === 'prop' ? `（成套 ×2）` : ''}<br>你手上有 ${money(me.cash)}</div>
        <div class="d-row">
          <button class="btn primary" data-action="buy" ${me.cash < c.price ? 'disabled' : ''}>买下</button>
          <button class="btn ghost" data-action="pass">放弃</button>
        </div>
      </div>`;
    } else {
      h += `<div class="decision"><div class="d-title">等待 ${esc(p.name)}</div><div class="d-sub">${p.isBot ? `🤖 机器人正在考虑是否买下「${esc(c.name)}」。` : `对方正在考虑是否买下「${esc(c.name)}」。`}</div></div>`;
    }
  }

  // 待决策：监狱
  if (S.pending?.type === 'jail') {
    if (myTurn) {
      h += `<div class="decision jail-decision">
        <div class="d-title">🔒 你在监狱</div>
        <div class="d-sub">支付 ${money(store.meta.JAIL_FINE)} 保释，或掷出对子脱身（最多 3 次）。</div>
        <div class="d-row"><button class="btn primary" data-action="jailPay">付保释金</button>
        <button class="btn" data-action="jailRoll">掷骰求对子</button></div>
        ${me.cards ? `<div class="d-row" style="margin-top:7px"><button class="btn ghost" data-action="jailCard">用免费渡轮票（${me.cards}）</button></div>` : ''}
      </div>`;
    } else {
      h += `<div class="decision jail-decision"><div class="d-title">等待 ${esc(p.name)}</div><div class="d-sub">${p.isBot ? '🤖 机器人正在狱中想办法。' : '对方正在狱中想办法。'}</div></div>`;
    }
  }

  // 常规操作
  if (!S.pending) {
    if (myTurn) {
      if (S.canRoll) {
        h += `<button class="btn primary block" data-action="roll">🎲 掷骰子</button>`;
      } else {
        h += `<button class="btn primary block" data-action="endTurn">结束回合 →</button>`;
      }
      h += `<div style="display:flex;gap:8px">
        <button class="btn ghost" style="flex:1" data-action="openAssets">我的资产</button>
        <button class="btn ghost" style="flex:1" data-action="openTrade">交易</button>
      </div>`;
    } else {
      h += `<div class="decision"><div class="d-title">等待 ${esc(p?.name || '')}</div><div class="d-sub">${p?.isBot ? '🤖 机器人正在思考…' : '轮到对方行动。可以先看看对手的地产。'}</div></div>`;
    }
  }

  // 收到的交易请求
  if (S.trade && S.trade.to === store.me) {
    h += tradeOfferCard(S.trade, true);
  } else if (S.trade && S.trade.from === store.me) {
    h += tradeOfferCard(S.trade, false);
  }

  box.innerHTML = h;
  // 掷骰是「回合之间」的动作，要等播报和走子都放完；
  // 买地、放弃、结束回合这些「回合之内」的操作不等播报，只等自己的棋子落地
  const moving = tokensSettling() || store.moveHold;
  const waitDice = Date.now() < store.bannerUntil || store.bannerBusy
    || store.bannerQueue.length > 0 || moving;
  box.classList.toggle('locked', waitDice);
  if (waitDice) {
    $$('button[data-action="roll"], button[data-action="jailRoll"]', box).forEach((b) => { b.disabled = true; });
  }
  if (moving) {
    $$('button[data-action]', box).forEach((b) => { b.disabled = true; });
    // 这一版画面正好停在"棋子还在动"的瞬间，播报也放完了，就再也没有人来重画按钮，
    // 结果结束回合一直灰着（进监狱那 20 格就是这么卡的）。留一个兜底重画，落地即解锁。
    markActionsStale();
  } else {
    clearActionsStale();
  }
}

// 走子 / 停顿期间禁用按钮后，隔一会儿再重画一次：安静下来就把按钮放出来。
// 只在"还在动"的时候续期，画面稳定后自然停下，不会一直空转。
function markActionsStale() {
  if (store.actionsStaleTimer) return;
  store.actionsStaleTimer = setTimeout(() => {
    store.actionsStaleTimer = null;
    renderActions();
  }, 240);
}

function clearActionsStale() {
  clearTimeout(store.actionsStaleTimer);
  store.actionsStaleTimer = null;
}

function tradeOfferCard(t, canAnswer) {
  const giveNames = t.give.map((i) => store.board[i].name).join('、');
  const getNames = t.get.map((i) => store.board[i].name).join('、');
  return `<div class="trade-offer">
    <div class="to-title">${canAnswer ? '收到交易请求' : '交易等待回应'}</div>
    <div class="to-body">
      ${esc(t.fromName)} 用 ${[giveNames, t.giveCash ? money(t.giveCash) : ''].filter(Boolean).join(' + ') || '（无）'}
      换 ${esc(t.toName)} 的 ${[getNames, t.getCash ? money(t.getCash) : ''].filter(Boolean).join(' + ') || '（无）'}
    </div>
    ${canAnswer ? `<div class="d-row">
      <button class="btn primary" data-action="respondTrade" data-accept="1">接受</button>
      <button class="btn ghost" data-action="respondTrade" data-accept="0">拒绝</button>
    </div>` : ''}
  </div>`;
}

function renderLog() {
  const S = store.state;
  const box = $('#log');
  // 日志是 append-only 的，长度 + 末条 seq 不变说明没有新内容
  const last = S.log[S.log.length - 1];
  const key = S.log.length + ':' + (last ? last.seq || 0 : 0);
  if (store.lastLogRenderKey === key) return;
  store.lastLogRenderKey = key;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.innerHTML = S.log
    .map((l) => {
      const d = l.delta || 0;
      const chip = d
        ? `<span class="log-delta ${d > 0 ? 'gain' : 'loss'}">${d > 0 ? '+' : '−'}kr ${fmt(Math.abs(d))}</span>`
        : '';
      const tone = d > 0 ? ' gain' : d < 0 ? ' loss' : '';
      return `<div class="log-item ${l.kind}${tone}"><span class="log-text">${esc(l.text)}</span>${chip}</div>`;
    })
    .join('');
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

// ────────────── 弹窗：地产 ──────────────
function openModal(html, opts = {}) {
  $('#modal-root').innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
}
// 关闭弹窗不另外发声：关闭按钮本身会走通用点击音，避免在"建房"等动作上叠两层音
function closeModal() {
  $('#modal-root').innerHTML = '';
}

function openProperty(i) {
  const c = store.board[i];
  const S = store.state;
  if (!S) return;
  const st = S.cells[i];
  const owner = st.owner ? playerById(st.owner) : null;
  const myTurn = isMyTurn();
  const me = myPlayer();
  const group = c.group ? store.groups[c.group] : null;
  const color = group ? group.color : c.type === 'ferry' ? '#7fa7c9' : c.type === 'util' ? '#8fd9c0' : '#26384e';

  let body = '';
  if (owner) {
    body += `<div class="owner-line" style="--c:${owner.color}">
      <span class="owner-dot"></span>业主：<b>${esc(owner.name)}</b>${st.mortgaged ? ' · 抵押中' : ''}
    </div>`;
  } else if (['prop', 'ferry', 'util'].includes(c.type)) {
    body += `<div class="owner-line"><span class="owner-dot" style="--c:#4a5f77"></span>尚未售出</div>`;
  }

  if (c.type === 'prop') {
    const owns = owner && store.board.filter((x) => x.group === c.group).every((x) => {
      const idx = store.board.indexOf(x);
      return S.cells[idx].owner === owner.id;
    });
    const rentLabels = ['空地', '成套空地（×2）', '1 栋房屋', '2 栋房屋', '3 栋房屋', '4 栋房屋', '酒店'];
    body += `<table class="rent-table">`;
    body += `<tr class="${st.houses === 0 && !owns ? 'hi' : ''}"><td>${rentLabels[0]}</td><td>${money(c.rent[0])}</td></tr>`;
    body += `<tr class="${st.houses === 0 && owns ? 'hi' : ''}"><td>${rentLabels[1]}</td><td>${money(c.rent[0] * 2)}</td></tr>`;
    for (let hIdx = 1; hIdx <= 5; hIdx++) {
      body += `<tr class="${st.houses === hIdx ? 'hi' : ''}"><td>${rentLabels[hIdx + 1]}</td><td>${money(c.rent[hIdx])}</td></tr>`;
    }
    body += `</table>`;
    body += `<div style="margin-top:12px">
      <div class="kv"><span>地价</span><b>${money(c.price)}</b></div>
      <div class="kv"><span>每栋房屋 / 酒店</span><b>${money(c.houseCost)}</b></div>
      <div class="kv"><span>抵押价</span><b>${money(Math.floor(c.price / 2))}</b></div>
      <div class="kv"><span>赎回价</span><b>${money(Math.ceil(c.price / 2 * 1.1))}</b></div>
    </div>`;
  } else if (c.type === 'ferry') {
    body += `<div class="kv"><span>票价</span><b>${money(c.price)}</b></div>`;
    c.rent.forEach((r, idx) => {
      body += `<div class="kv"><span>持有 ${idx + 1} 座渡口</span><b>${money(r)}</b></div>`;
    });
  } else if (c.type === 'util') {
    body += `<div class="kv"><span>价格</span><b>${money(c.price)}</b></div>
      <div class="kv"><span>持有 1 处</span><b>骰子点数 × ${fmt(store.meta.UTIL_RENT_PER_PIP)}</b></div>
      <div class="kv"><span>持有 2 处</span><b>骰子点数 × ${fmt(store.meta.UTIL_RENT_BOTH)}</b></div>`;
  } else {
    const desc = {
      go: `经过或停留领取 ${money(store.meta.SALARY)}。`,
      jail: '探访监狱，不受影响。',
      parking: '免费歇脚，抬头看一会儿极光。',
      gotojail: '非法捕鳕鱼被当场抓获，直接进监狱。',
      tax: `向银行缴纳 ${money(c.amount)}。`,
      chance: '抽一张极光卡，可能是惊喜，也可能是惊吓。',
      chest: '抽一张命运卡，岛上的日常。',
    }[c.type] || '';
    body += `<p class="hint" style="margin-top:0">${desc}</p>`;
    if (c.type === 'chance' || c.type === 'chest') {
      const deck = c.type === 'chance' ? store.decks.chance : store.decks.chest;
      body += `<div style="margin-top:10px;display:flex;flex-direction:column;gap:5px">` +
        deck.map((d) => `<div style="font-size:11.5px;color:#8ea4ba"><b style="color:#c3b6ff">${esc(d.title)}</b> · ${esc(d.text)}</div>`).join('') +
        `</div>`;
    }
  }

  let foot = `<button class="btn ghost" data-close="1">关闭</button>`;
  if (owner?.id === store.me && myTurn && S.phase === 'playing') {
    if (c.type === 'prop') {
      if (st.houses < 5) foot = `<button class="btn primary" data-build="${i}">${st.houses === 4 ? '升级酒店' : '建房'} · ${money(c.houseCost)}</button>` + foot;
      if (st.houses > 0) foot = `<button class="btn ghost" data-sell="${i}">拆房 +${money(Math.floor(c.houseCost / 2))}</button>` + foot;
    }
    if (!st.mortgaged && (c.type !== 'prop' || !hasBuildings(c.group, st.owner))) {
      foot = `<button class="btn ghost" data-mortgage="${i}">抵押 +${money(Math.floor(c.price / 2))}</button>` + foot;
    } else if (st.mortgaged) {
      foot = `<button class="btn ghost" data-unmortgage="${i}">赎回 · ${money(Math.ceil(c.price / 2 * 1.1))}</button>` + foot;
    }
  }

  openModal(`
    <div class="modal-head">
      <div class="mh-bar" style="--c:${color}"></div>
      <div>
        <h3>${c.icon || ''} ${esc(c.name)}</h3>
        <div class="mh-sub">${esc(c.en || '')}${group ? ' · ' + group.name : ''}</div>
      </div>
      <button class="modal-close" data-close="1">✕</button>
    </div>
    <div class="modal-body">${body}</div>
    <div class="modal-foot">${foot}</div>
  `);

  const root = $('#modal-root');
  root.querySelector('[data-build]')?.addEventListener('click', () => { closeModal(); act({ type: 'build', index: i }); });
  root.querySelector('[data-sell]')?.addEventListener('click', () => { closeModal(); act({ type: 'sellHouse', index: i }); });
  root.querySelector('[data-mortgage]')?.addEventListener('click', () => { closeModal(); act({ type: 'mortgage', index: i }); });
  root.querySelector('[data-unmortgage]')?.addEventListener('click', () => { closeModal(); act({ type: 'unmortgage', index: i }); });
}

function hasBuildings(group, ownerId) {
  const S = store.state;
  return store.board.some((c, i) => c.group === group && S.cells[i].owner === ownerId && S.cells[i].houses > 0);
}

// 只差一块就成套的色组
function nearSets(p) {
  if (!p || !store.state) return [];
  const out = [];
  for (const [g, meta] of Object.entries(store.groups)) {
    const cells = store.board.map((c, i) => (c.group === g ? i : -1)).filter((i) => i >= 0);
    const missing = cells.filter((i) => store.state.cells[i].owner !== p.id);
    if (missing.length === 1) {
      out.push({ name: meta.name, color: meta.color, missing: store.board[missing[0]].name });
    }
  }
  return out;
}

// ────────────── 弹窗：资产（自己或任意对手） ──────────────
function openAssets(playerId) {
  const S = store.state;
  if (!S) return;
  const pid = playerId || store.me;
  const p = playerById(pid);
  if (!p) return;
  const mine = pid === store.me;
  const canManage = mine && isMyTurn() && S.phase === 'playing';

  const held = p.held || [];
  const jailCards = held.filter((c) => c.kind === 'jail');
  const rentCards = held.filter((c) => c.kind === 'rent');
  const heldHTML = held.length
    ? `<div class="held-list">${held.map((c) => `
        <div class="held-card ${c.kind === 'jail' ? 'is-jail' : 'is-rent'}">
          <div class="hc-icon">${c.kind === 'jail' ? '🎫' : '🎟'}</div>
          <div class="hc-body">
            <div class="hc-title">${esc(c.title)}</div>
            <div class="hc-text">${esc(c.text || '')}</div>
          </div>
        </div>`).join('')}</div>`
    : '<p class="hint" style="margin:2px 0 0">没有可保留使用的卡牌。</p>';

  const rows = p.props.length
    ? p.props.map((i) => {
      const c = store.board[i];
      const st = S.cells[i];
      let actions = '';
      if (canManage) {
        if (c.type === 'prop' && st.houses < 5) actions += `<button class="btn tiny" data-build="${i}">＋房</button>`;
        if (st.houses > 0) actions += `<button class="btn tiny" data-sell="${i}">−房</button>`;
        if (st.mortgaged) actions += `<button class="btn tiny" data-unmortgage="${i}">赎回</button>`;
        else if (c.type !== 'prop' || !hasBuildings(c.group, p.id)) actions += `<button class="btn tiny" data-mortgage="${i}">抵押</button>`;
      }
      const status = st.mortgaged ? '抵押中' : st.houses === 5 ? '🏨 酒店' : st.houses ? `${st.houses} 栋房屋` : '空地';
      const g = c.group ? store.groups[c.group] : null;
      return `<div class="asset-prop" style="--c:${g ? g.color : '#7fa7c9'}">
        <span class="ap-dot"></span>
        <span class="ap-name">${esc(c.name)}<i>${status}</i></span>
        <span class="ap-actions">${actions}</span>
      </div>`;
    }).join('')
    : `<p class="hint" style="margin:2px 0 0">${mine ? '你还没有地产。掷骰子去占地吧。' : `${esc(p.name)} 还没有地产。`}</p>`;

  const flags = [
    p.bankrupt ? '已破产' : '',
    p.inJail ? '狱中' : '',
    p.connected ? '' : '离线',
  ].filter(Boolean).join(' · ');

  const summary = `
    <div class="asset-sum">
      <div class="as-item"><span>现金</span><b>${money(p.cash)}</b></div>
      <div class="as-item"><span>总净值</span><b>${money(p.netWorth)}</b></div>
      <div class="as-item"><span>地产</span><b>${p.props.length} 处</b></div>
      <div class="as-item"><span>手牌</span><b>${held.length} 张</b></div>
    </div>`;

  openModal(`
    <div class="modal-head">
      <div class="mh-bar" style="--c:${p.color}"></div>
      <div>
        <h3>${mine ? '我的资产' : `${esc(p.name)} 的资产`}</h3>
        <div class="mh-sub">${p.emoji} ${esc(p.name)}${mine ? ' · 你' : ''}${flags ? ' · ' + flags : ''}</div>
      </div>
      <button class="modal-close" data-close="1">✕</button>
    </div>
    <div class="modal-body">
      ${summary}
      <div class="asset-sec">手持卡牌<span>${jailCards.length ? `免罪票 ×${jailCards.length}` : ''}${jailCards.length && rentCards.length ? ' · ' : ''}${rentCards.length ? `议价券 ×${rentCards.length}` : ''}</span></div>
      ${heldHTML}
      <div class="asset-sec">地产<span>${p.props.length} 处</span></div>
      ${rows}
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close="1">关闭</button></div>
  `);
  bindAssetButtons();
}

function bindAssetButtons() {
  const root = $('#modal-root');
  const map = { build: 'build', sell: 'sellHouse', mortgage: 'mortgage', unmortgage: 'unmortgage' };
  Object.keys(map).forEach((attr) => {
    $$(`[data-${attr}]`, root).forEach((b) => {
      b.addEventListener('click', () => {
        const idx = Number(b.dataset[attr]);
        closeModal();
        act({ type: map[attr], index: idx });
      });
    });
  });
}

// ────────────── 弹窗：交易 ──────────────
function openTrade() {
  const S = store.state;
  const me = myPlayer();
  const others = S.players.filter((p) => !p.bankrupt && p.id !== me.id);
  if (!others.length) return toast('没有可交易的对手');

  const render = (targetId) => {
    const target = playerById(targetId);
    const mine = me.props.length
      ? me.props.map((i) => tradeItem(i, 'give')).join('')
      : '<div class="trade-empty">你没有地产</div>';
    const theirs = target.props.length
      ? target.props.map((i) => tradeItem(i, 'get')).join('')
      : '<div class="trade-empty">对方没有地产</div>';
    return `
      <div style="margin-bottom:12px">
        <div class="field" style="margin:0">
          <span>交易对象</span>
          <select id="trade-target" class="trade-select">
            ${others.map((p) => `<option value="${p.id}" ${p.id === targetId ? 'selected' : ''}>${esc(p.name)} · ${money(p.cash)}</option>`).join('')}
          </select>
        </div>
      </div>
      ${nearHint(me, target)}
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><div class="hint" style="margin:0 0 6px">你付出</div><div class="trade-list" id="give-list">${mine}</div>
          <input id="give-cash" type="number" min="0" placeholder="现金 kr" class="cash-input" /></div>
        <div><div class="hint" style="margin:0 0 6px">你获得</div><div class="trade-list" id="get-list">${theirs}</div>
          <input id="get-cash" type="number" min="0" placeholder="现金 kr" class="cash-input" /></div>
      </div>
      <p class="hint">${target.isBot ? '对方是机器人：报价会立刻被评估，不划算就会拒绝。' : '对方会收到报价，可以接受或拒绝。'}抵押中的地产也能交易。</p>`;
  };

  const targetId = others[0].id;
  openModal(`
    <div class="modal-head">
      <div class="mh-bar" style="--c:var(--gold)"></div>
      <div><h3>发起交易</h3><div class="mh-sub">谈判是垄断的捷径</div></div>
      <button class="modal-close" data-close="1">✕</button>
    </div>
    <div class="modal-body" id="trade-body">${render(targetId)}</div>
    <div class="modal-foot">
      <button class="btn primary" id="trade-send">发送报价</button>
      <button class="btn ghost" data-close="1">取消</button>
    </div>
  `);
  $('#trade-target').addEventListener('change', (e) => {
    $('#trade-body').innerHTML = render(e.target.value);
  });
  $('#trade-send').addEventListener('click', async () => {
    const to = $('#trade-target').value;
    const give = $$('#give-list input:checked').map((x) => Number(x.value));
    const get = $$('#get-list input:checked').map((x) => Number(x.value));
    const giveCash = Number($('#give-cash').value || 0);
    const getCash = Number($('#get-cash').value || 0);
    closeModal();
    await act({ type: 'offerTrade', to, give, get, giveCash, getCash });
    toast('报价已发出，等对方回应', true);
  });
}

function nearHint(me, target) {
  const mine = nearSets(me);
  const theirs = nearSets(target);
  if (!mine.length && !theirs.length) return '';
  const fmt = (list) => list.map((n) => `<b style="color:${n.color}">${esc(n.name)}</b>（缺 ${esc(n.missing)}）`).join('、');
  return `<div class="near-hint">
    ${mine.length ? `你差 1 块：${fmt(mine)}<br>` : ''}
    ${theirs.length ? `对方差 1 块：${fmt(theirs)}` : ''}
  </div>`;
}

function tradeItem(i, side) {
  const c = store.board[i];
  return `<label class="trade-item"><input type="checkbox" value="${i}" />
    <span style="color:${c.group ? store.groups[c.group].color : '#7fa7c9'}">■</span>
    <span style="flex:1">${esc(c.name)}</span>
    <span style="color:#7f94ab;font-size:10px">${money(c.price)}</span></label>`;
}

// ────────────── 弹窗：规则 / 结算 ──────────────
function openRule() {
  openModal(`
    <div class="modal-head">
      <div class="mh-bar" style="--c:var(--green)"></div>
      <div><h3>玩法速查</h3><div class="mh-sub">LOFOTEN MONOPOLY</div></div>
      <button class="modal-close" data-close="1">✕</button>
    </div>
    <div class="modal-body" style="font-size:12.5px;line-height:1.7;color:#a9bccd">
      <p><b style="color:#e6eef7">目标</b>：让其他玩家全部破产，成为最后的岛主。</p>
      <p><b style="color:#e6eef7">起始</b>：每人 ${money(store.meta.START_CASH)}；经过起点领 ${money(store.meta.SALARY)}。</p>
      <p><b style="color:#e6eef7">回合</b>：掷两颗骰子前进；掷出对子可再掷一次，连续三次对子进监狱。</p>
      <p><b style="color:#e6eef7">买地</b>：停在无主地块可按标价买下；放弃则留在银行。</p>
      <p><b style="color:#e6eef7">租金</b>：停在他人地产付租。集齐同色地块，空地租金翻倍。</p>
      <p><b style="color:#e6eef7">建造</b>：集齐同色后可建房，须平均建造；4 栋房屋可升级为酒店。</p>
      <p><b style="color:#e6eef7">抵押</b>：抵押得半价，赎回多付 10%，抵押期间不收租。</p>
      <p><b style="color:#e6eef7">监狱</b>：付 ${money(store.meta.JAIL_FINE)} 保释、用免费渡轮票，或掷对子脱身（3 次机会）。</p>
      <p><b style="color:#e6eef7">破产</b>：现金不足会自动变卖房屋与抵押地产；仍不够则出局，资产归债主。</p>
      <p><b style="color:#e6eef7">交易</b>：自己回合内可向任一玩家发起地产 + 现金的交换。</p>
      <p><b style="color:#e6eef7">机器人</b>：房主可在等待房间添加 AI 对手，一个人也能开局；它们会自己买地、建房、坐牢、谈交易。</p>
    </div>
    <div class="modal-foot"><button class="btn ghost" data-close="1">知道了</button></div>
  `);
}

function openEnd() {
  const S = store.state;
  const rank = [...S.players].sort((a, b) => b.netWorth - a.netWorth);
  const w = playerById(S.winnerId);
  openModal(`
    <div class="modal-head">
      <div class="mh-bar" style="--c:var(--gold)"></div>
      <div><h3>对局结束</h3><div class="mh-sub">${S.endReason === 'limit' ? '回合上限到达 · 净值结算' : 'FINAL STANDINGS'}</div></div>
      <button class="modal-close" data-close="1">✕</button>
    </div>
    <div class="modal-body">
      <div class="win-title">${w ? `🏆 ${esc(w.name)}` : '无人幸存'}</div>
      ${rank.map((p, idx) => `
        <div class="rank-row ${idx === 0 ? 'first' : ''}">
          <span class="rank-no">${idx + 1}</span>
          <span style="font-size:15px">${p.emoji}</span>
          <span class="rank-name">${esc(p.name)}${p.bankrupt ? ' <span style="font-size:10px;color:#7f94ab">已破产</span>' : ''}</span>
          <span class="rank-val">${money(p.netWorth)}</span>
        </div>`).join('')}
    </div>
    <div class="modal-foot">
      <button class="btn ghost" data-close="1">继续查看棋盘</button>
      ${S.hostId === store.me ? '<button class="btn primary" id="btn-rematch">开新一局</button>' : ''}
    </div>
  `);
  $('#btn-rematch')?.addEventListener('click', () => { closeModal(); resetBannerCursor(); act({ type: 'restart' }); });
}

// ────────────── toast ──────────────
let toastTimer = null;
function toast(msg, ok = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('ok', ok);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// 状态切换时重置结算弹窗标记
let lastPhase = null;
setInterval(() => {
  const ph = store.state?.phase;
  if (ph !== lastPhase) {
    lastPhase = ph;
    if (ph !== 'ended') store.endShown = false;
  }
}, 400);

boot().catch((e) => {
  console.error(e);
  toast('加载失败：' + e.message);
});
