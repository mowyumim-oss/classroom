'use strict';
// 教室 — HTTP + WebSocket 伺服器
// 功能：三間教室各自的黑板、窗戶狀態同步、位置同步（含高度）、黑板保存、暱稱（長度與重複檢查）、大老二（發牌與規則全在伺服器）、
//       老師 NPC（辦公室走動、依遊戲時間上下課）、點名、黑板題目、上下課鐘
var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var WS = require('ws');
var WebSocketServer = WS.WebSocketServer || WS.Server;

var PORT = process.env.PORT || 3000;
var MAX_CLIENTS = 50;
var MAX_MSG_PER_SEC = 60;
var TURN_MS = Number(process.env.TURN_MS) || 30000; // 每手限時 30 秒
var RESULT_MS = Number(process.env.RESULT_MS) || 10000; // 結算畫面停留後回到準備階段
var NICK_MAX = 7;

var server = http.createServer(function (req, res) {
  var u = req.url.split('?')[0];
  if (u === '/' || u === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), function (err, buf) {
      if (err) { res.writeHead(500); res.end('index.html missing'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(buf);
    });
  } else if (u === '/healthz') {
    res.writeHead(200); res.end('ok');
  } else {
    res.writeHead(404); res.end('not found');
  }
});

var wss = new WebSocketServer({ server: server, path: '/ws', maxPayload: 400 * 1024 });
var clients = new Set();
var NWIN = 17; // 窗戶總數：東側 10 扇 + 走廊側 7 扇
var W = []; while (W.length < NWIN) W.push(0); // 窗戶開關（記憶體，重啟後全部關閉）
var boards = [null, null, null]; // 三間教室各自的黑板快照（記憶體，重啟後清空）
function roomIdx(v) { v = Number(v); return v === 1 || v === 2 ? v : 0; } // 黑板最新快照（記憶體，重啟後會清空）

function sendTo(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function others(ws, o) {
  var s = JSON.stringify(o);
  clients.forEach(function (c) { if (c !== ws && c.readyState === 1) c.send(s); });
}

// ───────── 暱稱 ─────────
var BAD = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff\ufff9-\ufffc]/g;
function cleanNick(v) {
  if (typeof v !== 'string') return null;
  v = v.replace(BAD, '').replace(/\s+/g, ' ').trim();
  var len = Array.from(v).length;
  if (len < 1 || len > NICK_MAX) return null;
  return v;
}
function nickKey(v) { return v.normalize('NFKC').toLowerCase(); }
function nickTaken(n, except) {
  var k = nickKey(n), hit = false;
  clients.forEach(function (c) { if (c !== except && c.nick && nickKey(c.nick) === k) hit = true; });
  return hit;
}
function onNick(ws, m) {
  var n = cleanNick(m.n);
  if (!n) { sendTo(ws, { t: 'nick', ok: false, r: 'invalid', n: ws.nick }); return; }
  if (ws.seat >= 0 && T.ph !== 'lobby') {
    sendTo(ws, ws.nick === n ? { t: 'nick', ok: true, n: n } : { t: 'nick', ok: false, r: 'busy', n: ws.nick });
    return;
  }
  if (nickTaken(n, ws)) { sendTo(ws, { t: 'nick', ok: false, r: 'taken', n: ws.nick }); return; }
  ws.nick = n;
  if (ws.seat >= 0 && T.seats[ws.seat]) T.seats[ws.seat].nick = n;
  sendTo(ws, { t: 'nick', ok: true, n: n });
  presenceOut(ws);
  if (ws.seat >= 0) broadcastBt();
}

