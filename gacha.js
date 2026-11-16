'use strict';
// 抽獎系統：獎品表、機率、保底、星星幣。想新增或調整獎品，改這個檔案就好。
// r：稀有度 0＝普通、1＝稀有、2＝最高　slot：穿戴欄位（skin 皮膚／服裝、body 身上、head 頭上、face 臉上、back 背後、trail 足跡、hairfx 髮色特效、pet 寵物）
// 限定池的 skin（鳳凰、星河、櫻吹雪、魔法少女、偶像）是整套服裝，會換掉玩家原本的衣服
// 卡池：skin／hair／pet 是「常駐池」（永遠都在）；lim 是「限定池」：最高獎每週輪換一款限定皮膚（週一 00:00 台灣時間換）。
// 新增獎品時，前端（index.html）也要有對應 id 的造型，才畫得出來。
var crypto = require('crypto');

var POOLS = { skin: '皮膚', hair: '髮式', pet: '寵物', lim: '限定' };
var STD = ['skin', 'hair', 'pet'];   // 常駐池
var SLOTS = ['skin', 'lhair', 'prop', 'body', 'head', 'face', 'back', 'trail', 'hairfx', 'pet'];

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
  { id: 'pet_rock', pool: 'pet', slot: 'pet', r: 0, n: '小石頭' },
  // 限定池：最高獎＝本週限定皮膚（附飄帶、華麗腳印、光環粒子、互動特效），其餘兩款這週抽不到
  { id: 'lim_phoenix', pool: 'lim', slot: 'skin', r: 2, n: '鳳凰・焰羽', gift: ['lh_phoenix', 'prop_fan'] },
  { id: 'lim_galaxy', pool: 'lim', slot: 'skin', r: 2, n: '星河・銀漢', gift: ['lh_galaxy', 'prop_moon'] },
  { id: 'lim_sakura', pool: 'lim', slot: 'skin', r: 2, n: '櫻吹雪', gift: ['lh_sakura', 'prop_wagasa'] },
  { id: 'lim_rose', pool: 'lim', slot: 'skin', r: 2, n: '薔薇・夢華', gift: ['lh_rose', 'prop_rose'] },
  { id: 'lim_shadow', pool: 'lim', slot: 'skin', r: 1, n: '紫影・夜刃', gift: ['lh_shadow', 'prop_blade'] },
  { id: 'lim_frost', pool: 'lim', slot: 'skin', r: 1, n: '冰晶・雪華', gift: ['lh_frost', 'prop_wand'] },
  { id: 'lim_magical', pool: 'lim', slot: 'skin', r: 1, n: '魔法少女裝', gift: 'lh_magical' },
  { id: 'lim_aurora', pool: 'lim', slot: 'hairfx', r: 1, n: '極光漸層髮' },
  { id: 'lim_wings', pool: 'lim', slot: 'back', r: 1, n: '光之翼' },
  { id: 'lim_halo', pool: 'lim', slot: 'head', r: 1, n: '天使光環' },
  { id: 'lim_trail_star', pool: 'lim', slot: 'trail', r: 1, n: '星光足跡' },
  { id: 'lim_idol', pool: 'lim', slot: 'skin', r: 0, n: '偶像舞台裝', gift: 'lh_idol' },
  { id: 'lim_catears', pool: 'lim', slot: 'head', r: 0, n: '貓耳' },
  { id: 'lim_cape', pool: 'lim', slot: 'back', r: 0, n: '英雄披風' },
  { id: 'lim_trail_bubble', pool: 'lim', slot: 'trail', r: 0, n: '泡泡足跡' },
  { id: 'lim_trail_note', pool: 'lim', slot: 'trail', r: 0, n: '音符足跡' },
  { id: 'lim_trail_paw', pool: 'lim', slot: 'trail', r: 0, n: '貓掌足跡' },
  // 限定髮型：抽不到，抽到對應的限定服裝時「附贈」（pool 是 gift，不在任何卡池裡）
  { id: 'lh_phoenix', pool: 'gift', slot: 'lhair', r: 2, n: '鳳凰羽翼捲髮' },
  { id: 'lh_galaxy', pool: 'gift', slot: 'lhair', r: 2, n: '銀河星光長髮' },
  { id: 'lh_sakura', pool: 'gift', slot: 'lhair', r: 2, n: '和風櫻花盤髮' },
  { id: 'lh_magical', pool: 'gift', slot: 'lhair', r: 1, n: '魔法超長雙馬尾' },
  { id: 'lh_idol', pool: 'gift', slot: 'lhair', r: 0, n: '偶像閃亮側馬尾' },
  // 手持道具：一樣是抽到限定服裝時附贈，可以在衣櫃「手持」選要不要拿
  { id: 'lh_rose', pool: 'gift', slot: 'lhair', r: 2, n: '玫瑰小禮帽鮑伯' },
  { id: 'prop_rose', pool: 'gift', slot: 'prop', r: 2, n: '玫瑰捧花' },
  { id: 'lh_shadow', pool: 'gift', slot: 'lhair', r: 1, n: '夜刃高馬尾' },
  { id: 'lh_frost', pool: 'gift', slot: 'lhair', r: 1, n: '冰晶皇冠長髮' },
  { id: 'prop_blade', pool: 'gift', slot: 'prop', r: 1, n: '紫電短刃' },
  { id: 'prop_wand', pool: 'gift', slot: 'prop', r: 1, n: '雪華冰杖' },
  { id: 'prop_fan', pool: 'gift', slot: 'prop', r: 2, n: '鳳羽焰扇' },
  { id: 'prop_wagasa', pool: 'gift', slot: 'prop', r: 2, n: '櫻花和傘' },
  { id: 'prop_moon', pool: 'gift', slot: 'prop', r: 2, n: '新月星盤權杖' }
];
function giftsOf(it) { return it && it.gift ? [].concat(it.gift) : []; }
var BY_ID = {};
ITEMS.forEach(function (it) { BY_ID[it.id] = it; });

