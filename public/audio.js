// 罗弗敦大富翁 —— 程序化音频
// 全部用 Web Audio 实时合成，不加载任何音频文件、不依赖第三方库。
// BGM：北欧海岛 lo-fi（手风琴铺底 + 木琴主旋律 + 木质打击乐 + 海浪底噪），
//      96 BPM、8 小节一循环（约 20 秒），前瞻调度保证无缝衔接。
// SFX：按游戏事件即时合成，音色沿用同一套"木头 + 金属 + 风铃"的质感。

const LS_KEY = 'lofoten:audio';
const DEFAULTS = { music: 0.3, sfx: 0.8, muted: false };

// ────────────── 曲式 ──────────────
const BPM = 96;
const BEAT = 60 / BPM;        // 一拍
const STEP = BEAT / 4;        // 十六分音符
const BAR = 16;               // 每小节 16 个十六分音符
const BARS = 8;
const TOTAL = BAR * BARS;
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// 和声：Am - F - C - G 走两遍，简单好记，是"洗脑"的关键
const CHORDS = [
  [57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62],
  [57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62],
];
const BASS = [45, 41, 48, 43, 45, 41, 48, 43];

// 主旋律：[步序, MIDI, 时长(拍)]，A 小调五声音阶
const MELODY = [
  [0, 69, 0.9], [4, 72, 0.5], [6, 76, 0.5], [8, 74, 0.9], [12, 72, 0.5],
  [16, 69, 1.2], [22, 67, 0.5], [24, 69, 0.9], [28, 72, 0.5],
  [32, 72, 0.5], [36, 76, 0.5], [38, 74, 0.5], [40, 72, 0.9], [44, 69, 0.5],
  [48, 76, 0.9], [52, 74, 0.5], [56, 72, 0.9], [60, 69, 0.5],
  [64, 67, 0.5], [68, 69, 0.5], [70, 72, 0.5], [72, 74, 0.9], [76, 76, 0.5],
  [80, 76, 1.2], [86, 74, 0.5], [88, 72, 0.9], [92, 69, 0.5],
  [96, 69, 0.5], [100, 72, 0.5], [102, 74, 0.5], [104, 76, 0.9], [108, 74, 0.5],
  [112, 72, 0.9], [116, 69, 0.5], [120, 67, 1.0],
];
const MEL_AT = new Map();
MELODY.forEach(([s, m, d]) => {
  if (!MEL_AT.has(s)) MEL_AT.set(s, []);
  MEL_AT.get(s).push([m, d]);
});

// ────────────── 引擎 ──────────────
let ctx = null;
let master, musicBus, sfxBus, duckGain;
let noiseBuf = null;
let state = { ...DEFAULTS };
let unlocked = false;
let musicTimer = null;
let stepIdx = 0;
let nextStepTime = 0;
let ambience = null;
const listeners = new Set();

function load() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) state = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { /* 忽略 */ }
}
function save() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch (e) { /* 忽略 */ }
}
function emit() { listeners.forEach((fn) => fn(audioState())); }

function makeNoise(seconds) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();

  master = ctx.createGain();
  master.gain.value = state.muted ? 0 : 1;

  // 兜一层压缩，避免音效叠在一起时爆音
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 24;
  comp.ratio.value = 3.5;
  comp.attack.value = 0.004;
  comp.release.value = 0.25;

  duckGain = ctx.createGain();     // 播大事件时短暂压低音乐
  musicBus = ctx.createGain();
  sfxBus = ctx.createGain();
  musicBus.gain.value = state.music;
  sfxBus.gain.value = state.sfx;

  musicBus.connect(duckGain);
  sfxBus.connect(duckGain);
  duckGain.connect(comp);
  comp.connect(master);
  master.connect(ctx.destination);

  noiseBuf = makeNoise(2);
  return ctx;
}

// ────────────── 合成基元 ──────────────
function osc(o) {
  const {
    type = 'sine', freq, t, dur, gain = 0.15, attack = 0.005,
    glide = 0, lp = 0, detune = 0, dest = null,
  } = o;
  const node = ctx.createOscillator();
  node.type = type;
  node.frequency.setValueAtTime(freq, t);
  if (glide) node.frequency.exponentialRampToValueAtTime(Math.max(20, glide), t + dur);
  if (detune) node.detune.setValueAtTime(detune, t);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  let last = node;
  if (lp) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(lp, t);
    last.connect(f);
    last = f;
  }
  last.connect(g);
  g.connect(dest || sfxBus);
  node.start(t);
  node.stop(t + dur + 0.04);
}