// ───────── 位置 ─────────
function num(v, a, b, d) { v = Number(v); return isFinite(v) ? Math.max(a, Math.min(b, v)) : d; }
function cleanPresence(p) {
  if (!p || typeof p !== 'object' || typeof p.x !== 'number' || typeof p.z !== 'number') return null;
  return {
    x: num(p.x, -70, 70, 0), y: num(p.y, -5, 30, 0), z: num(p.z, -70, 70, 0), f: num(p.f, -10, 10, 0),
    s: Math.floor(num(p.s, -1, 200, -1)), h: Math.floor(num(p.h, 0, 3, 0)),
    c: (typeof p.c === 'string' && /^#[0-9a-f]{6}$/i.test(p.c)) ? p.c : '#e8553d'
  };
}
function pubPresence(ws) {
  var o = Object.assign({}, ws.presence);
  o.n = ws.nick;
  o.g = ws.seat >= 0 ? ws.seat : -1;
  o.q = ws.toi >= 0 ? ws.toi : -1; // 馬桶座位同樣由伺服器決定 // 大老二座位由伺服器決定，不接受玩家自填
  return o;
}
function presenceOut(ws) {
  if (ws.nick && ws.presence && ws.readyState === 1) others(ws, { t: 'presence', peer: ws.id, presence: pubPresence(ws) });
}

// ───────── 大老二 ─────────
// 牌 id = 點數*4 + 花色；點數 0..12 = 3,4,5,6,7,8,9,10,J,Q,K,A,2；花色 0..3 = 梅花,方塊,紅心,黑桃
// id 越大牌越大。梅花 3 = id 0。
function rk(id) { return id >> 2; }
function su(id) { return id & 3; }

// 回傳 {k 牌型, n 張數, g 五張牌等級, p 同等級比大小用的數值}；不合法回傳 null
function classify(ids) {
  var n = ids.length;
  if (!n) return null;
  var c = ids.slice().sort(function (a, b) { return a - b; });
  if (n === 1) return { k: 'single', n: 1, g: 0, p: c[0] };
  if (n === 2) return rk(c[0]) === rk(c[1]) ? { k: 'pair', n: 2, g: 0, p: c[1] } : null;
  if (n !== 5) return null;
  var cnt = {}, i;
  for (i = 0; i < 5; i++) cnt[rk(c[i])] = (cnt[rk(c[i])] || 0) + 1;
  var ranks = Object.keys(cnt).map(Number), flush = true;
  for (i = 1; i < 5; i++) if (su(c[i]) !== su(c[0])) flush = false;
  if (ranks.length === 5) {
    // 順子：點數環形相連（...K A 2 3 4...），A 和 2 都能加入；比大小看「尾數」那張牌
    for (var s = 0; s < 13; s++) {
      var run = true;
      for (i = 0; i < 5; i++) if (!cnt[(s + i) % 13]) { run = false; break; }
      if (run) {
        var t = (s + 4) % 13;
        var tc = c.filter(function (x) { return rk(x) === t; })[0];
        return { k: flush ? 'sflush' : 'straight', n: 5, g: flush ? 5 : 1, p: tc };
      }
    }
    return flush ? { k: 'flush', n: 5, g: 2, p: c[4] } : null;
  }
  if (ranks.length === 2) {
    var a = ranks[0], b = ranks[1];
    if (cnt[a] === 4) return { k: 'four', n: 5, g: 4, p: a };
    if (cnt[b] === 4) return { k: 'four', n: 5, g: 4, p: b };
    return { k: 'full', n: 5, g: 3, p: cnt[a] === 3 ? a : b };
  }
  return null;
}
function beats(a, b) {
  if (!b) return true;
  if (a.n !== b.n) return false;
  if (a.n === 5) return a.g !== b.g ? a.g > b.g : a.p > b.p;
  return a.p > b.p;
}

var T = { ph: 'lobby', seats: [null, null, null, null], turn: -1, last: null, passed: {}, first: false, deadline: 0, res: null, m: '', paused: false, pauseLeft: 0 };
var turnTimer = null, resetTimer = null;

function activeSeats() {
  var a = [];
  T.seats.forEach(function (s, i) { if (s && !s.out) a.push(i); });
  return a;
}
function nextActive(from) {
  for (var k = 1; k <= 4; k++) {
    var i = (from + k) % 4, s = T.seats[i];
    if (s && !s.out) return i;
  }
  return -1;
}
function resetReady() { T.seats.forEach(function (s) { if (s) s.ready = false; }); }

function pubState() {
  return {
    t: 'bt', ph: T.ph,
    seats: T.seats.map(function (s) { return s ? { n: s.nick, r: s.ready ? 1 : 0, c: s.hand.length, o: s.out ? 1 : 0 } : { n: null, r: 0, c: 0, o: 0 }; }),
    turn: T.turn,
    last: T.last ? { s: T.last.seat, c: T.last.c, k: T.last.combo.k } : null,
    tl: T.ph === 'playing' ? (T.paused ? T.pauseLeft : Math.max(0, T.deadline - Date.now())) : 0,
    pz: T.paused ? 1 : 0,
    first: T.first ? 1 : 0,
    res: T.res, m: T.m
  };
}
function btMsgFor(ws) {
  var o = pubState();
  o.me = ws.seat;
  var s = ws.seat >= 0 ? T.seats[ws.seat] : null;
  o.hand = (s && T.ph !== 'lobby') ? s.hand : []; // 每個人只會收到自己的手牌
  return o;
}
function broadcastBt() {
  clients.forEach(function (c) { if (c.readyState === 1) c.send(JSON.stringify(btMsgFor(c))); });
  T.m = '';
}

function restartTimer() {
  clearTimeout(turnTimer);
  if (T.paused) { T.pauseLeft = TURN_MS; return; } // 點名中：倒數暫停，結束後才開始算
  T.deadline = Date.now() + TURN_MS;
  turnTimer = setTimeout(onTurnTimeout, TURN_MS);
}
// 一圈結束（其他人都 pass）就清掉桌面，由最後出牌的人（若已離開則是下一位）領出
function normalize() {
  var L = T.last;
  if (!L) return;
  if (T.turn === L.seat) { T.last = null; T.passed = {}; return; }
  var ls = T.seats[L.seat];
  if ((!ls || ls.out) && T.passed[T.turn]) { T.last = null; T.passed = {}; }
}
function advance() {
  T.turn = nextActive(T.turn);
  normalize();
  restartTimer();
}
function endGame(w) {
  clearTimeout(turnTimer);
  T.paused = false;
  T.ph = 'ended';
  T.turn = -1;
  T.res = {
    w: w,
    n: T.seats.map(function (s) { return s ? s.nick : null; }),
    c: T.seats.map(function (s) { return s ? s.hand.length : 0; }),
    o: T.seats.map(function (s) { return s && s.out ? 1 : 0; })
  };
  clearTimeout(resetTimer);
  resetTimer = setTimeout(resetLobby, RESULT_MS);
}
function resetLobby() {
  clearTimeout(turnTimer);
  clearTimeout(resetTimer);
  T.paused = false;
  T.seats = T.seats.map(function (s) {
    if (!s || s.out) return null;
    s.ready = false; s.hand = [];
    return s;
  });
  T.ph = 'lobby'; T.turn = -1; T.last = null; T.passed = {}; T.first = false; T.res = null;
  broadcastBt();
}
function shuffled() {
  var d = [], i;
  for (i = 0; i < 52; i++) d.push(i);
  for (i = 51; i > 0; i--) {
    var j = crypto.randomInt(i + 1), t = d[i]; d[i] = d[j]; d[j] = t;
  }
  return d;
}
function startGame() {
  var d = shuffled();
  T.seats.forEach(function (s, i) {
    s.hand = d.slice(i * 13, i * 13 + 13).sort(function (a, b) { return a - b; });
    s.ready = false; s.out = false;
  });
  T.ph = 'playing'; T.res = null; T.last = null; T.passed = {}; T.first = true;
  T.turn = 0;
  T.seats.forEach(function (s, i) { if (s.hand.indexOf(0) >= 0) T.turn = i; });
  T.m = '發牌完成，' + T.seats[T.turn].nick + ' 持有梅花 3，先出';
  T.paused = false;
  restartTimer();
  if (R[0].st === 'call') pauseBt(); // 發牌時剛好在點名，倒數先暫停
}
// 點名時暫停大老二的出牌倒數（牌桌在 101 教室），點名結束後從剩下的時間繼續
function pauseBt() {
  if (T.ph !== 'playing' || T.paused) return;
  T.paused = true;
  T.pauseLeft = Math.max(1000, T.deadline - Date.now());
  clearTimeout(turnTimer);
  broadcastBt();
}
function resumeBt() {
  if (!T.paused) return;
  T.paused = false;
  if (T.ph === 'playing') {
    T.deadline = Date.now() + T.pauseLeft;
    clearTimeout(turnTimer);
    turnTimer = setTimeout(onTurnTimeout, T.pauseLeft);
  }
  broadcastBt();
}

function doPlay(i, ids) {
  var s = i >= 0 ? T.seats[i] : null;
  if (T.ph !== 'playing' || T.turn !== i || !s || s.out) return '還沒輪到你';
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5) return '請選 1 到 5 張牌';
  var seen = {}, ok = true;
  ids.forEach(function (x) {
    if (typeof x !== 'number' || x !== Math.floor(x) || x < 0 || x > 51 || seen[x] || s.hand.indexOf(x) < 0) ok = false;
    seen[x] = 1;
  });
  if (!ok) return '出牌無效';
  var combo = classify(ids);
  if (!combo) return '這不是合法牌型';
  if (T.first && !seen[0]) return '第一手必須包含梅花 3';
  if (T.last && !beats(combo, T.last.combo)) return '打不過桌上的牌';
  s.hand = s.hand.filter(function (x) { return !seen[x]; });
  T.last = { seat: i, c: ids.slice().sort(function (a, b) { return a - b; }), combo: combo };
  T.passed = {};
  T.first = false;
  if (s.hand.length === 0) { endGame(i); return null; }
  advance();
  return null;
}
function doPass(i) {
  var s = i >= 0 ? T.seats[i] : null;
  if (T.ph !== 'playing' || T.turn !== i || !s || s.out) return '還沒輪到你';
  if (!T.last) return '你是領出，不能 pass';
  T.passed[i] = 1;
  advance();
  return null;
}
function onTurnTimeout() {
  if (T.ph !== 'playing') return;
  var i = T.turn, s = T.seats[i];
  if (!s || s.out) { advance(); broadcastBt(); return; }
  if (T.last) { T.m = s.nick + ' 超時，自動 pass'; doPass(i); }
  else { T.m = s.nick + ' 超時，自動出最小的一張'; doPlay(i, [s.hand[0]]); } // 領出不能 pass，改出最小的單張
  broadcastBt();
}

