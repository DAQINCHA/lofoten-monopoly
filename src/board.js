// 罗弗敦大富翁 —— 棋盘与卡牌数据
// 40 格环形棋盘，22 块地产 / 4 座渡轮码头 / 2 处公用事业 / 4 个角落 / 税费 / 卡牌
// 金额单位：kr（挪威克朗），整套数值按经典大富翁的比例 ×100，让「地价 / 租金」更像真实物价

export const MONEY_SCALE = 100; // 记录放大倍数，方便日后统一调整
export const START_CASH = 150000; // 起始资金（kr）
export const SALARY = 20000; // 经过起点津贴
export const JAIL_FINE = 5000; // 保释金
export const HOUSE_SUPPLY = 32; // 银行房屋总数
export const HOTEL_SUPPLY = 12; // 银行酒店总数
export const MAX_PLAYERS = 6;

// 8 个地产色组
export const GROUPS = {
  A: { name: '渔村木屋', short: '渔村', color: '#a9683f' },
  B: { name: '白沙滩', short: '沙滩', color: '#63b6cc' },
  C: { name: '极光营地', short: '极光', color: '#cf74a6' },
  D: { name: '渔港码头', short: '渔港', color: '#e0913f' },
  E: { name: '维京遗址', short: '维京', color: '#cf5252' },
  F: { name: '午夜阳光', short: '午夜', color: '#d3c159' },
  G: { name: '摄影师之路', short: '摄影', color: '#3fae7a' },
  H: { name: '群岛之巅', short: '之巅', color: '#4f74b0' },
};

const prop = (name, en, group, price, rent, houseCost, icon) => ({
  type: 'prop', name, en, group, price, rent, houseCost, icon,
});

const FERRY_PRICE = 20000;
const FERRY_RENT = [2500, 5000, 10000, 20000];
const UTIL_PRICE = 15000;
export const UTIL_RENT_PER_PIP = 400; // 独占一处：骰子点数 ×400
export const UTIL_RENT_BOTH = 1000; // 独占两处：骰子点数 ×1000

