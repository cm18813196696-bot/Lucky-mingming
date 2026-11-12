// Hoops street: serves the game page, relays live player state between everyone who has it open,
// and referees real-person 1-on-1 matches (possession and score live here so both players see the same numbers).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 40;
const WIN_SCORE = 21;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.glb': 'model/gltf-binary' };

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
function sendTo(id, obj) { const c = clients.get(id); if (c && c.ws.readyState === 1) c.ws.send(JSON.stringify(obj)); }
function sendAll(obj) { const s = JSON.stringify(obj); for (const c of clients.values()) if (c.ws.readyState === 1) c.ws.send(s); }
function nameOf(id) { const c = clients.get(id); return String((c && c.state && c.state.name) || '球员').slice(0, 12); }

// ---------- 1-on-1 matches ----------
// One match per hoop. The player holding the ball (or who last released it) is the ball authority:
// their page simulates the ball and streams it; the server only accepts possession changes and
// baskets that are consistent with the current state, so the score cannot drift between players.
const matches = new Map();
const inMatch = new Map();
let mseq = 0;
const pub = M => ({ id: M.id, a: M.a, b: M.b, na: M.na, nb: M.nb, sa: M.sa, sb: M.sb, poss: M.poss, clear: M.clear, holder: M.holder, auth: M.auth, phase: M.phase, last: M.last, hoop: M.hoop, winner: M.winner, seq: M.seq });
function bump(M) { M.seq++; sendAll({ t: 'ms', m: pub(M) }); }
function freeHoop() { const used = new Set([...matches.values()].map(M => M.hoop)); for (const h of [1, 0]) if (!used.has(h)) return h; return -1; }
const other = (M, id) => (id === M.a ? M.b : M.a);
function newPoss(M, who, msg) {
  M.poss = who; M.holder = who; M.auth = who; M.clear = false; M.phase = 'check'; M.ball = null; M.last = msg;
  clearTimeout(M.timer); const s = M.seq + 1;
  M.timer = setTimeout(() => { if (matches.get(M.id) === M && M.phase === 'check' && M.seq === s) { M.phase = 'play'; bump(M); } }, 1500);
}
function later(M, ms, fn) { clearTimeout(M.timer); M.timer = setTimeout(() => { if (matches.get(M.id) === M) fn(); }, ms); }
function endMatch(M, msg) {
  clearTimeout(M.timer); matches.delete(M.id); inMatch.delete(M.a); inMatch.delete(M.b);
  sendAll({ t: 'mend', id: M.id, msg, winner: M.winner || null, sa: M.sa, sb: M.sb });
}
function switchTo(M, who, msg) { M.phase = 'score'; M.holder = null; bump(M); later(M, 1300, () => { newPoss(M, who, msg); bump(M); }); }