function joinTable(ws) {
  if (!ws.nick) return '請先設定暱稱';
  if (ws.seat >= 0) return null;
  if (ws.toi >= 0) return '先離開馬桶';
  if (T.ph === 'playing') return '牌局進行中，等下一局';
  if (T.ph === 'ended') return '結算中，稍後再加入';
  var i = T.seats.indexOf(null);
  if (i < 0) return '牌桌已滿（4 人）';
  T.seats[i] = { ws: ws, nick: ws.nick, ready: false, hand: [], out: false };
  ws.seat = i;
  resetReady();
  presenceOut(ws);
  return null;
}
function leaveTable(ws) {
  var i = ws.seat;
  if (i == null || i < 0) return;
  ws.seat = -1;
  var s = T.seats[i];
  if (T.ph === 'playing' && s) {
    // 中途離開或斷線：判定這個玩家輸，其他人照常繼續
    s.ws = null; s.out = true; s.ready = false;
    T.m = s.nick + ' 離開了牌局，其餘玩家繼續';
    var act = activeSeats();
    if (act.length === 0) { T.seats = [null, null, null, null]; resetLobby(); presenceOut(ws); return; }
    if (act.length === 1) endGame(act[0]);
    else if (T.turn === i) advance();
    else normalize();
  } else {
    T.seats[i] = null;
    resetReady();
  }
  presenceOut(ws);
  broadcastBt();
}
function onBt(ws, m) {
  T.m = '';
  var err = null;
  if (m.a === 'join') err = joinTable(ws);
  else if (m.a === 'leave') { leaveTable(ws); return; }
  else if (m.a === 'ready') {
    var s = ws.seat >= 0 ? T.seats[ws.seat] : null;
    if (!s || T.ph !== 'lobby') err = '現在不能準備';
    else if (T.seats.some(function (x) { return !x; })) err = '要滿 4 人才能準備';
    else {
      s.ready = !s.ready;
      if (T.seats.every(function (x) { return x.ready; })) startGame();
    }
  }
  else if (m.a === 'play') err = doPlay(ws.seat, m.c);
  else if (m.a === 'pass') err = doPass(ws.seat);
  else return;
  if (err) { sendTo(ws, { t: 'bt', err: err }); return; }
  broadcastBt();
}