var CFG = {
  allLim: true,                     // ★ true＝四個限定池（鳳凰、星河、櫻吹雪、薔薇）同時開放可以抽；false＝只開「本週限定」一個池，每週一輪換
  coinOne: 8, coinTen: 72,          // 金幣：單抽、十抽
  starOne: 20, starTen: 180,        // 星星幣：單抽、十抽（重複普通 5 次或重複稀有 4 次 ＝ 20 星星幣 ＝ 一抽）
  pity: 30,                         // 常駐池：第 30 抽（該池連續沒中最高獎的第 30 抽）保底最高獎
  topRate: 200, rareRate: 1800,     // 單位：萬分之一。最高獎 2%、稀有 18%、其餘 80% 普通
  dupStars: [4, 5, 10],             // 重複獲得時的星星幣：普通、稀有、最高
  limPity: 50,                      // 限定池保底（第 50 抽必得本週限定皮膚）
  limTop: 150, limRare: 2000,       // 限定池：最高 1.5%、稀有 20%
  limDupTop: 30                     // 限定池最高獎重複時給的星星幣
};
// 限定池：allLim 開著時分成三個池（每池最高獎固定一款），關掉時只有一個每週輪換的 lim 池；保底共用 lim 的計數
var LIMBAN = { lp: 'lim_phoenix', lg: 'lim_galaxy', ls: 'lim_sakura', lr: 'lim_rose' };
var LIMNAME = { lp: '鳳凰', lg: '星河', ls: '櫻吹雪', lr: '薔薇' };
function isLim(pool) { return pool === 'lim' || Object.prototype.hasOwnProperty.call(LIMBAN, pool); }
function pityKey(pool) { return isLim(pool) ? 'lim' : pool; }
function openPools() { return STD.concat(CFG.allLim ? Object.keys(LIMBAN) : ['lim']); }
function poolOk(pool) { return typeof pool === 'string' && openPools().indexOf(pool) >= 0; }
function pityOf(k) { return k === 'lim' ? CFG.limPity : CFG.pity; }

