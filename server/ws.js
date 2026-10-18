/*
 * Minimal WebSocket server (RFC 6455) using only Node's built-ins.
 * Supports text frames, fragmentation, ping/pong, close, and a payload size cap.
 */
'use strict';
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WSConn extends EventEmitter {
  constructor(socket, opts) {
    super();
    this.socket = socket;
    this.maxPayload = opts.maxPayload || 16 * 1024;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.open = true;
    this.lastSeen = Date.now();
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('end', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _onData(chunk) {
    this.lastSeen = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (this.open) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2), lo = b.readUInt32BE(6);
        if (hi !== 0) return this.close(1009, 'too big');
        len = lo; off = 10;
      }
      if (len > this.maxPayload) return this.close(1009, 'too big');
      const maskLen = masked ? 4 : 0;
      if (b.length < off + maskLen + len) return;
      let payload = b.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = b.subarray(off, off + 4);
        const out = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      }
      this.buf = b.subarray(off + maskLen + len);
      this._frame(fin, opcode, payload);
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode === 0x8) { this.close(1000); return; }
    if (opcode === 0x9) { this._write(0xA, payload); return; }
    if (opcode === 0xA) return;
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) { this.emit('message', payload.toString('utf8')); return; }
      this.fragments = [payload];
      return;
    }
    if (opcode === 0x0 && this.fragments) {
      this.fragments.push(payload);
      const total = this.fragments.reduce((s, x) => s + x.length, 0);
      if (total > this.maxPayload) { this.close(1009, 'too big'); return; }
      if (fin) { const msg = Buffer.concat(this.fragments).toString('utf8'); this.fragments = null; this.emit('message', msg); }
    }
  }

  _write(opcode, payload) {
    if (!this.open) return;
    const len = payload.length;
    let header;
    if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
    else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
    try { this.socket.write(Buffer.concat([header, payload])); } catch (e) { this._closed(); }
  }

  send(text) { this._write(0x1, Buffer.from(text, 'utf8')); }
  ping() { this._write(0x9, Buffer.alloc(0)); }

  close(code, reason) {
    if (!this.open) return;
    const r = Buffer.from(reason || '', 'utf8');
    const p = Buffer.alloc(2 + r.length); p.writeUInt16BE(code || 1000, 0); r.copy(p, 2);
    this._write(0x8, p);
    this.open = false;
    try { this.socket.end(); } catch (e) { /* ignore */ }
    setTimeout(() => { try { this.socket.destroy(); } catch (e) { /* ignore */ } }, 1000).unref();
    this.emit('close');
  }

  _closed() {
    if (!this.open) return;
    this.open = false;
    try { this.socket.destroy(); } catch (e) { /* ignore */ }
    this.emit('close');
  }
}

/** Completes the HTTP upgrade handshake. Returns a WSConn, or null if the request isn't a valid WebSocket upgrade. */
function acceptUpgrade(req, socket, opts) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  return new WSConn(socket, opts || {});
}

module.exports = { acceptUpgrade, WSConn };