// ───────── 老師、點名、黑板題目 ─────────
// 時間完全由現實時鐘算出（8 倍速）：一節課循環 = 現實 7 分 30 秒 = 遊戲 60 分鐘，伺服器重啟也不會亂。
//   0 秒        上課鐘響，老師已在講台前
//   2 秒起      點名：只點「此刻在這間教室內」的人，被叫到的人要在自己那幾秒內按「到」
//   點名結束後  老師寫第 1 題（黑板擦乾淨）
//   187.5 秒    （遊戲 25 分鐘）擦掉黑板，寫第 2 題
//   375 秒      （遊戲 50 分鐘）下課鐘響，老師離開；375～450 秒是下課
var CYCLE = 450000;
var CLASS_END = 375000;
var ROLL_AT = 2000;
var Q2_AT = 187500;
var WRITE_MS = 4000;
var TSPEED = 2.4; // 老師走路速度（公尺／秒）
var RZ = [[-7, 7], [7, 21], [21, 35]]; // 三間教室的 z 範圍（x 都是 -8～8）

var TEACHERS = [
  { n: '王老師', s: '數學', c: '#5b7db1' }, { n: '林老師', s: '英文', c: '#b06a4c' },
  { n: '陳老師', s: '自然', c: '#4f9170' }, { n: '黃老師', s: '國文', c: '#8c5fa8' },
  { n: '張老師', s: '社會', c: '#b38d3a' }
];
var BANKS = {};
try {
  var QM = require('./questions.js');
  if (QM && Array.isArray(QM.teachers) && QM.teachers.length >= 3) TEACHERS = QM.teachers;
  if (QM && QM.banks && typeof QM.banks === 'object') BANKS = QM.banks;
} catch (e) { console.log('questions.js 讀取失敗，使用內建名單：' + e.message); }
var NT = TEACHERS.length;

// ── 路線圖：辦公室 → 走廊 → 各教室前門 → 講台前 ──
var TN = {};
function addNode(id, x, z) { TN[id] = { x: x, z: z, e: [] }; }
function link(a, b) { TN[a].e.push(b); TN[b].e.push(a); }
var OSPOT = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
addNode('o1', -5.5, -10); addNode('o2', -2, -9.3); addNode('o3', 1.5, -10.5);
addNode('o4', 5, -9); addNode('o5', -5.5, -8); addNode('o6', 3, -8);
addNode('ov', -0.25, -11.4); addNode('oc', -0.25, -13.6); // oc：櫃子前，從兩張桌子中間的空隙走進去
addNode('oi', -6.5, -11); addNode('od', -8, -11); addNode('oo', -9.5, -11);
var OFFICE = OSPOT.concat(['ov', 'oc', 'oi']);
OFFICE.forEach(function (a) { OFFICE.forEach(function (b) { if (a !== 'oc' && b !== 'oc' && a < b) link(a, b); }); });
link('oc', 'ov'); link('oi', 'od'); link('od', 'oo');
var FD = [-4, 10, 24], ZN = [-7, 7, 21]; // 各教室前門的 z、黑板牆的 z
for (var ri = 0; ri < 3; ri++) {
  addNode('ro' + ri, -9.5, FD[ri]); addNode('rd' + ri, -8, FD[ri]); addNode('ri' + ri, -6.5, FD[ri]);
  addNode('rb' + ri, -2.5, ZN[ri] + 1.2);
  link('ro' + ri, 'rd' + ri); link('rd' + ri, 'ri' + ri); link('ri' + ri, 'rb' + ri);
  if (ri > 0) link('ro' + (ri - 1), 'ro' + ri);
}
link('oo', 'ro0');
addNode('to', -9.5, -18); addNode('td', -8, -18); addNode('ti', -6.5, -18); link('oo', 'to'); link('to', 'td'); link('td', 'ti');
addNode('ro3', -9.5, 38); link('ro2', 'ro3');

function ndist(a, b) { return Math.hypot(TN[a].x - TN[b].x, TN[a].z - TN[b].z); }
function plan(from, to) { // 最短路線，回傳「從 from 之後」要經過的節點
  var d = {}, prev = {}, done = {}, ids = Object.keys(TN), u;
  ids.forEach(function (k) { d[k] = Infinity; });
  d[from] = 0;
  for (;;) {
    u = null;
    ids.forEach(function (k) { if (!done[k] && d[k] < Infinity && (u === null || d[k] < d[u])) u = k; });
    if (u === null || u === to) break;
    done[u] = 1;
    TN[u].e.forEach(function (v) { var nd = d[u] + ndist(u, v); if (nd < d[v]) { d[v] = nd; prev[v] = u; } });
  }
  if (d[to] === Infinity) return [];
  var path = [], c = to;
  while (c !== from) { path.unshift(c); c = prev[c]; }
  return path;
}
function plen(from, to) { var L = 0, c = from; plan(from, to).forEach(function (n) { L += ndist(c, n); c = n; }); return L; }
// 要提前多久從辦公室出發，才能在上課鐘響時站在講台前
var LEAD = [0, 1, 2].map(function (i) {
  var m = 0; OSPOT.concat(['oc']).forEach(function (s) { m = Math.max(m, plen(s, 'rb' + i)); });
  return Math.ceil(m / TSPEED * 1000) + 6000;
});