function noise(o) {
  const {
    t, dur = 0.1, gain = 0.08, type = 'bandpass', freq = 1500,
    q = 1, sweep = 0, dest = null,
  } = o;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.setValueAtTime(freq, t);
  if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, sweep), t + dur);
  f.Q.value = q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f);
  f.connect(g);
  g.connect(dest || sfxBus);
  s.start(t);
  s.stop(t + dur + 0.04);
}

// ────────────── 乐器 ──────────────
function marimba(t, midi, dur = 0.4, gain = 0.13, dest = null) {
  const bus = dest || sfxBus;
  const f = mtof(midi);
  osc({ type: 'triangle', freq: f, t, dur, gain, attack: 0.004, dest: bus });
  osc({ type: 'sine', freq: f * 2, t, dur: dur * 0.45, gain: gain * 0.3, attack: 0.003, dest: bus });
  noise({ t, dur: 0.035, gain: gain * 0.45, type: 'bandpass', freq: 2100, q: 1.4, dest: bus });
}

function accordion(t, midis, dur, gain = 0.05, dest = null) {
  const bus = dest || sfxBus;
  midis.forEach((m, i) => {
    osc({
      type: 'sawtooth', freq: mtof(m), t, dur,
      gain: gain / midis.length, attack: 0.16, lp: 850,
      detune: (i - 1) * 7, dest: bus,
    });
  });
}

function bassNote(t, midi, dur = 0.32, dest = null) {
  const bus = dest || sfxBus;
  osc({ type: 'triangle', freq: mtof(midi), t, dur, gain: 0.16, attack: 0.012, lp: 460, dest: bus });
  osc({ type: 'sine', freq: mtof(midi), t, dur: dur * 0.8, gain: 0.11, attack: 0.012, dest: bus });
}

function kick(t, gain = 0.45, dest = null) {
  osc({ type: 'sine', freq: 132, glide: 46, t, dur: 0.22, gain, attack: 0.002, dest });
}

function woodblock(t, gain = 0.14, freq = 1400, dest = null) {
  noise({ t, dur: 0.05, gain, type: 'bandpass', freq, q: 6, dest });
  osc({ type: 'triangle', freq: 330, t, dur: 0.055, gain: gain * 0.5, attack: 0.001, dest });
}

function shaker(t, gain = 0.045, dest = null) {
  noise({ t, dur: 0.05, gain, type: 'highpass', freq: 7000, q: 0.7, dest });
}

function iceBell(t, midi, gain = 0.05, dest = null) {
  const f = mtof(midi);
  osc({ type: 'sine', freq: f, t, dur: 1.5, gain, attack: 0.004, dest });
  osc({ type: 'sine', freq: f * 2.01, t, dur: 0.9, gain: gain * 0.35, attack: 0.004, dest });
}

function coin(t, gain = 0.09, dest = null) {
  osc({ type: 'sine', freq: 1320, t, dur: 0.28, gain, attack: 0.002, dest });
  osc({ type: 'sine', freq: 1760, t: t + 0.045, dur: 0.24, gain: gain * 0.7, attack: 0.002, dest });
}

// ────────────── BGM 调度 ──────────────
function scheduleStep(i, t) {
  const bus = musicBus;
  const bar = Math.floor(i / BAR);
  const inBar = i % BAR;
  const chord = CHORDS[bar];

  if (inBar === 0) {
    accordion(t, chord, STEP * 15, 0.055, bus);
    bassNote(t, BASS[bar], 0.32, bus);
    kick(t, 0.42, bus);
    if (bar === 0 || bar === 4) iceBell(t, 88, 0.04, bus);
  }
  if (inBar === 8) {
    bassNote(t, BASS[bar] + 12, 0.22, bus);
    kick(t, 0.34, bus);
  }
  if (inBar === 4 || inBar === 12) woodblock(t, 0.12, 1400, bus);
  if (inBar === 14 && bar % 2 === 1) woodblock(t, 0.08, 1900, bus);
  if (i % 4 === 2) shaker(t, 0.04, bus);

  const notes = MEL_AT.get(i);
  if (notes) notes.forEach(([m, d]) => marimba(t, m, d * BEAT, 0.12, bus));
}

function tick() {
  if (!ctx) return;
  const horizon = ctx.currentTime + 0.3;
  while (nextStepTime < horizon) {
    scheduleStep(stepIdx, nextStepTime);
    nextStepTime += STEP;
    stepIdx = (stepIdx + 1) % TOTAL;
  }
}