function handleMatch(id, m) {
  const M = matches.get(inMatch.get(id));
  if (m.op === 'invite') {
    if (M || typeof m.to !== 'string' || m.to === id || !clients.has(m.to)) return;
    if (inMatch.has(m.to)) return sendTo(id, { t: 'mx', msg: nameOf(m.to) + ' 正在比赛' });
    if (freeHoop() < 0) return sendTo(id, { t: 'mx', msg: '两个篮筐都有人在比赛，等一会儿' });
    const c = clients.get(id); c.invited = m.to; c.invT = Date.now();
    return sendTo(m.to, { t: 'minv', from: id, name: nameOf(id) });
  }
  if (m.op === 'accept') {
    const c = clients.get(m.from);
    if (M || !c || c.invited !== id || Date.now() - c.invT > 90000 || inMatch.has(m.from)) return sendTo(id, { t: 'mx', msg: '邀请已经失效了' });
    const h = freeHoop(); if (h < 0) return sendTo(id, { t: 'mx', msg: '两个篮筐都有人在比赛，等一会儿' });
    c.invited = null;
    const N = { id: 'm' + (++mseq), a: m.from, b: id, na: nameOf(m.from), nb: nameOf(id), sa: 0, sb: 0, hoop: h, seq: 0, winner: null, timer: null };
    matches.set(N.id, N); inMatch.set(N.a, N.id); inMatch.set(N.b, N.id);
    newPoss(N, N.a, '真人 1对1 开始！' + N.na + ' 先进攻，先到 ' + WIN_SCORE + ' 分赢');
    return bump(N);
  }
  if (m.op === 'decline') { const c = clients.get(m.from); if (c && c.invited === id) { c.invited = null; sendTo(m.from, { t: 'mx', msg: nameOf(id) + ' 拒绝了邀请' }); } return; }
  if (!M) return;
  const opp = other(M, id);
  switch (m.op) {
    case 'quit': M.winner = opp; return endMatch(M, nameOf(id) + ' 退出了比赛，' + nameOf(opp) + ' 获胜');
    case 'ball': {
      if (id !== M.auth || !m.s || typeof m.s !== 'object') return;
      const s = m.s; if (s.h !== null && s.h !== id) return;
      if (M.holder !== null && M.holder !== id) return;
      const was = M.holder; M.holder = s.h; M.ball = s;
      const out = JSON.stringify({ t: 'mb', id: M.id, s });
      for (const [cid, c] of clients) if (cid !== id && c.ws.readyState === 1) c.ws.send(out);
      if (was !== M.holder) { if (M.phase === 'check' && s.h === null) M.phase = 'play'; bump(M); }
      return;
    }
    case 'grab': {
      if (M.holder !== null || M.phase === 'score' || M.phase === 'over') return;
      M.holder = id; M.auth = id; M.ball = null; M.phase = 'play';
      if (M.poss !== id) { M.poss = id; M.clear = true; M.last = nameOf(id) + ' 抢到篮板，要先把球带出三分线'; }
      else M.last = nameOf(id) + ' 抢到前场篮板';
      return bump(M);
    }
    case 'steal': {
      if (M.holder !== opp || M.phase !== 'play') return;
      M.holder = id; M.auth = id; M.poss = id; M.clear = true; M.ball = null;
      M.last = nameOf(id) + ' 抢断成功！先清球再进攻';
      return bump(M);
    }
    case 'block': {
      if (M.holder !== null || !M.ball || M.ball.by !== opp || !(M.ball.pend > 0) || !m.s) return;
      M.auth = id; M.ball = Object.assign({}, m.s, { h: null, by: null, pend: 0 });
      M.last = nameOf(id) + ' 盖帽！';
      bump(M); return sendAll({ t: 'mb', id: M.id, s: M.ball });
    }
    case 'clear': if (id === M.poss && M.clear && M.holder === id) { M.clear = false; M.last = nameOf(id) + ' 清球完成，开始进攻'; bump(M); } return;
    case 'out': {
      if (id !== M.auth || M.holder !== null || M.phase !== 'play') return;
      const who = other(M, M.poss); M.last = '球出界了，球权给 ' + nameOf(who);
      return switchTo(M, who, '换 ' + nameOf(who) + ' 进攻');
    }
    case 'score': {
      if (id !== M.auth || id !== M.poss || M.holder !== null || !M.ball || M.ball.by !== id || !(M.ball.pend > 0) || M.phase !== 'play') return;
      const pts = M.ball.pend === 3 ? 3 : 2; M.ball.pend = 0;
      if (M.clear) { M.last = nameOf(id) + ' 没先清球，这球不算'; return switchTo(M, opp, '换 ' + nameOf(opp) + ' 进攻'); }
      if (id === M.a) M.sa += pts; else M.sb += pts;
      const mine = id === M.a ? M.sa : M.sb;
      M.last = nameOf(id) + (pts === 3 ? ' 三分命中 +3' : ' 进球 +2') + '（' + M.na + ' ' + M.sa + ' : ' + M.sb + ' ' + M.nb + '）';
      if (mine >= WIN_SCORE) {
        M.winner = id; M.phase = 'over'; M.holder = null;
        M.last = '🏆 ' + nameOf(id) + ' 赢了！' + M.na + ' ' + M.sa + ' : ' + M.sb + ' ' + M.nb;
        bump(M); return later(M, 6000, () => endMatch(M, M.last));
      }
      return switchTo(M, opp, '换 ' + nameOf(opp) + ' 进攻');
    }
  }
}

wss.on('connection', (ws) => {
  if (clients.size >= MAX_PLAYERS) { ws.close(1013, 'full'); return; }
  const id = 'p' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);
  const c = { ws, state: null, windowStart: Date.now(), count: 0, alive: true, invited: null, invT: 0 };
  const others = {};
  for (const [oid, o] of clients) if (o.state) others[oid] = o.state;
  clients.set(id, c);
  ws.send(JSON.stringify({ t: 'welcome', id, peers: others, matches: [...matches.values()].map(pub) }));

  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (buf) => {
    const now = Date.now();
    if (now - c.windowStart > 1000) { c.windowStart = now; c.count = 0; }
    if (++c.count > 80) return;                       // simple flood guard
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (m.t === 'm' && typeof m.op === 'string') { try { handleMatch(id, m); } catch (e) { console.error(e); } return; }
    if (m.t !== 'p' || !m.p || typeof m.p !== 'object') return;
    c.state = m.p;
    broadcast(id, JSON.stringify({ t: 'p', id, p: m.p }));
  });
  ws.on('close', () => {
    const M = matches.get(inMatch.get(id));
    if (M) { M.winner = other(M, id); endMatch(M, nameOf(id) + ' 掉线了，比赛结束'); }
    clients.delete(id); broadcast(id, JSON.stringify({ t: 'leave', id }));
  });
});

// keep connections alive behind proxies and drop dead ones
setInterval(() => {
  for (const c of clients.values()) {
    if (!c.alive) { c.ws.terminate(); continue; }
    c.alive = false; try { c.ws.ping(); } catch (e) {}
  }
}, 25000);

server.listen(PORT, () => console.log('hoops server listening on ' + PORT));