var TCH = TEACHERS.map(function (d, i) {
  return { id: i, name: String(d.n), subj: String(d.s), color: /^#[0-9a-f]{6}$/i.test(d.c) ? d.c : '#888888',
    x: 0, z: 0, f: 0, at: 'oi', path: [], gw: null, wait: 0, st: 0, say: '', sayUntil: 0, writing: false, lastQ: -1 };
});
var lastArr = [];

// 第 n 節課，教室 i 由哪位老師上：(3n+i) mod 人數。5 位老師輪流，每節 3 位上課、2 位在辦公室
function dutyRoom(tid, n) { for (var i = 0; i < 3; i++) if ((3 * n + i) % NT === tid) return i; return -1; }
function wantGoal(t, now) {
  var n = Math.floor(now / CYCLE), ph = now % CYCLE, cur = dutyRoom(t.id, n), nxt = dutyRoom(t.id, n + 1);
  if (cur >= 0 && ph < CLASS_END) return 'rb' + cur;
  if (nxt >= 0 && ph >= CYCLE - LEAD[nxt]) return 'rb' + nxt;
  return 'office';
}
function placeTeachers(now) {
  TCH.forEach(function (t) {
    var g = wantGoal(t, now), id = g === 'office' ? OSPOT[Math.floor(Math.random() * OSPOT.length)] : g;
    t.gw = g; t.at = id; t.x = TN[id].x; t.z = TN[id].z; t.path = [];
    t.wait = 1000 + Math.random() * 4000;
    t.f = g === 'office' ? Math.random() * 6.28 - 3.14 : 0;
  });
}
function tSay(t, text, ms) { t.say = text; t.sayUntil = Date.now() + ms; }

function stepTeacher(t, dt, now) {
  var g = wantGoal(t, now);
  if (g !== t.gw) {
    t.gw = g;
    var head = t.path.length ? t.path[t.path.length - 1] : t.at;
    var dest = g === 'office' ? (OFFICE.indexOf(head) >= 0 ? null : 'oi') : g;
    if (dest) {
      var from = t.path.length ? t.path[0] : t.at;
      t.path = (t.path.length ? [from] : []).concat(plan(from, dest));
    }
  }
  if (!t.path.length && g === 'office' && OFFICE.indexOf(t.at) >= 0) { // 沒事：在辦公室隨意走動
    t.wait -= dt;
    if (t.wait <= 0) {
      var c = OSPOT.concat(['oc']).filter(function (x) { return x !== t.at; });
      t.path = plan(t.at, c[Math.floor(Math.random() * c.length)]);
      t.wait = 2500 + Math.random() * 6000;
    }
  }
  if (t.path.length) {
    var tg = TN[t.path[0]], dx = tg.x - t.x, dz = tg.z - t.z, d = Math.hypot(dx, dz), step = TSPEED * dt / 1000;
    if (d <= step) { t.x = tg.x; t.z = tg.z; t.at = t.path.shift(); }
    else { t.x += dx / d * step; t.z += dz / d * step; t.f = Math.atan2(dx, dz); }
    t.st = 1;
  } else {
    t.st = t.writing ? 2 : 0;
    if (t.at === 'oc') t.f = Math.PI;
    else if (/^rb/.test(t.at)) t.f = t.writing ? Math.PI : 0; // 寫黑板面向黑板，其餘時間面向學生
  }
}

// ── 每間教室的課堂進度：點名與出題 ──
var R = [0, 1, 2].map(function (i) { return { i: i, n: -1, st: 'wait', list: [], names: [], k: 0, slot: 0, callStart: 0, rollEnd: 0, j: -1, base: 0, q1: false, q2: false, endSaid: false }; });
var CURQ = [null, null, null], QSEQ = 0;

