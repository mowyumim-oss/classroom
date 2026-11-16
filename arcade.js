'use strict';
// 二樓圖書館電腦：多人連線遊戲（開房間 → 加入 → 房主開始 → 遊戲 → 結算給金幣）
// 遊戲規則、計分、金幣全部由伺服器決定；前端只負責畫面與送出操作。
// 想調整金幣：改 RANKC（多人名次）與各遊戲的 soloGain。每天的上限在 tconfig.js 的 pcDailyCap。
var crypto = require('crypto');

var GAMES = {
  snake: { n: '貪食蛇大亂鬥', e: '🐍', min: 1, max: 4, d: '吃蘋果變長；撞到牆、自己或別人就出局。最後活著的人獲勝' },
  quiz: { n: '速算王', e: '🧮', min: 1, max: 4, d: '10 題心算，越快答對分數越高（答錯要等 1.5 秒）' },
  c4: { n: '四子棋', e: '🔴', min: 2, max: 2, d: '輪流投下棋子，先連成一直線 4 顆的人獲勝' },
  mem: { n: '記憶翻牌', e: '🃏', min: 1, max: 4, d: '翻兩張一樣的就得分，配對成功可以再翻一次' }
};
var RANKC = [6, 4, 2, 1];   // 多人遊戲：第 1～4 名的金幣
var MIN_MULTI_MS = 20000;   // 多人即時遊戲至少要玩 20 秒才給金幣（避免開局就結束刷幣）