function startAmbience() {
  if (ambience || !ctx) return;
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 520;
  f.Q.value = 0.6;
  const g = ctx.createGain();
  g.gain.value = 0.018;
  // 两个慢 LFO：一个推滤波器（潮声明暗），一个推音量（潮水起伏）
  const lfoA = ctx.createOscillator();
  lfoA.frequency.value = 0.07;
  const lfoAg = ctx.createGain();
  lfoAg.gain.value = 240;
  lfoA.connect(lfoAg);
  lfoAg.connect(f.frequency);

  const lfoB = ctx.createOscillator();
  lfoB.frequency.value = 0.11;
  const lfoBg = ctx.createGain();
  lfoBg.gain.value = 0.01;
  lfoB.connect(lfoBg);
  lfoBg.connect(g.gain);

  s.connect(f);
  f.connect(g);
  g.connect(musicBus);
  s.start();
  lfoA.start();
  lfoB.start();
  ambience = { s, lfoA, lfoB, g };
}

function startMusic() {
  if (!ctx || musicTimer) return;
  startAmbience();
  stepIdx = 0;
  nextStepTime = ctx.currentTime + 0.15;
  musicTimer = setInterval(tick, 45);
  tick();
}

function stopMusic() {
  if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
}

// 大事件（胜利 / 破产）时把音乐压低一点，让音效站到前面
function duck(amount = 0.5, hold = 1.2) {
  if (!ctx) return;
  const t = ctx.currentTime;
  duckGain.gain.cancelScheduledValues(t);
  duckGain.gain.setValueAtTime(duckGain.gain.value, t);
  duckGain.gain.linearRampToValueAtTime(amount, t + 0.12);
  duckGain.gain.linearRampToValueAtTime(1, t + 0.12 + hold);
}

// ────────────── 音效 ──────────────
const SFX = {
  // 通用 UI
  click: (t) => {
    osc({ type: 'sine', freq: 640, glide: 520, t, dur: 0.07, gain: 0.13, attack: 0.002 });
    noise({ t, dur: 0.02, gain: 0.04, type: 'highpass', freq: 4200 });
  },
  back: (t) => {
    osc({ type: 'sine', freq: 520, glide: 380, t, dur: 0.08, gain: 0.11, attack: 0.002 });
  },
  error: (t) => {
    osc({ type: 'square', freq: 150, glide: 110, t, dur: 0.15, gain: 0.09, lp: 800 });
  },

  // 掷骰
  roll: (t) => {
    for (let i = 0; i < 5; i++) {
      woodblock(t + i * 0.075 + Math.random() * 0.02, 0.11, 1400 + Math.random() * 800);
    }
  },
  diceLand: (t) => {
    woodblock(t, 0.22, 1150);
    woodblock(t + 0.085, 0.17, 1650);
    osc({ type: 'sine', freq: 110, glide: 58, t, dur: 0.18, gain: 0.2 });
  },
  double: (t) => {
    [76, 81, 88].forEach((m, i) => iceBell(t + i * 0.07, m, 0.06));
  },

  // 走子：每一步一记轻木声，音高随步数微微上行
  step: (t, o = {}) => {
    const k = o.k || 0;
    woodblock(t, 0.075, 880 + (k % 8) * 70);
  },
  // 二段位移前的蓄力：一声轻轻上挑的气声，提示"这颗棋子要动了"
  prime: (t) => {
    noise({ t, dur: 0.3, gain: 0.05, type: 'bandpass', freq: 520, sweep: 1500, q: 1.4 });
    osc({ type: 'sine', freq: 300, glide: 470, t, dur: 0.28, gain: 0.05, attack: 0.06 });
    iceBell(t + 0.16, 78, 0.03);
  },

  // 钱
  coin: (t) => coin(t, 0.1),
  salary: (t) => {
    for (let i = 0; i < 3; i++) coin(t + i * 0.075, 0.085);
  },
  pay: (t) => {
    osc({ type: 'triangle', freq: 440, glide: 210, t, dur: 0.3, gain: 0.12, attack: 0.004 });
    noise({ t, dur: 0.13, gain: 0.05, type: 'bandpass', freq: 900, q: 2 });
  },
  buy: (t) => {
    marimba(t, 72, 0.4, 0.13);
    marimba(t + 0.09, 79, 0.5, 0.12);
    coin(t + 0.06, 0.08);
  },
  sell: (t) => {
    marimba(t, 72, 0.4, 0.12);
    marimba(t + 0.09, 65, 0.5, 0.11);
  },

  // 建造
  build: (t) => {
    woodblock(t, 0.2, 700);
    osc({ type: 'square', freq: 180, t, dur: 0.1, gain: 0.07, lp: 900 });
  },
  hotel: (t) => {
    woodblock(t, 0.22, 700);
    [72, 76, 79, 84].forEach((m, i) => marimba(t + 0.07 * i, m, 0.45, 0.12));
  },

  // 卡牌 / 监狱 / 交易
  card: (t) => {
    noise({ t, dur: 0.26, gain: 0.085, type: 'bandpass', freq: 2600, sweep: 900, q: 0.9 });
    iceBell(t + 0.05, 84, 0.05);
  },
  jail: (t) => {
    osc({ type: 'sine', freq: 92, glide: 52, t, dur: 0.5, gain: 0.28 });
    noise({ t, dur: 0.3, gain: 0.1, type: 'bandpass', freq: 380, q: 3 });
    osc({ type: 'square', freq: 220, glide: 170, t: t + 0.1, dur: 0.3, gain: 0.05, lp: 700 });
  },
  // 被押送进监狱：棋子沿直线飞过去时的一记风声，落地那声闷响由 jailDrop 负责
  escort: (t) => {
    noise({ t, dur: 0.42, gain: 0.09, type: 'bandpass', freq: 500, sweep: 1900, q: 1.1 });
    osc({ type: 'triangle', freq: 520, glide: 240, t: t + 0.22, dur: 0.28, gain: 0.05, attack: 0.05 });
  },
  // 被押送进监狱时棋子"砰"一下落地的闷响（和播报那条低沉铁门声错开，不叠在一起）
  jailDrop: (t) => {
    osc({ type: 'sine', freq: 165, glide: 58, t, dur: 0.24, gain: 0.2 });
    noise({ t, dur: 0.11, gain: 0.07, type: 'lowpass', freq: 700 });
    woodblock(t + 0.02, 0.12, 520);
  },
  free: (t) => {
    [65, 69, 72, 76].forEach((m, i) => marimba(t + i * 0.08, m, 0.45, 0.12));
  },
  trade: (t) => {
    marimba(t, 72, 0.4, 0.11);
    marimba(t + 0.08, 76, 0.45, 0.1);
    noise({ t, dur: 0.16, gain: 0.05, type: 'bandpass', freq: 2400, sweep: 1100, q: 0.8 });
  },

  // 回合 / 结局
  turn: (t) => {
    marimba(t, 67, 0.4, 0.1);
    marimba(t + 0.1, 74, 0.5, 0.09);
  },
  chat: (t) => {
    osc({ type: 'sine', freq: 880, glide: 1180, t, dur: 0.09, gain: 0.07 });
  },
  start: (t) => {
    [60, 64, 67, 72].forEach((m, i) => marimba(t + i * 0.09, m, 0.5, 0.12));
  },
  bankrupt: (t) => {
    [69, 65, 62, 57].forEach((m, i) => marimba(t + i * 0.13, m, 0.5, 0.12));
    osc({ type: 'sawtooth', freq: 220, glide: 70, t, dur: 0.9, gain: 0.07, lp: 600 });
    duck(0.55, 1.4);
  },
  win: (t) => {
    [69, 72, 76, 81].forEach((m, i) => marimba(t + i * 0.11, m, 0.6, 0.14));
    [0, 0.35, 0.7].forEach((d, i) => iceBell(t + 0.55 + d, 76 + i * 5, 0.07));
    duck(0.45, 2.0);
  },
};