function inRoom(p, i) { return p.y < 2.5 && p.x >= -8 && p.x <= 8 && p.z >= RZ[i][0] && p.z <= RZ[i][1]; }
function sendAll(o) {
  var s = JSON.stringify(o);
  clients.forEach(function (c) { if (c.readyState === 1) c.send(s); });
}
function startRoll(r, T0, base) {
  var list = [];
  clients.forEach(function (c) { if (c.readyState === 1 && c.nick && c.presence && inRoom(c.presence, r.i)) list.push(c); });
  r.list = list; r.k = list.length; r.names = list.map(function (c) { return c.nick; }); r.base = base; r.j = -1;
  if (!r.k) { r.st = 'done'; r.rollEnd = ROLL_AT + 1000; return; }
  r.slot = Math.max(2500, Math.min(4000, 28000 / r.k)); // 每人 2.5～4 秒，人多時縮短（整段約 30 秒）
  r.callStart = ROLL_AT + 1500;
  r.rollEnd = r.callStart + r.k * r.slot + 800;
  r.st = 'call';
  tSay(T0, '現在開始點名', 1500);
  list.forEach(function (c, idx) { c.rr = r.i; c.hit = false; c.slotAt = 0; c.slotMs = 0; sendTo(c, { t: 'roll', a: 'start', r: r.i, k: r.k, i: idx + 1 }); });
  if (r.i === 0) pauseBt();
}
function callOne(r, T0, j) {
  var c = r.list[j];
  tSay(T0, r.names[j] + ' 同學', r.slot);
  if (c && c.readyState === 1 && c.rr === r.i) {
    c.slotAt = r.base + r.callStart + j * r.slot; c.slotMs = r.slot;
    sendTo(c, { t: 'roll', a: 'call', ms: r.slot });
  }
}
function endRoll(r, T0) {
  var pres = [];
  r.list.forEach(function (c, j) { if (c.hit) pres.push(r.names[j]); });
  r.list.forEach(function (c) {
    if (c.readyState === 1 && c.rr === r.i) sendTo(c, { t: 'roll', a: 'end', p: pres, k: r.k, me: c.hit ? 1 : 0 });
    if (c.rr === r.i) { c.rr = -1; c.hit = false; c.slotAt = 0; }
  });
  r.st = 'done';
  tSay(T0, '出席 ' + pres.length + ' 人', 3000);
  if (r.i === 0) resumeBt();
}
// 只有「被叫到的那幾秒」按才算（前 0.15 秒、後 0.7 秒是網路延遲的緩衝）
function onHere(ws) {
  var r = ws.rr >= 0 ? R[ws.rr] : null, now = Date.now();
  if (!r || r.st !== 'call' || ws.hit) return;
  if (!ws.slotAt || now < ws.slotAt - 150) { sendTo(ws, { t: 'roll', a: 'early' }); return; }
  if (now > ws.slotAt + ws.slotMs + 700) { sendTo(ws, { t: 'roll', a: 'late' }); return; }
  ws.hit = true;
  sendTo(ws, { t: 'roll', a: 'ok' });
}
function issueQ(r, tid, k) {
  var T0 = TCH[tid], bank = Array.isArray(BANKS[T0.subj]) ? BANKS[T0.subj] : [], idx = -1;
  if (bank.length) {
    idx = Math.floor(Math.random() * bank.length);
    if (bank.length > 1 && idx === T0.lastQ) idx = (idx + 1) % bank.length;
    T0.lastQ = idx;
  }
  var q = { id: ++QSEQ, r: r.i, k: k, subj: T0.subj, teacher: T0.name, p: (r.n % 9) + 1,
    text: idx >= 0 ? String(bank[idx]).slice(0, 120) : '（這一科的題庫是空的）' };
  CURQ[r.i] = q;
  boards[r.i] = null; // 換題：舊的黑板快照作廢，大家的畫面各自擦乾淨再寫上新題
  sendAll({ t: 'q', q: q });
}
function roomTick(r, n, ph) {
  var tid = (3 * n + r.i) % NT, T0 = TCH[tid];
  if (r.n !== n) {
    r.n = n; r.q1 = false; r.q2 = false; r.endSaid = false; r.list = []; r.k = 0; r.j = -1;
    if (ph < ROLL_AT + 6000) r.st = 'wait';
    else { r.st = 'done'; r.rollEnd = -WRITE_MS; r.endSaid = ph >= CLASS_END; } // 伺服器在課堂中途才啟動：跳過點名，直接出題
  }
  if (r.st === 'wait' && ph >= ROLL_AT) startRoll(r, T0, n * CYCLE);
  if (r.st === 'call') {
    var j = Math.floor((ph - r.callStart) / r.slot);
    if (ph >= r.callStart && j !== r.j && j < r.k) { r.j = j; callOne(r, T0, j); }
    if (ph >= r.rollEnd) endRoll(r, T0);
  }
  if (r.st === 'done' && ph < CLASS_END) {
    if (!r.q2 && ph >= Q2_AT) {
      if (ph >= Q2_AT + WRITE_MS) { issueQ(r, tid, 2); r.q1 = true; r.q2 = true; tSay(T0, '換下一題', 2500); }
      else T0.writing = true;
    } else if (!r.q1 && ph >= r.rollEnd) {
      if (ph >= r.rollEnd + WRITE_MS) { issueQ(r, tid, 1); r.q1 = true; tSay(T0, '大家來解這題', 2500); }
      else T0.writing = true;
    }
  }
  if (ph >= CLASS_END && !r.endSaid) {
    r.endSaid = true;
    if (r.st === 'call') endRoll(r, T0);
    tSay(T0, '下課', 3000);
  }
}

var lastTick = Date.now(), tickNo = 0, lastTj = '', lastTjAt = 0, bellS = -1, bellE = -1;
bellS = Math.floor(lastTick / CYCLE); bellE = (lastTick % CYCLE) >= CLASS_END ? bellS : bellS - 1;
function simTick() {
  var now = Date.now(), dt = Math.min(500, now - lastTick), n = Math.floor(now / CYCLE), ph = now % CYCLE;
  lastTick = now; tickNo++;
  TCH.forEach(function (t) { t.writing = false; });
  R.forEach(function (r) { roomTick(r, n, ph); });
  TCH.forEach(function (t) { stepTeacher(t, dt, now); });
  janStep(dt, now);
  if (bellS !== n) { bellS = n; sendAll({ t: 'bell', k: 'start', n: n }); }
  if (ph >= CLASS_END && bellE !== n) { bellE = n; sendAll({ t: 'bell', k: 'end', n: n }); }
  if (tickNo % 2) return; // 位置每 0.2 秒廣播一次，沒變化就不送（每 2 秒補送一次校時）
  lastArr = TCH.map(function (t) {
    var b = now < t.sayUntil ? t.say : (t.writing && !t.path.length ? '寫黑板中…' : '');
    return { x: Math.round(t.x * 100) / 100, z: Math.round(t.z * 100) / 100, f: Math.round(t.f * 100) / 100, s: t.st, b: b };
  });
  var js = JSON.stringify(lastArr);
  if (js !== lastTj || now - lastTjAt > 2000) { lastTj = js; lastTjAt = now; sendAll({ t: 'tch', now: now, ts: lastArr }); }
  var jm = JSON.stringify(janMsg());
  if (jm !== lastJm || now - lastJmAt > 2000) { lastJm = jm; lastJmAt = now; sendAll(JSON.parse(jm)); }
}