function ri(a, b) { return a + crypto.randomInt(b - a + 1); }
function shuffle(a) { for (var i = a.length - 1; i > 0; i--) { var j = crypto.randomInt(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
function rankBy(seats, key) { // 依 key(seat) 由大到小排名，同分同名次
  var idx = seats.map(function (s, i) { return i; }).sort(function (a, b) { return key(seats[b]) - key(seats[a]); });
  var rk = [];
  idx.forEach(function (i, k) { rk[i] = (k > 0 && key(seats[idx[k - 1]]) === key(seats[i])) ? rk[idx[k - 1]] : k; });
  return rk;
}

// ───────── 貪食蛇 ─────────
var SW = 28, SH = 20, STICK = 125, SDUR = 90000;
var SST = [[4, 3, 1], [23, 16, 3], [23, 3, 2], [4, 16, 0]]; // x, y, 方向（0 上 1 右 2 下 3 左）
var DX = [0, 1, 0, -1], DY = [-1, 0, 1, 0];
var SNAKE = {
  init: function (gm, now) {
    gm.s.forEach(function (s, i) {
      var q = SST[i], b = [];
      for (var k = 0; k < 4; k++) b.push([q[0] - DX[q[2]] * k, q[1] - DY[q[2]] * k]);
      s.b = b; s.d = q[2]; s.nd = q[2]; s.al = true; s.sc = 0; s.dt = 0;
    });
    gm.ap = []; gm.t0 = now + 3000; gm.next = gm.t0; gm.end = gm.t0 + SDUR;
    SNAKE.fill(gm);
  },
  occ: function (gm) { var o = {}; gm.s.forEach(function (s) { if (s.al) s.b.forEach(function (c) { o[c[1] * SW + c[0]] = 1; }); }); gm.ap.forEach(function (c) { o[c[1] * SW + c[0]] = 2; }); return o; },
  fill: function (gm) {
    var want = 2 + gm.s.length, o = SNAKE.occ(gm), tries = 0;
    while (gm.ap.length < want && tries++ < 400) { var x = ri(1, SW - 2), y = ri(1, SH - 2); if (!o[y * SW + x]) { gm.ap.push([x, y]); o[y * SW + x] = 2; } }
  },
  step: function (gm, now) {
    var al = gm.s.filter(function (s) { return s.al; }), heads = [];
    al.forEach(function (s) {
      if ((s.nd + 2) % 4 !== s.d) s.d = s.nd;
      s.nh = [s.b[0][0] + DX[s.d], s.b[0][1] + DY[s.d]];
      s.eat = -1;
      for (var k = 0; k < gm.ap.length; k++) if (gm.ap[k][0] === s.nh[0] && gm.ap[k][1] === s.nh[1]) { s.eat = k; break; }
      if (s.eat < 0) s.b.pop();
      heads.push(s.nh[1] * SW + s.nh[0]);
    });
    var o = {};
    al.forEach(function (s) { s.b.forEach(function (c) { o[c[1] * SW + c[0]] = 1; }); });
    var eaten = {};
    al.forEach(function (s, i) {
      var h = s.nh, hk = h[1] * SW + h[0], dead = h[0] < 0 || h[1] < 0 || h[0] >= SW || h[1] >= SH || o[hk];
      for (var j = 0; j < heads.length; j++) if (j !== i && heads[j] === hk) dead = true;
      if (dead) { s.dead = true; return; }
      s.b.unshift(h);
      if (s.eat >= 0) { s.sc++; eaten[s.eat] = 1; }
    });
    gm.ap = gm.ap.filter(function (c, k) { return !eaten[k]; });
    al.forEach(function (s) {
      if (!s.dead) return;
      s.dead = false; s.al = false; s.dt = now;
      s.b.forEach(function (c, k) { if (k % 2 === 0 && gm.ap.length < 40 && c[0] >= 0 && c[1] >= 0 && c[0] < SW && c[1] < SH) gm.ap.push([c[0], c[1]]); });
      s.b = [];
    });
    SNAKE.fill(gm);
  },
  tick: function (gm, now) {
    if (now < gm.t0) return gm.cdSent !== Math.ceil((gm.t0 - now) / 1000) ? (gm.cdSent = Math.ceil((gm.t0 - now) / 1000), true) : false;
    var ch = false, n = 0;
    while (now >= gm.next && n++ < 3) { SNAKE.step(gm, now); gm.next += STICK; ch = true; }
    var alive = gm.s.filter(function (s) { return s.al; }).length;
    if ((gm.s.length >= 2 && alive <= 1) || alive === 0 || now >= gm.end) gm.done = true;
    return ch;
  },
  input: function (gm, i, m) { var d = Math.floor(Number(m.d)); if (d >= 0 && d < 4 && gm.s[i].al) gm.s[i].nd = d; },
  state: function (gm, now) {
    return { k: 'snake', W: SW, H: SH, cd: Math.max(0, gm.t0 - now), tl: Math.max(0, gm.end - Math.max(now, gm.t0)),
      sn: gm.s.map(function (s) { var f = []; s.b.forEach(function (c) { f.push(c[1] * SW + c[0]); }); return { n: s.nick, b: f, a: s.al ? 1 : 0, sc: s.sc, d: s.d, o: s.out ? 1 : 0 }; }),
      ap: gm.ap.map(function (c) { return c[1] * SW + c[0]; }) };
  },
  results: function (gm, now) {
    var rk = rankBy(gm.s, function (s) { return (s.out ? -1e9 : 0) + (s.al ? 1e6 : 0) + s.sc * 1000 + (s.al ? 0 : Math.floor((s.dt - gm.t0) / 1000)); });
    var long = now - gm.t0 >= MIN_MULTI_MS;
    return gm.s.map(function (s, i) {
      var g = s.out ? 0 : gm.s.length === 1 ? Math.min(5, Math.floor(s.sc / 3)) : (long ? RANKC[rk[i]] : 0);
      return { n: s.nick, sc: s.sc + ' 顆', rk: rk[i], g: g };
    });
  }
};

// ───────── 速算王 ─────────
function mkQ(r) {
  var a, b, c;
  if (r < 3) { a = ri(12, 99); b = ri(12, 99); if (crypto.randomInt(2)) return { q: a + ' + ' + b, a: a + b }; if (a < b) { c = a; a = b; b = c; } return { q: a + ' − ' + b, a: a - b }; }
  if (r < 6) { a = ri(3, 19); b = ri(3, 12); return { q: a + ' × ' + b, a: a * b }; }
  if (r < 8) { b = ri(3, 12); c = ri(3, 15); return { q: (b * c) + ' ÷ ' + b, a: c }; }
  a = ri(2, 12); b = ri(2, 9); c = ri(5, 40);
  return crypto.randomInt(2) ? { q: a + ' × ' + b + ' + ' + c, a: a * b + c } : { q: '(' + a + ' + ' + c + ') × ' + b, a: (a + c) * b };
}
var QN = 10, QMS = 12000, QRV = 2200;
var QUIZ = {
  init: function (gm, now) {
    gm.s.forEach(function (s) { s.sc = 0; s.ok = false; s.lock = 0; s.nc = 0; s.pts = 0; });
    gm.r = -1; gm.ph = 'cd'; gm.until = now + 3000; gm.q = ''; gm.ans = 0; gm.cnt = 0;
  },
  next: function (gm, now) {
    gm.r++; var q = mkQ(gm.r); gm.q = q.q; gm.ans = q.a; gm.ph = 'q'; gm.until = now + QMS; gm.cnt = 0;
    gm.s.forEach(function (s) { s.ok = false; s.lock = 0; s.pts = 0; });
  },
  tick: function (gm, now) {
    if (gm.ph === 'cd' && now >= gm.until) { QUIZ.next(gm, now); return true; }
    if (gm.ph === 'q') {
      var act = gm.s.filter(function (s) { return !s.out; });
      if (now >= gm.until || (act.length && act.every(function (s) { return s.ok; }))) { gm.ph = 'rv'; gm.until = now + QRV; return true; }
    }
    if (gm.ph === 'rv' && now >= gm.until) { if (gm.r >= QN - 1) gm.done = true; else QUIZ.next(gm, now); return true; }
    var sec = Math.ceil((gm.until - now) / 1000);
    if (sec !== gm.sec) { gm.sec = sec; return true; }
    return false;
  },
  input: function (gm, i, m, now) {
    var s = gm.s[i];
    if (gm.ph !== 'q' || s.ok || now < s.lock) return false;
    var v = Number(m.v);
    if (!isFinite(v)) return false;
    if (v === gm.ans) { s.ok = true; s.pts = [3, 2, 1, 1][gm.cnt] || 1; gm.cnt++; s.sc += s.pts; s.nc++; }
    else s.lock = now + 1500;
    return true;
  },
  state: function (gm, now) {
    return { k: 'quiz', r: gm.r, n: QN, q: gm.q, ph: gm.ph, tl: Math.max(0, gm.until - now), ans: gm.ph === 'rv' ? gm.ans : null,
      sc: gm.s.map(function (s) { return s.sc; }), ok: gm.s.map(function (s) { return s.ok ? s.pts : 0; }), lk: gm.s.map(function (s) { return s.lock > now ? Math.ceil((s.lock - now) / 100) : 0; }),
      nm: gm.s.map(function (s) { return s.nick; }), o: gm.s.map(function (s) { return s.out ? 1 : 0; }) };
  },
  results: function (gm) {
    var rk = rankBy(gm.s, function (s) { return (s.out ? -1e9 : 0) + s.sc; });
    return gm.s.map(function (s, i) {
      var g = s.out ? 0 : gm.s.length === 1 ? Math.min(5, Math.floor(s.nc / 2)) : (s.sc > 0 ? RANKC[rk[i]] : 0);
      return { n: s.nick, sc: s.sc + ' 分（答對 ' + s.nc + ' 題）', rk: rk[i], g: g };
    });
  }
};

// ───────── 四子棋 ─────────
var CW = 7, CH = 6, CTURN = 20000;
function c4win(b, p) {
  var D = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (var y = 0; y < CH; y++) for (var x = 0; x < CW; x++) {
    if (b[y * CW + x] !== p) continue;
    for (var d = 0; d < 4; d++) {
      var line = [y * CW + x], ok = true;
      for (var k = 1; k < 4; k++) { var xx = x + D[d][0] * k, yy = y + D[d][1] * k; if (xx < 0 || yy < 0 || xx >= CW || yy >= CH || b[yy * CW + xx] !== p) { ok = false; break; } line.push(yy * CW + xx); }
      if (ok) return line;
    }
  }
  return null;
}
var C4 = {
  init: function (gm, now) { gm.b = []; for (var i = 0; i < CW * CH; i++) gm.b.push(-1); gm.turn = crypto.randomInt(2); gm.until = now + CTURN; gm.win = -1; gm.line = null; gm.moves = 0; gm.last = -1; gm.s.forEach(function (s) { s.sc = 0; }); },
  drop: function (gm, i, c, now) {
    if (!(c >= 0 && c < CW)) return false;
    for (var y = CH - 1; y >= 0; y--) if (gm.b[y * CW + c] < 0) {
      gm.b[y * CW + c] = i; gm.moves++; gm.last = y * CW + c;
      var ln = c4win(gm.b, i);
      if (ln) { gm.win = i; gm.line = ln; gm.done = true; }
      else if (gm.moves >= CW * CH) { gm.win = -2; gm.done = true; }
      else { gm.turn = 1 - i; gm.until = now + CTURN; }
      return true;
    }
    return false;
  },
  tick: function (gm, now) {
    var o = gm.s.findIndex(function (s) { return s.out; });
    if (o >= 0) { gm.win = 1 - o; gm.done = true; return true; }
    if (now >= gm.until) { var cols = []; for (var c = 0; c < CW; c++) if (gm.b[c] < 0) cols.push(c); C4.drop(gm, gm.turn, cols[crypto.randomInt(cols.length)], now); return true; }
    var sec = Math.ceil((gm.until - now) / 1000); if (sec !== gm.sec) { gm.sec = sec; return true; }
    return false;
  },
  input: function (gm, i, m, now) { if (gm.done || i !== gm.turn) return false; return C4.drop(gm, i, Math.floor(Number(m.c)), now); },
  state: function (gm, now) { return { k: 'c4', W: CW, H: CH, b: gm.b, turn: gm.turn, tl: Math.max(0, gm.until - now), win: gm.win, line: gm.line, last: gm.last, nm: gm.s.map(function (s) { return s.nick; }) }; },
  results: function (gm) {
    var ok = gm.moves >= 7;
    return gm.s.map(function (s, i) {
      var draw = gm.win === -2, w = gm.win === i;
      return { n: s.nick, sc: draw ? '平手' : (w ? '獲勝' : '落敗'), rk: draw ? 0 : (w ? 0 : 1), g: s.out || !ok ? 0 : (draw ? 3 : (w ? 6 : 1)) };
    });
  }
};

// ───────── 記憶翻牌 ─────────
var MTURN = 15000;
var MEM = {
  init: function (gm, now) {
    var c = []; for (var i = 0; i < 8; i++) c.push(i, i);
    gm.cards = shuffle(c); gm.own = gm.cards.map(function () { return -1; }); gm.up = []; gm.turn = 0; gm.until = now + MTURN; gm.hideAt = 0;
    gm.s.forEach(function (s) { s.sc = 0; s.mv = 0; });
  },
  nextTurn: function (gm, now) {
    var n = gm.s.length;
    for (var k = 1; k <= n; k++) { var j = (gm.turn + k) % n; if (!gm.s[j].out) { gm.turn = j; break; } }
    gm.until = now + MTURN;
  },
  tick: function (gm, now) {
    if (gm.s.every(function (s) { return s.out; })) { gm.done = true; return true; }
    if (gm.hideAt && now >= gm.hideAt) { gm.up = []; gm.hideAt = 0; MEM.nextTurn(gm, now); return true; }
    if (!gm.hideAt && (now >= gm.until || gm.s[gm.turn].out)) { gm.up = []; MEM.nextTurn(gm, now); return true; }
    var sec = Math.ceil((gm.until - now) / 1000); if (sec !== gm.sec) { gm.sec = sec; return true; }
    return false;
  },
  input: function (gm, i, m, now) {
    if (gm.done || i !== gm.turn || gm.hideAt) return false;
    var k = Math.floor(Number(m.k));
    if (!(k >= 0 && k < 16) || gm.own[k] >= 0 || gm.up.indexOf(k) >= 0) return false;
    gm.up.push(k);
    if (gm.up.length === 2) {
      var a = gm.up[0], b = gm.up[1]; gm.s[i].mv++;
      if (gm.cards[a] === gm.cards[b]) {
        gm.own[a] = gm.own[b] = i; gm.s[i].sc++; gm.up = []; gm.until = now + MTURN;
        if (gm.own.every(function (x) { return x >= 0; })) gm.done = true;
      } else gm.hideAt = now + 1100;
    }
    return true;
  },
  state: function (gm, now) {
    return { k: 'mem', face: gm.cards.map(function (c, k) { return gm.own[k] >= 0 || gm.up.indexOf(k) >= 0 ? c : -1; }), own: gm.own, turn: gm.turn,
      tl: gm.hideAt ? 0 : Math.max(0, gm.until - now), sc: gm.s.map(function (s) { return s.sc; }), mv: gm.s.map(function (s) { return s.mv; }),
      nm: gm.s.map(function (s) { return s.nick; }), o: gm.s.map(function (s) { return s.out ? 1 : 0; }) };
  },
  results: function (gm) {
    var rk = rankBy(gm.s, function (s) { return (s.out ? -1e9 : 0) + s.sc; });
    return gm.s.map(function (s, i) {
      var g;
      if (s.out) g = 0;
      else if (gm.s.length === 1) g = !gm.own.every(function (x) { return x >= 0; }) ? 0 : s.mv <= 12 ? 5 : s.mv <= 16 ? 4 : s.mv <= 22 ? 3 : 2;
      else g = s.sc > 0 ? RANKC[rk[i]] : 0;
      return { n: s.nick, sc: s.sc + ' 對（翻了 ' + s.mv + ' 次）', rk: rk[i], g: g };
    });
  }
};

var IMPL = { snake: SNAKE, quiz: QUIZ, c4: C4, mem: MEM };

module.exports = function (api) {
  // api: sendTo(ws, o)、clients（Set）、atPc(ws) → 是否坐在電腦前、award(ws, n) → Promise<實際拿到的金幣>、changed(ws) → 重送這個玩家的狀態給別人
  var rooms = [], seq = 0;
  function pubRoom(r) { return { id: r.id, g: r.g, ph: r.ph, host: r.pl[0] ? r.pl[0].nick : '', n: r.pl.length, max: GAMES[r.g].max, min: GAMES[r.g].min, pl: r.pl.map(function (w) { return w.nick; }) }; }
  function lobbyMsg() { return { t: 'ar', a: 'lobby', rooms: rooms.map(pubRoom), games: GAMES }; }
  function lobbyAll() { var m = lobbyMsg(); api.clients.forEach(function (c) { if (c.pcOn && !c.ar) api.sendTo(c, m); }); }
  function roomSend(r) { r.pl.forEach(function (w, i) { api.sendTo(w, { t: 'ar', a: 'rm', rm: pubRoom(r), me: i }); }); }
  function gsSend(r, now) {
    var st = IMPL[r.g].state(r.gm, now);
    r.gm.s.forEach(function (s, i) { if (s.ws && !s.out) api.sendTo(s.ws, { t: 'ar', a: 'gs', s: st, me: i }); });
  }
  function err(ws, t) { api.sendTo(ws, { t: 'ar', a: 'err', r: t }); }
  function seatOf(r, ws) { if (!r.gm) return -1; for (var i = 0; i < r.gm.s.length; i++) if (r.gm.s[i].ws === ws) return i; return -1; }

  function leave(ws) {
    var r = ws.ar;
    if (!r) return;
    ws.ar = null;
    r.pl = r.pl.filter(function (w) { return w !== ws; });
    var si = seatOf(r, ws);
    if (si >= 0) { r.gm.s[si].out = true; r.gm.s[si].ws = null; }
    if (!r.pl.length) { rooms = rooms.filter(function (x) { return x !== r; }); }
    else roomSend(r);
    if (ws.pcOn) api.sendTo(ws, lobbyMsg());
    lobbyAll(); api.changed(ws);
  }
  function finish(r, now) {
    var res = IMPL[r.g].results(r.gm, now), seats = r.gm.s;
    r.ph = 'end'; r.endAt = now + 7000;
    Promise.all(seats.map(function (s, i) { return s.ws && !s.out && res[i].g > 0 ? api.award(s.ws, res[i].g) : Promise.resolve(0); })).then(function (got) {
      res.forEach(function (x, i) { x.got = got[i] | 0; });
      seats.forEach(function (s, i) { if (s.ws && !s.out) api.sendTo(s.ws, { t: 'ar', a: 'end', g: r.g, res: res, me: i, last: IMPL[r.g].state(r.gm, now) }); });
    });
    roomSend(r); lobbyAll();
    seats.forEach(function (s) { if (s.ws) api.changed(s.ws); });
  }

  function onMsg(ws, m) {
    var now = Date.now(), r = ws.ar;
    if (m.a === 'hi') { // 坐到電腦前
      if (!ws.nick) { err(ws, 'nick'); return; }
      if (!api.atPc(ws)) { err(ws, 'far'); return; }
      ws.pcOn = true; api.sendTo(ws, lobbyMsg());
      if (r) roomSend(r);
      return;
    }
    if (m.a === 'bye') { leave(ws); ws.pcOn = false; return; }
    if (!ws.pcOn) { err(ws, 'far'); return; }
    if (m.a === 'new') {
      if (r) { err(ws, 'inroom'); return; }
      if (!Object.prototype.hasOwnProperty.call(GAMES, m.g)) return;
      if (rooms.length >= 20) { err(ws, 'full'); return; }
      r = { id: ++seq, g: m.g, ph: 'wait', pl: [ws], gm: null, endAt: 0 };
      rooms.push(r); ws.ar = r; roomSend(r); lobbyAll();
    } else if (m.a === 'join') {
      if (r) { err(ws, 'inroom'); return; }
      var id = Math.floor(Number(m.id)), t = rooms.filter(function (x) { return x.id === id; })[0];
      if (!t) { err(ws, 'gone'); api.sendTo(ws, lobbyMsg()); return; }
      if (t.ph !== 'wait') { err(ws, 'playing'); return; }
      if (t.pl.length >= GAMES[t.g].max) { err(ws, 'roomfull'); return; }
      t.pl.push(ws); ws.ar = t; roomSend(t); lobbyAll();
    } else if (m.a === 'leave') leave(ws);
    else if (m.a === 'start') {
      if (!r || r.ph !== 'wait') return;
      if (r.pl[0] !== ws) { err(ws, 'host'); return; }
      if (r.pl.length < GAMES[r.g].min) { err(ws, 'min'); return; }
      r.gm = { s: r.pl.map(function (w) { return { ws: w, nick: w.nick, out: false }; }) };
      IMPL[r.g].init(r.gm, now);
      r.ph = 'play'; roomSend(r); gsSend(r, now); lobbyAll();
      r.pl.forEach(function (w) { api.changed(w); });
    } else if (m.a === 'in') {
      if (!r || r.ph !== 'play') return;
      var si = seatOf(r, ws);
      if (si < 0) return;
      if (IMPL[r.g].input(r.gm, si, m, now) !== false && r.g !== 'snake') {
        if (r.gm.done) finish(r, now); else gsSend(r, now);
      }
    }
  }
  var lastChk = 0;
  function tick(now) {
    rooms.slice().forEach(function (r) {
      if (r.ph === 'play') {
        var ch = IMPL[r.g].tick(r.gm, now);
        if (r.gm.done) { gsSend(r, now); finish(r, now); }
        else if (ch) gsSend(r, now);
      } else if (r.ph === 'end' && now >= r.endAt) { r.ph = 'wait'; r.gm = null; roomSend(r); lobbyAll(); }
    });
    if (now - lastChk > 1000) { // 離開電腦座位的人自動退出
      lastChk = now;
      api.clients.forEach(function (c) { if (c.pcOn && !api.atPc(c)) { leave(c); c.pcOn = false; api.sendTo(c, { t: 'ar', a: 'bye' }); } });
    }
  }
  function busy(ws) { return ws.ar && ws.ar.ph === 'play' ? ws.ar.g : ''; }
  return { onMsg: onMsg, tick: tick, leave: function (ws) { leave(ws); ws.pcOn = false; }, busy: busy, GAMES: GAMES };
};
module.exports.GAMES = GAMES;
module.exports._impl = IMPL;