export const BOARD = [
  // ── 底边：从右下角开始向左 ──
  { type: 'go', name: '旅程起点', en: 'Start', icon: '⛵', desc: '经过或停留领取 kr 20,000' },
  prop('奥镇', 'Å i Lofoten', 'A', 6000, [200, 1000, 3000, 9000, 16000, 25000], 5000, '🐟'),
  { type: 'chest', name: '命运卡', en: 'Skjebne', icon: '🎴' },
  prop('索尔瓦根', 'Solvågen', 'A', 6000, [400, 2000, 6000, 18000, 32000, 45000], 5000, '🛖'),
  { type: 'tax', name: '渔获税', en: 'Fiskeriavgift', icon: '🧾', amount: 20000, desc: '向银行缴纳渔获税 kr 20,000' },
  { type: 'ferry', name: '莫斯克内斯渡口', en: 'Moskenes', icon: '⛴', price: FERRY_PRICE, rent: FERRY_RENT },
  prop('弗雷德旺', 'Fredvang', 'B', 10000, [600, 3000, 9000, 27000, 40000, 55000], 5000, '🏔'),
  { type: 'chance', name: '极光卡', en: 'Nordlys', icon: '🌌' },
  prop('拉姆贝格', 'Ramberg', 'B', 10000, [600, 3000, 9000, 27000, 40000, 55000], 5000, '🏖'),
  prop('维肯', 'Vikten', 'B', 12000, [800, 4000, 10000, 30000, 45000, 60000], 5000, '🪨'),

  // ── 左下角 ──
  { type: 'jail', name: '监狱', en: 'Fengsel', icon: '🔒', desc: '只是路过，别紧张' },

  // ── 左边：自下而上 ──
  prop('乌塔克莱夫', 'Utakleiv', 'C', 14000, [1000, 5000, 15000, 45000, 62500, 75000], 10000, '🌊'),
  {
    type: 'util', name: '潮汐发电站', en: 'Tidevannskraft', icon: '⚡', price: UTIL_PRICE,
    desc: `租金 = 骰子点数 ×${UTIL_RENT_PER_PIP}（独占两处则 ×${UTIL_RENT_BOTH}）`,
  },
  prop('豪克兰', 'Haukland', 'C', 14000, [1000, 5000, 15000, 45000, 62500, 75000], 10000, '🏝'),
  prop('温斯塔', 'Unstad', 'C', 16000, [1200, 6000, 18000, 50000, 70000, 90000], 10000, '🏄'),
  { type: 'ferry', name: '雷讷渡口', en: 'Reine', icon: '⛴', price: FERRY_PRICE, rent: FERRY_RENT },
  prop('卡贝尔沃格', 'Kabelvåg', 'D', 18000, [1400, 7000, 20000, 55000, 75000, 95000], 10000, '⛪'),
  { type: 'chest', name: '命运卡', en: 'Skjebne', icon: '🎴' },
  prop('斯塔姆松', 'Stamsund', 'D', 18000, [1400, 7000, 20000, 55000, 75000, 95000], 10000, '🎣'),
  prop('亨宁斯韦尔', 'Henningsvær', 'D', 20000, [1600, 8000, 22000, 60000, 80000, 100000], 10000, '🦞'),

  // ── 左上角 ──
  { type: 'parking', name: '极光营地', en: 'Nordlysleir', icon: '🌠', desc: '免费歇脚，抬头看极光' },

  // ── 顶边：自左向右 ──
  prop('努斯峡湾', 'Nusfjord', 'E', 22000, [1800, 9000, 25000, 70000, 87500, 105000], 15000, '🏘'),
  { type: 'chance', name: '极光卡', en: 'Nordlys', icon: '🌌' },
  prop('巴尔斯塔', 'Ballstad', 'E', 22000, [1800, 9000, 25000, 70000, 87500, 105000], 15000, '🚤'),
  prop('莫特松', 'Mortsund', 'E', 24000, [2000, 10000, 30000, 75000, 92500, 110000], 15000, '🐋'),
  { type: 'ferry', name: '巴尔斯塔渡口', en: 'Ballstad', icon: '⛴', price: FERRY_PRICE, rent: FERRY_RENT },
  prop('埃格姆', 'Eggum', 'F', 26000, [2200, 11000, 33000, 80000, 97500, 115000], 15000, '🗿'),
  prop('松德', 'Sund', 'F', 26000, [2200, 11000, 33000, 80000, 97500, 115000], 15000, '🏚'),
  {
    type: 'util', name: '深海养殖场', en: 'Havbruk', icon: '🐟', price: UTIL_PRICE,
    desc: `租金 = 骰子点数 ×${UTIL_RENT_PER_PIP}（独占两处则 ×${UTIL_RENT_BOTH}）`,
  },
  prop('莱克内斯', 'Leknes', 'F', 28000, [2400, 12000, 36000, 85000, 102500, 120000], 15000, '✈️'),

  // ── 右上角 ──
  { type: 'gotojail', name: '警察局', en: 'Politi', icon: '🚔', desc: '非法捕鳕鱼，直接进监狱' },

  // ── 右边：自上而下 ──
  prop('萨克里斯岛', 'Sakrisøy', 'G', 30000, [2600, 13000, 39000, 90000, 110000, 127500], 20000, '🟡'),
  prop('汉姆内岛', 'Hamnøy', 'G', 30000, [2600, 13000, 39000, 90000, 110000, 127500], 20000, '📷'),
  { type: 'chest', name: '命运卡', en: 'Skjebne', icon: '🎴' },
  prop('雷讷', 'Reine', 'G', 32000, [2800, 15000, 45000, 100000, 120000, 140000], 20000, '⛰'),
  { type: 'ferry', name: '斯克罗瓦渡口', en: 'Skrova', icon: '⛴', price: FERRY_PRICE, rent: FERRY_RENT },
  { type: 'chance', name: '极光卡', en: 'Nordlys', icon: '🌌' },
  prop('斯沃尔韦尔', 'Svolvær', 'H', 35000, [3500, 17500, 50000, 110000, 130000, 150000], 20000, '🚢'),
  { type: 'tax', name: '极地旅游税', en: 'Reiselivsavgift', icon: '🎫', amount: 10000, desc: '向银行缴纳旅游税 kr 10,000' },
  prop('山妖峡湾', 'Trollfjord', 'H', 40000, [5000, 20000, 60000, 140000, 170000, 200000], 20000, '🌌'),
];

export const BOARD_SIZE = BOARD.length;