// ───────── 廁所與清潔工 ─────────
// 三個馬桶：坐上去按「大號」，起來後馬桶就是「沒沖水」，要有人互動沖水。
// 沒沖水超過 1 分鐘，清潔工跑去站在最後一個超時的人旁邊，直到那個馬桶被沖（任何人沖都算）；
// 若又有人超時，改去找比較晚的那一位。
var TO = [0, 1, 2].map(function () { return { o: null, p: 0, at: 0, by: null }; });
var JANV = 4.5, OVERDUE = 60000, lastJm = '', lastJmAt = 0;
function toiMsg() { return { t: 'toi', s: TO.map(function (x) { return { o: x.o ? x.o.id : null, p: x.p }; }) }; }
function toiAll() { sendAll(toiMsg()); }
function standToilet(ws) {
  var i = ws.toi;
  if (i == null || i < 0) return;
  ws.toi = -1;
  var x = TO[i];
  if (x.o === ws) { x.o = null; if (x.p) { x.at = Date.now(); x.by = ws; } }
  presenceOut(ws);
  toiAll();
}
function onToi(ws, m) {
  if (!ws.nick) return;
  var i = Math.floor(Number(m.i));
  if (m.a === 'sit') {
    if (!(i >= 0 && i < 3)) return;
    if (ws.toi >= 0 || ws.seat >= 0) { sendTo(ws, { t: 'toi', err: '現在不能坐馬桶' }); return; }
    var x = TO[i];
    if (x.o) { sendTo(ws, { t: 'toi', err: '有人在用' }); return; }
    if (x.p) { sendTo(ws, { t: 'toi', err: '要先沖水' }); return; }
    x.o = ws; ws.toi = i; presenceOut(ws); toiAll();
  } else if (m.a === 'poo') {
    if (ws.toi >= 0 && !TO[ws.toi].p) { TO[ws.toi].p = 1; toiAll(); }
  } else if (m.a === 'up') standToilet(ws);
  else if (m.a === 'flush') {
    if (!(i >= 0 && i < 3) || TO[i].o) return;
    TO[i].p = 0; TO[i].by = null;
    sendAll({ t: 'flush', i: i }); toiAll();
  }
}
var J = { x: -6.5, z: -18, f: 0, st: 0, at: 'ti', path: [], dest: 'ti', off: false, zone: '', say: '', sayUntil: 0, tgt: null, remind: 0 };
function janMsg() {
  return { t: 'jan', x: Math.round(J.x * 100) / 100, z: Math.round(J.z * 100) / 100, f: Math.round(J.f * 100) / 100, s: J.st, b: Date.now() < J.sayUntil ? J.say : '' };
}
function corrNode(z) {
  var b = 'ro0', bd = 1e9;
  ['to', 'oo', 'ro0', 'ro1', 'ro2', 'ro3'].forEach(function (k) { var d = Math.abs(TN[k].z - z); if (d < bd) { bd = d; b = k; } });
  return b;
}
// 目標所在的區域：能直線走過去的（走廊、廁所、辦公室、教室）給入口節點；其他地方只能走到最近的走廊節點
function zoneOf(p) {
  if (p.y > 2.6) return { k: 'x', e: 'ro3', free: false };
  if (p.x > -11 && p.x < -8) return { k: 'S', e: corrNode(p.z), free: true };
  if (p.x >= -8 && p.x <= 8) {
    if (p.z >= -21 && p.z < -15) return { k: 'ti', e: 'ti', free: true };
    if (p.z >= -15 && p.z < -7) return { k: 'oi', e: 'oi', free: true };
    for (var i = 0; i < 3; i++) if (p.z >= RZ[i][0] && p.z <= RZ[i][1]) return { k: 'ri' + i, e: 'ri' + i, free: true };
  }
  return { k: 'x', e: corrNode(p.z), free: false };
}
function pickTarget(now) {
  var b = null;
  TO.forEach(function (x) {
    if (x.p && !x.o && x.by && x.by.readyState === 1 && x.by.presence && now - x.at >= OVERDUE && (!b || x.at > b.at)) b = x;
  });
  return b;
}
function jmove(tx, tz, dt) {
  var dx = tx - J.x, dz = tz - J.z, d = Math.hypot(dx, dz), st = JANV * dt / 1000;
  if (d <= 0.001) return true;
  var s = Math.min(st, d);
  J.x += dx / d * s; J.z += dz / d * s; J.f = Math.atan2(dx, dz); J.st = 1;
  return false;
}
function janStep(dt, now) {
  J.st = 0;
  var tg = pickTarget(now), zn = null, dest = 'ti';
  if (tg) {
    zn = zoneOf(tg.by.presence); dest = zn.e;
    if (J.tgt !== tg.by) { J.tgt = tg.by; J.say = tg.by.nick + '，請沖水！'; J.sayUntil = now + 4000; J.remind = now + 8000; }
    else if (now > J.remind) { J.say = '請沖水！'; J.sayUntil = now + 2500; J.remind = now + 8000; }
  } else J.tgt = null;
  if (J.off) {
    if (tg && zn.free && zn.k === J.zone) {
      var pr = tg.by.presence, gx = pr.x - 1.1, gz = pr.z;
      if (Math.hypot(gx - J.x, gz - J.z) > 0.4) jmove(gx, gz, dt);
      else J.f = Math.atan2(pr.x - J.x, pr.z - J.z);
      return;
    }
    var n = TN[J.at];
    if (jmove(n.x, n.z, dt)) J.off = false;
    return;
  }
  if (J.at !== dest) {
    if (J.dest !== dest || !J.path.length) { J.dest = dest; J.path = plan(J.at, dest); }
    if (J.path.length) { var n2 = TN[J.path[0]]; if (jmove(n2.x, n2.z, dt)) J.at = J.path.shift(); }
    return;
  }
  if (tg && zn.free) { J.off = true; J.zone = zn.k; return; }
  if (!tg) J.f = 0;
}

