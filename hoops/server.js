// Hoops street: serves the game page and relays live player state between everyone who has it open.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 40;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (p === '/') p = '/index.html';
  const file = path.join(PUBLIC, path.normalize(p));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
const clients = new Map();
let seq = 0;

function broadcast(fromId, text) {
  for (const [id, c] of clients) if (id !== fromId && c.ws.readyState === 1) c.ws.send(text);
}

wss.on('connection', (ws) => {
  if (clients.size >= MAX_PLAYERS) { ws.close(1013, 'full'); return; }
  const id = 'p' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
  const c = { ws, state: null, windowStart: Date.now(), count: 0, alive: true };
  const others = {};
  for (const [oid, o] of clients) if (o.state) others[oid] = o.state;
  clients.set(id, c);
  ws.send(JSON.stringify({ t: 'welcome', id, peers: others }));

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (buf) => {
    const now = Date.now();
    if (now - c.windowStart > 1000) { c.windowStart = now; c.count = 0; }
    if (++c.count > 40) return;                       // simple flood guard
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (m.t !== 'p' || !m.p || typeof m.p !== 'object') return;
    c.state = m.p;
    broadcast(id, JSON.stringify({ t: 'p', id, p: m.p }));
  });
  ws.on('close', () => { clients.delete(id); broadcast(id, JSON.stringify({ t: 'leave', id })); });
});

// keep connections alive behind proxies and drop dead ones
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; try { c.ws.ping(); } catch (e) {}
  }
}, 25000);

server.listen(PORT, () => console.log('hoops server listening on ' + PORT));
