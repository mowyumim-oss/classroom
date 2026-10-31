// 教室多人連線伺服器：提供網頁 + WebSocket 轉送
var http = require('http');
var fs = require('fs');
var path = require('path');
var WebSocket = require('ws');

var PORT = process.env.PORT || 3000;
var BOARD_FILE = path.join(__dirname, 'board.json');
var MAX_PLAYERS = 50;

var html = fs.readFileSync(path.join(__dirname, 'index.html'));
var board = null;
try { board = JSON.parse(fs.readFileSync(BOARD_FILE, 'utf8')); } catch (e) {}

var server = http.createServer(function (req, res) {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

var wss = new WebSocket.Server({ server: server, path: '/ws', maxPayload: 400000 });
var clients = {}; // id -> {ws, presence}
var count = 0;

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function others(id, obj) {
  for (var k in clients) if (k !== id) send(clients[k].ws, obj);
}

var saveTimer = null;
function saveBoard() {
  saveTimer = null;
  fs.writeFile(BOARD_FILE, JSON.stringify(board), function () {});
}

wss.on('connection', function (ws) {
  if (Object.keys(clients).length >= MAX_PLAYERS) { ws.close(); return; }
  count++;
  var id = 'p' + count + Math.random().toString(36).slice(2, 6);
  clients[id] = { ws: ws, presence: {} };

  var list = [];
  for (var k in clients) if (k !== id) list.push({ peer: k, presence: clients[k].presence });
  send(ws, { t: 'hello', id: id, peers: list, board: board });

  var stamp = 0, n = 0;
  ws.on('message', function (raw) {
    var now = Date.now();
    if (now - stamp > 1000) { stamp = now; n = 0; }
    if (++n > 60) return; // 每秒最多 60 則
    var m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'presence' && m.p && typeof m.p === 'object') {
      var s = JSON.stringify(m.p);
      if (s.length > 500) return;
      clients[id].presence = m.p;
      others(id, { t: 'presence', peer: id, presence: m.p });
    } else if (m.t === 'emit' && m.topic === 'board') {
      if (JSON.stringify(m.data || '').length > 8000) return;
      others(id, { t: 'emit', topic: 'board', peer: id, data: m.data });
    } else if (m.t === 'setboard' && m.doc) {
      var img = m.doc.img;
      if (typeof img !== 'string' || img.indexOf('data:image/jpeg;base64,') !== 0 || img.length > 250000) return;
      board = { img: img, by: String(m.doc.by || '').slice(0, 20), at: Date.now() };
      others(id, { t: 'board', doc: board });
      if (!saveTimer) saveTimer = setTimeout(saveBoard, 5000);
    }
  });

  ws.on('close', function () {
    delete clients[id];
    others(id, { t: 'leave', peer: id });
  });
  ws.on('error', function () {});
});

server.listen(PORT, function () { console.log('教室已啟動：port ' + PORT); });