// ───────── 連線 ─────────
function allow(ws) {
  var now = Date.now();
  if (now - ws.rlT >= 1000) { ws.rlT = now; ws.rl = 0; }
  return ++ws.rl <= MAX_MSG_PER_SEC;
}
function validStrokes(d) {
  if (!d || !Array.isArray(d.s) || d.s.length > 100) return null;
  var out = [];
  for (var i = 0; i < d.s.length; i++) {
    var g = d.s[i];
    if (!Array.isArray(g) || g.length !== 5) return null;
    var n = g.map(Number);
    if (!n.every(isFinite)) return null;
    out.push(n);
  }
  return { s: out };
}

wss.on('connection', function (ws) {
  if (clients.size >= MAX_CLIENTS) { ws.close(1013, 'full'); return; }
  ws.id = crypto.randomBytes(4).toString('hex');
  ws.nick = null; ws.presence = null; ws.seat = -1; ws.toi = -1; ws.rr = -1; ws.hit = false; ws.slotAt = 0; ws.slotMs = 0; ws.alive = true; ws.rl = 0; ws.rlT = Date.now();
  clients.add(ws);
  ws.on('pong', function () { ws.alive = true; });
  ws.on('error', function () {});

  var peers = [];
  clients.forEach(function (c) { if (c !== ws && c.nick && c.presence) peers.push({ peer: c.id, presence: pubPresence(c) }); });
  sendTo(ws, { t: 'hello', id: ws.id, peers: peers, boards: boards });
  sendTo(ws, btMsgFor(ws));
  sendTo(ws, { t: 'win', w: W });
  sendTo(ws, { t: 'tinfo', ts: TCH.map(function (t) { return { n: t.name, s: t.subj, c: t.color }; }) });
  sendTo(ws, { t: 'tch', now: Date.now(), ts: lastArr });
  sendTo(ws, { t: 'qs', qs: CURQ });
  sendTo(ws, toiMsg()); sendTo(ws, janMsg());

  ws.on('message', function (data) {
    ws.alive = true;
    if (!allow(ws)) return;
    var m;
    try { m = JSON.parse(data.toString()); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'nick') onNick(ws, m);
    else if (m.t === 'presence') {
      var p = cleanPresence(m.p);
      if (!p) return;
      ws.presence = p;
      presenceOut(ws);
    }
    else if (m.t === 'bt') onBt(ws, m); // 沒有暱稱的人會在 joinTable 被擋下
    else if (m.t === 'here') onHere(ws); // 點名：按「到」
    else if (m.t === 'toi') onToi(ws, m);
    else if (!ws.nick) return; // 沒有暱稱的人不能寫黑板
    else if (m.t === 'emit') {
      if (m.topic !== 'board') return;
      var d = validStrokes(m.data);
      if (d) { d.r = roomIdx(m.data.r); others(ws, { t: 'emit', topic: 'board', data: d, peer: ws.id }); }
    }
    else if (m.t === 'win') {
      var wi = Number(m.i);
      if (wi === Math.floor(wi) && wi >= 0 && wi < NWIN) {
        W[wi] = m.o ? 1 : 0;
        var ws2 = JSON.stringify({ t: 'win', w: W });
        clients.forEach(function (c) { if (c.readyState === 1) c.send(ws2); });
      }
    }
    else if (m.t === 'setboard') {
      var doc = m.doc;
      if (!doc || typeof doc.img !== 'string' || doc.img.indexOf('data:image/jpeg;base64,') !== 0 || doc.img.length > 300000) return;
      var br = roomIdx(doc.r);
      if (CURQ[br] && doc.q !== CURQ[br].id) return; // 換題之前的舊黑板快照，丟掉
      boards[br] = { img: doc.img, by: String(doc.by || '').slice(0, 16), at: Date.now(), q: CURQ[br] ? CURQ[br].id : 0 };
      others(ws, { t: 'board', doc: boards[br], r: br });
    }
  });

  ws.on('close', function () {
    leaveTable(ws); standToilet(ws);
    clients.delete(ws);
    if (ws.nick) others(ws, { t: 'leave', peer: ws.id });
  });
});

setInterval(function () {
  clients.forEach(function (ws) {
    if (!ws.alive) { ws.terminate(); return; }
    ws.alive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);

placeTeachers(Date.now());
setInterval(simTick, 100);
server.listen(PORT, function () { console.log('classroom server on :' + PORT); });

module.exports = { classify: classify, beats: beats };
