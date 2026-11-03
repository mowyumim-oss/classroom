'use strict';
// 抽獎系統：獎品表、機率、保底、星星幣。想新增或調整獎品，改這個檔案就好。
// r：稀有度 0＝普通、1＝稀有、2＝最高　slot：穿戴欄位（skin 皮膚、body 身上、head 頭上、face 臉上、pet 寵物）
// 新增獎品時，前端（index.html）也要有對應 id 的造型，才畫得出來。
var crypto = require('crypto');

var POOLS = { skin: '皮膚', hair: '髮式', pet: '寵物' };
var SLOTS = ['skin', 'body', 'head', 'face', 'pet'];

var ITEMS = [
  // 皮膚池
  { id: 'skin_rainbow', pool: 'skin', slot: 'skin', r: 2, n: '彩虹色' },
  { id: 'skin_gold', pool: 'skin', slot: 'skin', r: 1, n: '閃亮金' },
  { id: 'skin_night', pool: 'skin', slot: 'skin', r: 1, n: '星空夜' },
  { id: 'skin_cow', pool: 'skin', slot: 'skin', r: 0, n: '乳牛斑紋' },
  { id: 'skin_melon', pool: 'skin', slot: 'skin', r: 0, n: '西瓜條紋' },
  { id: 'skin_check', pool: 'skin', slot: 'skin', r: 0, n: '棋盤格' },
  { id: 'tie_red', pool: 'skin', slot: 'body', r: 0, n: '紅領帶' },
  { id: 'tie_bow', pool: 'skin', slot: 'body', r: 0, n: '蝴蝶領結' },
  // 髮式池
  { id: 'hair_flower', pool: 'hair', slot: 'head', r: 2, n: '花朵髮夾' },
  { id: 'hat_crown', pool: 'hair', slot: 'head', r: 1, n: '皇冠' },
  { id: 'hair_heart', pool: 'hair', slot: 'head', r: 1, n: '愛心髮箍' },
  { id: 'hat_beanie', pool: 'hair', slot: 'head', r: 0, n: '毛線帽' },
  { id: 'hair_bow', pool: 'hair', slot: 'head', r: 0, n: '蝴蝶結' },
  { id: 'hair_ahoge', pool: 'hair', slot: 'head', r: 0, n: '呆毛' },
  { id: 'hair_afro', pool: 'hair', slot: 'head', r: 0, n: '爆炸頭' },
  { id: 'glasses_round', pool: 'hair', slot: 'face', r: 0, n: '圓框眼鏡' },
  { id: 'glasses_black', pool: 'hair', slot: 'face', r: 0, n: '黑框眼鏡' },
  { id: 'glasses_sun', pool: 'hair', slot: 'face', r: 0, n: '墨鏡' },
  // 寵物池
  { id: 'pet_ragdoll', pool: 'pet', slot: 'pet', r: 2, n: '布偶貓' },
  { id: 'pet_shiba', pool: 'pet', slot: 'pet', r: 1, n: '柴犬' },
  { id: 'pet_penguin', pool: 'pet', slot: 'pet', r: 1, n: '小企鵝' },
  { id: 'pet_chick', pool: 'pet', slot: 'pet', r: 0, n: '小雞' },
  { id: 'pet_turtle', pool: 'pet', slot: 'pet', r: 0, n: '小烏龜' },
  { id: 'pet_poop', pool: 'pet', slot: 'pet', r: 0, n: '一坨便便' },
  { id: 'pet_rock', pool: 'pet', slot: 'pet', r: 0, n: '小石頭' }
];
var BY_ID = {};
ITEMS.forEach(function (it) { BY_ID[it.id] = it; });

var CFG = {
  coinOne: 8, coinTen: 72,          // 金幣：單抽、十抽
  starOne: 20, starTen: 180,        // 星星幣：單抽、十抽（重複普通 5 次或重複稀有 4 次 ＝ 20 星星幣 ＝ 一抽）
  pity: 30,                         // 第 30 抽（該池連續沒中最高獎的第 30 抽）保底最高獎
  topRate: 200, rareRate: 1800,     // 單位：萬分之一。最高獎 2%、稀有 18%、其餘 80% 普通
  dupStars: [4, 5, 10]              // 重複獲得時的星星幣：普通、稀有、最高
};

function pick(pool, r) {
  var list = ITEMS.filter(function (it) { return it.pool === pool && it.r === r; });
  return list[crypto.randomInt(list.length)];
}

// 抽 n 次。inv：已擁有的 id 陣列、pity：該池目前連續沒中最高獎的次數
// 回傳 { res: [{id, r, dup, st}], inv, pity, stars }（stars：這次重複獲得的星星幣總數）
function draw(pool, pity, inv, n) {
  var owned = {}, out = [], stars = 0, list = inv.slice();
  inv.forEach(function (x) { owned[x] = 1; });
  for (var i = 0; i < n; i++) {
    var cnt = pity + 1, r;
    if (cnt >= CFG.pity) r = 2;
    else {
      var x = crypto.randomInt(10000);
      r = x < CFG.topRate ? 2 : x < CFG.topRate + CFG.rareRate ? 1 : 0;
    }
    pity = r === 2 ? 0 : cnt;
    var it = pick(pool, r), dup = !!owned[it.id], st = 0;
    if (dup) { st = CFG.dupStars[it.r]; stars += st; }
    else { owned[it.id] = 1; list.push(it.id); }
    out.push({ id: it.id, r: it.r, dup: dup ? 1 : 0, st: st });
  }
  return { res: out, inv: list, pity: pity, stars: stars };
}

// 前端用的目錄（會傳給每位玩家）
function catalog() {
  return { items: ITEMS, pools: POOLS, cfg: CFG, slots: SLOTS };
}

// 讀資料庫的資料時整理成安全的格式
function cleanInv(v) {
  var out = [], seen = {};
  if (Array.isArray(v)) v.forEach(function (x) { if (typeof x === 'string' && BY_ID[x] && !seen[x]) { seen[x] = 1; out.push(x); } });
  return out;
}
function cleanPity(v) {
  var o = { skin: 0, hair: 0, pet: 0 };
  if (v && typeof v === 'object') Object.keys(o).forEach(function (k) { var n = Math.floor(Number(v[k])); if (n >= 0 && n < CFG.pity) o[k] = n; });
  return o;
}
function cleanEquip(v, inv) {
  var o = {};
  if (v && typeof v === 'object') SLOTS.forEach(function (s) {
    var id = v[s];
    if (typeof id === 'string' && BY_ID[id] && BY_ID[id].slot === s && inv.indexOf(id) >= 0) o[s] = id;
  });
  return o;
}

module.exports = { POOLS: POOLS, SLOTS: SLOTS, ITEMS: ITEMS, BY_ID: BY_ID, CFG: CFG, draw: draw, catalog: catalog, cleanInv: cleanInv, cleanPity: cleanPity, cleanEquip: cleanEquip };
