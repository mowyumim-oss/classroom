'use strict';
// 教室 — HTTP + WebSocket 伺服器
// 功能：三間教室各自的黑板、窗戶狀態同步、位置同步（含高度）、黑板保存、暱稱（長度與重複檢查）、大老二（發牌與規則全在伺服器）
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
var NWIN = 10; // 窗戶總數：辦公室 1 + 三間教室各 3
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
  o.g = ws.seat >= 0 ? ws.seat : -1; // 大老二座位由伺服器決定，不接受玩家自填
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

var T = { ph: 'lobby', seats: [null, null, null, null], turn: -1, last: null, passed: {}, first: false, deadline: 0, res: null, m: '' };
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
    tl: T.ph === 'playing' ? Math.max(0, T.deadline - Date.now()) : 0,
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
  restartTimer();
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
  ws.nick = null; ws.presence = null; ws.seat = -1; ws.alive = true; ws.rl = 0; ws.rlT = Date.now();
  clients.add(ws);
  ws.on('pong', function () { ws.alive = true; });
  ws.on('error', function () {});

  var peers = [];
  clients.forEach(function (c) { if (c !== ws && c.nick && c.presence) peers.push({ peer: c.id, presence: pubPresence(c) }); });
  sendTo(ws, { t: 'hello', id: ws.id, peers: peers, boards: boards });
  sendTo(ws, btMsgFor(ws));
  sendTo(ws, { t: 'win', w: W });

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
      boards[br] = { img: doc.img, by: String(doc.by || '').slice(0, 16), at: Date.now() };
      others(ws, { t: 'board', doc: boards[br], r: br });
    }
  });

  ws.on('close', function () {
    leaveTable(ws);
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

server.listen(PORT, function () { console.log('classroom server on :' + PORT); });

module.exports = { classify: classify, beats: beats };