// ── 卡牌 ──
// moveTo: 格子索引 | back: 后退步数 | money: 收支 | feePerHouse/feePerHotel
// jail: 入狱 | jailCard: 免罪卡 | skip: 停一回合 | salary: 经过起点领钱
// hold: 可保留的卡（'rent' 付租减半），进玩家手牌，随时可在资产里查看
export const CHANCE = [
  { title: '午夜太阳', text: '太阳不下山，玩得忘了时间。立即回到旅程起点，领取 kr 20,000。', moveTo: 0, salary: true },
  { title: '巨鳕上钩', text: '捕到一条打破纪录的鳕鱼，鱼市老板慷慨解囊。获得 kr 15,000。', money: 15000 },
  { title: '风暴掀翻晒鱼架', text: '晒鱼架倒了。每栋房屋支付 kr 2,500，每座酒店支付 kr 10,000。', feePerHouse: 2500, feePerHotel: 10000 },
  { title: '极光摄影大赛', text: '你在汉姆内岛拍到了完美极光。获得奖金 kr 10,000。', money: 10000 },
  { title: '渡轮延误', text: '浓雾封港，渡轮停航。停留一回合。', skip: true },
  { title: '非法捕鱼', text: '海警登船检查，渔网不合规。直接前往监狱。', jail: true },
  { title: '攀登雷讷布林根', text: '你决定去爬那道 448 级台阶。前往「雷讷」。', moveToName: '雷讷' },
  { title: '海雕抢食', text: '一只白尾海雕叼走了你的鳕鱼干。支付 kr 5,000。', money: -5000 },
  { title: '免费渡轮票', text: '保留这张票，可免除一次入狱。', jailCard: true },
  { title: '鳕鱼节', text: '斯沃尔韦尔的鳕鱼节开幕，你是荣誉嘉宾。前往「斯沃尔韦尔」。', moveToName: '斯沃尔韦尔' },
  { title: '海藻丰收', text: '养殖场的海藻卖出了好价钱。获得 kr 20,000。', money: 20000 },
  { title: '海豹拦路', text: '一只海豹躺在路中间不肯走。后退 3 格。', back: 3 },
  { title: '老船长的欠条', text: '老船长欠你一份人情，把这张欠条收好：付租时自动抵掉一半。', hold: 'rent' },
];

export const CHEST = [
  { title: '旺季分红', text: '夏季旅舍全部订满。获得 kr 50,000。', money: 50000 },
  { title: '全岛咖啡', text: '你请全岛喝咖啡。每位其他玩家获得 kr 5,000，由你支付。', payEach: 5000 },
  { title: '渔业补贴', text: '政府发放冬季渔业补贴。获得 kr 10,000。', money: 10000 },
  { title: '水管冻裂', text: '罗布小屋的水管冻裂了。每栋房屋支付 kr 4,000。', feePerHouse: 4000, feePerHotel: 11500 },
  { title: '醉酒划船', text: '你在港口划船撞上了别人的船。前往监狱。', jail: true },
  { title: '免费渡轮票', text: '保留这张票，可免除一次入狱。', jailCard: true },
  { title: '极光之旅', text: '你带游客看了一整夜极光，收到小费。获得 kr 15,000。', money: 15000 },
  { title: '回到起点', text: '回家补给。回到旅程起点，领取 kr 20,000。', moveTo: 0, salary: true },
  { title: '海钓之旅', text: '租船出海钓鳕鱼，收获一般。支付 kr 10,000。', money: -10000 },
  { title: '继承一间罗布小屋', text: '远房亲戚留给你一间红色渔屋。获得 kr 25,000。', money: 25000 },
  { title: '社区维护费', text: '码头需要修缮，大家分摊。支付 kr 5,000。', money: -5000 },
  { title: '北极熊来访', text: '一头北极熊在村口徘徊，全村疏散。后退 2 格。', back: 2 },
  { title: '渔市议价券', text: '鱼市老板给了你一张议价券：付租时自动抵掉一半，用掉即失效。', hold: 'rent' },
];

// 便捷索引
export const INDEX_BY_NAME = new Map(BOARD.map((c, i) => [c.name, i]));
export const GROUP_CELLS = Object.fromEntries(
  Object.keys(GROUPS).map((g) => [g, BOARD.map((c, i) => (c.group === g ? i : -1)).filter((i) => i >= 0)])
);