// ────────────── 对外接口 ──────────────
export function audioState() {
  return { music: state.music, sfx: state.sfx, muted: state.muted };
}

export function onAudioChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 播放一个音效；未解锁 / 静音 / 音量为 0 时直接跳过 */
export function sfx(name, opts = {}) {
  if (state.muted || state.sfx <= 0) return;
  const c = ensureCtx();
  if (!c) return;
  if (c.state === 'suspended') c.resume();
  const fn = SFX[name];
  if (!fn) return;
  try { fn(c.currentTime + 0.005, opts); } catch (e) { /* 单次音效失败不影响游戏 */ }
}

export function setMusicVol(v) {
  state.music = Math.max(0, Math.min(1, Number(v) || 0));
  if (musicBus) musicBus.gain.setTargetAtTime(state.music, ctx.currentTime, 0.05);
  save();
  emit();
}

export function setSfxVol(v) {
  state.sfx = Math.max(0, Math.min(1, Number(v) || 0));
  if (sfxBus) sfxBus.gain.setTargetAtTime(state.sfx, ctx.currentTime, 0.05);
  save();
  emit();
}

export function setMuted(m) {
  state.muted = !!m;
  if (master) master.gain.setTargetAtTime(state.muted ? 0 : 1, ctx.currentTime, 0.05);
  save();
  emit();
}

export function toggleMuted() {
  setMuted(!state.muted);
  return state.muted;
}

/** 试听：点一下就能听到当前音色的样子 */
export function preview() {
  sfx('coin');
}

/** 绑定首次用户手势：浏览器要求手势之后才能出声 */
export function initAudio() {
  load();
  const unlock = () => {
    const c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume();
    if (!unlocked) {
      unlocked = true;
      startMusic();
      emit();
    }
  };
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, unlock, { capture: true, passive: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend();
    else if (unlocked) ctx.resume();
  });
  return audioState();
}

export function isReady() {
  return !!ctx && ctx.state === 'running';
}