// 本週限定：週一 00:00（台灣時間）換下一款
var WEEK = 7 * 86400000, MON0 = Date.UTC(2024, 0, 1) - 8 * 3600000; // 2024-01-01 是週一，台灣時間零點
function featured(now) {
  var tops = ITEMS.filter(function (it) { return it.pool === 'lim' && it.r === 2; });
  var k = Math.floor((now - MON0) / WEEK);
  return { id: tops[((k % tops.length) + tops.length) % tops.length].id, until: MON0 + (k + 1) * WEEK, next: tops[(((k + 1) % tops.length) + tops.length) % tops.length].id };
}

function pick(pool, r) {
  if (isLim(pool) && r === 2) return BY_ID[LIMBAN[pool] || featured(Date.now()).id];
  var src = isLim(pool) ? 'lim' : pool;
  var list = ITEMS.filter(function (it) { return it.pool === src && it.r === r; });
  return list[crypto.randomInt(list.length)];
}

// 抽 n 次。inv：已擁有的 id 陣列、pity：該池目前連續沒中最高獎的次數
// 回傳 { res: [{id, r, dup, st}], inv, pity, stars }（stars：這次重複獲得的星星幣總數）
function draw(pool, pity, inv, n) {
  var owned = {}, out = [], stars = 0, list = inv.slice();
  inv.forEach(function (x) { owned[x] = 1; });
  for (var i = 0; i < n; i++) {
    var cnt = pity + 1, r, lim = isLim(pool);
    var top = lim ? CFG.limTop : CFG.topRate, rare = lim ? CFG.limRare : CFG.rareRate;
    if (cnt >= pityOf(pityKey(pool))) r = 2;
    else {
      var x = crypto.randomInt(10000);
      r = x < top ? 2 : x < top + rare ? 1 : 0;
    }
    pity = r === 2 ? 0 : cnt;
    var it = pick(pool, r), dup = !!owned[it.id], st = 0;
    if (dup) { st = (lim && it.r === 2) ? CFG.limDupTop : CFG.dupStars[it.r]; stars += st; }
    else { owned[it.id] = 1; list.push(it.id); }
    var gifts = [];
    giftsOf(it).forEach(function (gf) { if (!owned[gf]) { owned[gf] = 1; list.push(gf); gifts.push(gf); } }); // 附贈配套髮型、手持道具
    out.push({ id: it.id, r: it.r, dup: dup ? 1 : 0, st: st, gift: gifts[0] || '', gifts: gifts });
  }
  return { res: out, inv: list, pity: pity, stars: stars };
}

// 前端用的目錄（會傳給每位玩家）
function catalog() {
  var pools = Object.assign({}, POOLS, LIMNAME);
  return { items: ITEMS, pools: pools, std: STD, open: openPools(), ban: LIMBAN, cfg: CFG, slots: SLOTS, lim: featured(Date.now()) };
}

// 讀資料庫的資料時整理成安全的格式
function cleanInv(v) {
  var out = [], seen = {};
  if (Array.isArray(v)) v.forEach(function (x) { if (typeof x === 'string' && BY_ID[x] && !seen[x]) { seen[x] = 1; out.push(x); } });
  out.slice().forEach(function (x) { giftsOf(BY_ID[x]).forEach(function (g) { if (!seen[g]) { seen[g] = 1; out.push(g); } }); }); // 以前抽到的人也補送
  return out;
}
function cleanPity(v) {
  var o = { skin: 0, hair: 0, pet: 0, lim: 0 };
  if (v && typeof v === 'object') Object.keys(o).forEach(function (k) { var n = Math.floor(Number(v[k])); if (n >= 0 && n < pityOf(k)) o[k] = n; });
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

module.exports = { poolOk: poolOk, pityKey: pityKey, POOLS: POOLS, STD: STD, SLOTS: SLOTS, featured: featured, ITEMS: ITEMS, BY_ID: BY_ID, CFG: CFG, draw: draw, catalog: catalog, cleanInv: cleanInv, cleanPity: cleanPity, cleanEquip: cleanEquip };
