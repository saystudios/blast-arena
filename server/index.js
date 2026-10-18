/*
 * Ben Zone game server. No dependencies: `node server/index.js`.
 * Serves the game files and the multiplayer WebSocket at /ws on the same port.
 *
 * Environment:
 *   PORT             port to listen on (default 8080)
 *   DATA_DIR         folder for players/ratings/reports (default ./data)
 *   ALLOWED_ORIGINS  comma-separated origins allowed to connect (default: any). Set this in production,
 *                    e.g. "https://blast.saystudios.com,capacitor://localhost"
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { acceptUpgrade } = require('./ws.js');
const { Lobby } = require('./lobby.js');

const ROOT = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function createServer(opts) {
  opts = opts || {};
  const lobby = new Lobby({
    dataFile: opts.dataDir === null ? null : path.join(opts.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data'), 'db.json'),
    countdown: opts.countdown, queueWait: opts.queueWait, rematchWindow: opts.rematchWindow
  });
  const allowed = (opts.allowedOrigins || process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    if (url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(Object.assign({ ok: true }, lobby.stats())));
    }
    // Only the game itself is public: index.html and src/*.js. Never data/ or server/.
    let file = null;
    if (url === '/' || url === '/index.html') file = 'index.html';
    else if (/^\/src\/[a-z0-9-]+\.js$/i.test(url)) file = url.slice(1);
    if (!file) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
    fs.readFile(path.join(ROOT, file), (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': file === 'index.html' ? 'no-cache' : 'public, max-age=300', 'x-content-type-options': 'nosniff' });
      res.end(data);
    });
  });

  server.on('upgrade', (req, socket) => {
    const url = (req.url || '').split('?')[0];
    const origin = req.headers.origin || '';
    if (url !== '/ws' || (allowed.length && origin && !allowed.includes(origin))) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    const conn = acceptUpgrade(req, socket, { maxPayload: 16 * 1024 });
    if (conn) lobby.connect(conn, { ip: req.socket.remoteAddress });
  });

  return {
    server, lobby,
    listen(port) { return new Promise((resolve) => server.listen(port, () => resolve(server.address().port))); },
    close() {
      lobby.close();
      for (const sess of lobby.sessions.values()) sess.conn.close(1001, 'server closing');
      return new Promise((resolve) => { server.close(() => resolve()); if (server.closeAllConnections) server.closeAllConnections(); });
    }
  };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const app = createServer();
  app.listen(port).then((p) => console.log(`Ben Zone server on http://localhost:${p}  (WebSocket /ws)`));
  const stop = () => { app.lobby.save(); setTimeout(() => process.exit(0), 1800); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

module.exports = { createServer };
