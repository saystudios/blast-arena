/*
 * Lobby: player accounts, quick-match queues, private rooms, friends & invites, ratings,
 * match history, rematch voting, reconnection, reports & blocks, persistence.
 *
 * Privacy & safety by design: no emails, no passwords, no free-text names or chat.
 * Players get a generated kid-safe name and a random token stored on their device.
 */
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const C = require('../src/core.js');
const { Match, TICK } = require('./match.js');
const { ONLINE_MAPS, MAP_IDS } = require('./maps-node.js');

const ADJ = ['Swift', 'Brave', 'Turbo', 'Mighty', 'Rapid', 'Cosmic', 'Lucky', 'Sneaky', 'Atomic', 'Blazing', 'Frosty', 'Electric', 'Stormy', 'Rocket', 'Pixel', 'Thunder', 'Golden', 'Iron', 'Nitro', 'Hyper', 'Silver', 'Super', 'Ultra', 'Laser', 'Shadow', 'Neon', 'Solar', 'Mega'];
const NOUN = ['Falcon', 'Tiger', 'Comet', 'Panda', 'Rhino', 'Shark', 'Wolf', 'Fox', 'Hawk', 'Bolt', 'Dragon', 'Raptor', 'Yeti', 'Otter', 'Badger', 'Lynx', 'Eagle', 'Bear', 'Gecko', 'Moose', 'Orca', 'Cheetah', 'Jaguar', 'Penguin', 'Robot', 'Ninja', 'Knight', 'Pilot'];
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const QUICK_CHAT = ['Nice shot!', 'GG!', 'Follow me!', 'Help!', 'On my way!', 'Thanks!'];
const REPORT_REASONS = ['cheating', 'mean', 'name', 'other'];
const CAPACITY = { duel: 2, ffa: 6, team2: 4, team3: 6, team5: 10 };

const rand = (n) => crypto.randomInt(n);
const code = (len) => Array.from({ length: len }, () => CODE_CHARS[rand(CODE_CHARS.length)]).join('');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const genName = () => ADJ[rand(ADJ.length)] + NOUN[rand(NOUN.length)] + (10 + rand(90));

class Lobby {
  constructor(opts) {
    opts = opts || {};
    this.dataFile = opts.dataFile || null;
    this.countdown = opts.countdown == null ? 3 : opts.countdown;
    this.queueWait = opts.queueWait == null ? 20 : opts.queueWait;
    this.rematchWindow = opts.rematchWindow == null ? 20 : opts.rematchWindow;
    this.db = { players: {}, reports: [] };
    this.sessions = new Map();  // playerId -> session
    this.rooms = new Map();     // code -> room
    this.queues = {};           // mode -> [{ id, since }]
    for (const m of Object.keys(CAPACITY)) this.queues[m] = [];
    this.saveTimer = null;
    this.load();
    this.timer = setInterval(() => this.tick(), TICK * 1000);
    this.timer.unref && this.timer.unref();
    this.lastTick = Date.now();
  }

  // ---------------------------------------------------------------- persistence
  load() {
    if (!this.dataFile) return;
    try { this.db = Object.assign({ players: {}, reports: [] }, JSON.parse(fs.readFileSync(this.dataFile, 'utf8'))); }
    catch (e) { /* first run */ }
  }
  save() {
    if (!this.dataFile || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.dataFile), { recursive: true });
        const tmp = this.dataFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(this.db));
        fs.renameSync(tmp, this.dataFile);
      } catch (e) { console.error('save failed', e.message); }
    }, 1500);
  }
  close() { clearInterval(this.timer); if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; } }

  // ---------------------------------------------------------------- connections
  connect(conn, meta) {
    const sess = { conn, id: null, ip: meta && meta.ip, rate: 0, rateAt: Date.now(), rtt: 0.1, pingSent: 0 };
    conn.on('message', (raw) => this.onRaw(sess, raw));
    conn.on('close', () => this.onClose(sess));
    sess.helloTimer = setTimeout(() => { if (!sess.id) conn.close(4000, 'no hello'); }, 10000);
    sess.helloTimer.unref && sess.helloTimer.unref();
  }

  send(sess, msg) { if (sess && sess.conn.open) sess.conn.send(JSON.stringify(msg)); }
  sendTo(id, msg) { this.send(this.sessions.get(id), msg); }
  error(sess, msg) { this.send(sess, { t: 'error', msg }); }

  onRaw(sess, raw) {
    const t = Date.now();
    if (t - sess.rateAt > 1000) { sess.rateAt = t; sess.rate = 0; }
    if (++sess.rate > 90) { if (sess.rate > 300) sess.conn.close(4008, 'too many messages'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;
    try { this.handle(sess, msg); }
    catch (e) { console.error('handler error', msg.t, e); }
  }

  onClose(sess) {
    clearTimeout(sess.helloTimer);
    if (!sess.id || this.sessions.get(sess.id) !== sess) return;
    const id = sess.id;
    this.sessions.delete(id);
    this.unqueue(id);
    const room = this.roomOf(id);
    if (room) {
      if (room.match && room.state === 'playing') room.match.setConnected(id, false);
      else this.leaveRoom(id, true);
    }
    this.notifyFriends(id);
  }

  // ---------------------------------------------------------------- accounts
  player(id) { return this.db.players[id]; }
  publicProfile(p) { return { id: p.id, name: p.name, rating: p.rating, wins: p.wins, matches: p.matches }; }

  hello(sess, msg) {
    if (msg.v !== C.PROTOCOL) return this.error(sess, 'Please reload the game to update it.');
    let p = null;
    if (typeof msg.token === 'string' && msg.token.length >= 20) {
      p = Object.values(this.db.players).find((x) => x.tokenHash === hash(msg.token)) || null;
    }
    let token = msg.token;
    if (!p) {
      token = crypto.randomBytes(24).toString('base64url');
      const id = 'p' + crypto.randomBytes(6).toString('hex');
      let fc; do { fc = code(6); } while (Object.values(this.db.players).some((x) => x.friendCode === fc));
      p = { id, tokenHash: hash(token), name: genName(), friendCode: fc, rating: 1000, wins: 0, matches: 0, history: [], friends: [], requests: [], blocks: [], createdAt: Date.now() };
      this.db.players[id] = p;
    }
    const old = this.sessions.get(p.id);
    if (old && old !== sess) { this.send(old, { t: 'error', msg: 'Signed in on another device.' }); old.id = null; old.conn.close(4001, 'replaced'); }
    sess.id = p.id;
    this.sessions.set(p.id, sess);
    clearTimeout(sess.helloTimer);
    p.lastSeen = Date.now();
    if (msg.outfit && typeof msg.outfit === 'object') p.outfit = sanitizeOutfit(msg.outfit);
    if (Array.isArray(msg.loadout)) p.loadout = sanitizeLoadout(msg.loadout);
    if (msg.allowInvites != null) p.allowInvites = !!msg.allowInvites;
    this.save();
    this.send(sess, { t: 'welcome', id: p.id, token, name: p.name, friendCode: p.friendCode, rating: p.rating, wins: p.wins, matches: p.matches, quickChat: QUICK_CHAT, maps: ONLINE_MAPS });
    this.sendFriends(p.id);
    this.notifyFriends(p.id);
    // Reconnection: put them back where they were.
    const room = this.roomOf(p.id);
    if (room) {
      this.sendRoom(room);
      if (room.match && room.state === 'playing' && room.match.players.has(p.id)) {
        room.match.setConnected(p.id, true);
        this.send(sess, Object.assign(room.match.startMessage(p.id), { resume: true }));
      }
    }
  }

  // ---------------------------------------------------------------- message router
  handle(sess, msg) {
    if (msg.t === 'hello') return this.hello(sess, msg);
    if (msg.t === 'ping') { this.send(sess, { t: 'pong', c: msg.c }); if (fin(msg.rtt)) sess.rtt = Math.max(0, Math.min(1, msg.rtt / 1000)); return; }
    if (!sess.id) return;
    const id = sess.id, p = this.player(id);
    const room = this.roomOf(id);
    switch (msg.t) {
      case 'input': if (room && room.match) { const mp = room.match.players.get(id); if (mp) mp.rtt = sess.rtt; room.match.onInput(id, msg); } return;
      case 'fire': if (room && room.match) room.match.onFire(id, msg); return;
      case 'reload': if (room && room.match) room.match.onSwapReload(id, msg); return;
      case 'stuck': if (room && room.match) { const mp = room.match.players.get(id); if (mp && mp.alive) room.match.spawn(mp, false); } return;
      case 'chat': return this.chat(id, msg.i);
      case 'profile':
        if (msg.outfit) p.outfit = sanitizeOutfit(msg.outfit);
        if (Array.isArray(msg.loadout)) p.loadout = sanitizeLoadout(msg.loadout);
        if (msg.allowInvites != null) p.allowInvites = !!msg.allowInvites;
        this.save(); return;
      case 'rename':
        if (room && room.state === 'playing') return this.error(sess, 'You can change your name between matches.');
        p.name = genName(); this.save();
        this.send(sess, { t: 'name', name: p.name });
        if (room) this.sendRoom(room);
        return;
      case 'queue': return this.queue(id, msg.mode);
      case 'unqueue': this.unqueue(id); return this.send(sess, { t: 'queue', mode: null });
      case 'room_create': return this.createRoom(id, msg.mode, msg.map);
      case 'room_join': return this.joinRoom(id, typeof msg.code === 'string' ? msg.code.toUpperCase().trim() : '');
      case 'room_leave': this.leaveRoom(id, false); return this.send(sess, { t: 'room', room: null });
      case 'room_settings': return this.roomSettings(id, msg);
      case 'room_start': return this.startRoom(id);
      case 'vote': return this.vote(id, !!msg.yes);
      case 'friend_add': return this.friendAdd(id, msg.code);
      case 'friend_remove': return this.friendRemove(id, msg.id);
      case 'friend_accept': { const o = this.player(msg.id); if (o && p.requests.includes(o.id)) this.friendAdd(id, o.friendCode); return; }
      case 'invite': return this.invite(id, msg.id);
      case 'block': return this.block(id, msg.id);
      case 'unblock': p.blocks = p.blocks.filter((x) => x !== msg.id); this.save(); return this.sendFriends(id);
      case 'report': return this.report(id, msg.id, msg.reason);
      case 'leaderboard': return this.send(sess, { t: 'leaderboard', rows: this.leaderboard() });
      case 'history': return this.send(sess, { t: 'history', rows: p.history.slice(-15).reverse() });
      default: return;
    }
  }

  // ---------------------------------------------------------------- matchmaking
  queue(id, mode) {
    if (!CAPACITY[mode]) return;
    if (this.roomOf(id)) return this.error(this.sessions.get(id), 'Leave your room first.');
    this.unqueue(id);
    this.queues[mode].push({ id, since: Date.now() });
    this.sendQueueStatus(mode);
  }
  unqueue(id) {
    for (const m of Object.keys(this.queues)) {
      const q = this.queues[m];
      const i = q.findIndex((e) => e.id === id);
      if (i >= 0) { q.splice(i, 1); this.sendQueueStatus(m); }
    }
  }
  sendQueueStatus(mode) {
    const q = this.queues[mode];
    for (const e of q) this.sendTo(e.id, { t: 'queue', mode, count: q.length, needed: CAPACITY[mode], waited: Math.round((Date.now() - e.since) / 1000) });
  }
  blocked(a, b) {
    const pa = this.player(a), pb = this.player(b);
    return (pa && pa.blocks.includes(b)) || (pb && pb.blocks.includes(a));
  }
  formMatches() {
    for (const mode of Object.keys(this.queues)) {
      const q = this.queues[mode];
      q.splice(0, q.length, ...q.filter((e) => this.sessions.has(e.id)));
      if (q.length < 2) continue;
      const cap = CAPACITY[mode];
      const group = [];
      for (const e of q) {
        if (group.length >= cap) break;
        if (group.some((g) => this.blocked(g.id, e.id))) continue;
        group.push(e);
      }
      const oldest = Math.min(...group.map((e) => e.since));
      const waitedEnough = (Date.now() - oldest) / 1000 >= this.queueWait;
      const ready = group.length === cap || (mode !== 'duel' && waitedEnough && group.length >= 2) || (mode === 'duel' && group.length === 2);
      if (!ready) { if (Math.random() < 0.05) this.sendQueueStatus(mode); continue; }
      for (const e of group) q.splice(q.indexOf(e), 1);
      const map = ONLINE_MAPS[rand(ONLINE_MAPS.length)];
      const room = this.makeRoom(group[0].id, mode, map, false);
      for (const e of group.slice(1)) room.players.push(e.id);
      this.startMatch(room);
    }
  }

  // ---------------------------------------------------------------- rooms
  roomOf(id) {
    for (const r of this.rooms.values()) if (r.players.includes(id)) return r;
    return null;
  }
  makeRoom(hostId, mode, map, isPrivate) {
    let c; do { c = code(5); } while (this.rooms.has(c));
    const room = { code: c, private: isPrivate, hostId, mode, map, players: [hostId], state: 'lobby', match: null, votes: new Map(), voteDeadline: 0, ranked: !isPrivate };
    this.rooms.set(c, room);
    return room;
  }
  createRoom(id, mode, map) {
    if (!CAPACITY[mode]) mode = 'duel';
    if (!MAP_IDS.includes(map)) map = ONLINE_MAPS[0];
    this.unqueue(id);
    this.leaveRoom(id, false);
    const room = this.makeRoom(id, mode, map, true);
    this.sendRoom(room);
  }
  joinRoom(id, c) {
    const room = this.rooms.get(c);
    const sess = this.sessions.get(id);
    if (!room || !room.private) return this.error(sess, 'No room with that code. Check the letters and try again.');
    if (room.players.includes(id)) return this.sendRoom(room);
    if (room.state !== 'lobby') return this.error(sess, 'That match already started. Try again when it ends.');
    if (room.players.length >= CAPACITY[room.mode]) return this.error(sess, 'That room is full.');
    if (room.players.some((pid) => this.blocked(pid, id))) return this.error(sess, 'You can’t join that room.');
    this.unqueue(id);
    this.leaveRoom(id, false);
    room.players.push(id);
    this.sendRoom(room);
    this.notifyFriends(id);
  }
  leaveRoom(id, disconnected) {
    const room = this.roomOf(id);
    if (!room) return;
    room.players = room.players.filter((x) => x !== id);
    room.votes.delete(id);
    if (room.match) room.match.removePlayer(id);
    if (!room.players.length) { this.rooms.delete(room.code); return; }
    if (room.hostId === id) room.hostId = room.players[0];
    this.sendRoom(room);
    if (!disconnected) this.notifyFriends(id);
  }
  roomSettings(id, msg) {
    const room = this.roomOf(id);
    if (!room || room.hostId !== id || room.state !== 'lobby') return;
    if (CAPACITY[msg.mode] && room.players.length <= CAPACITY[msg.mode]) room.mode = msg.mode;
    if (MAP_IDS.includes(msg.map)) room.map = msg.map;
    this.sendRoom(room);
  }
  sendRoom(room) {
    const msg = {
      t: 'room', room: {
        code: room.code, private: room.private, host: room.hostId, mode: room.mode, map: room.map, state: room.state, capacity: CAPACITY[room.mode],
        players: room.players.map((pid) => { const p = this.player(pid); return { id: pid, name: p.name, online: this.sessions.has(pid), outfit: p.outfit || null }; }),
        votes: [...room.votes.entries()].filter(([, v]) => v).map(([k]) => k), voteEnds: room.voteDeadline ? Math.max(0, Math.round((room.voteDeadline - Date.now()) / 1000)) : 0
      }
    };
    for (const pid of room.players) this.sendTo(pid, msg);
  }
  startRoom(id) {
    const room = this.roomOf(id);
    const sess = this.sessions.get(id);
    if (!room || room.hostId !== id) return;
    if (room.state !== 'lobby') return;
    const online = room.players.filter((pid) => this.sessions.has(pid));
    if (online.length < 2) return this.error(sess, 'You need at least 2 players to start. Share the room code with a friend.');
    room.players = online;
    this.startMatch(room);
  }
  startMatch(room) {
    room.state = 'playing';
    room.votes.clear(); room.voteDeadline = 0;
    // Quick-match teams are shuffled; private rooms keep join order (host picks friends' sides by order).
    const ids = room.private ? room.players.slice() : room.players.slice().sort(() => Math.random() - 0.5);
    room.match = new Match({
      mode: room.mode, map: room.map, ranked: room.ranked, countdown: this.countdown,
      players: ids.map((pid) => { const p = this.player(pid); return { id: pid, name: p.name, outfit: p.outfit || null, loadout: p.loadout || ['laser', 'scatter'] }; }),
      send: (pid, msg) => this.sendTo(pid, msg),
      onEnd: (results) => this.matchEnded(room, results)
    });
    room.match.onCheat = (pid) => { const s = this.sessions.get(pid); this.error(s, 'Removed from the match for impossible movement.'); this.leaveRoom(pid, false); if (s) this.send(s, { t: 'room', room: null }); };
    for (const pid of room.players) this.sendTo(pid, room.match.startMessage(pid));
    this.sendRoom(room);
  }
  matchEnded(room, results) {
    const changes = room.ranked ? this.rate(results) : {};
    const when = Date.now();
    for (const row of results.rows) {
      const p = this.player(row.id); if (!p) continue;
      const won = results.winnerTeam ? row.team === results.winnerTeam : results.winnerId === row.id;
      const draw = results.winnerTeam === null && results.winnerId === null;
      p.matches++; if (won) p.wins++;
      p.history.push({ when, mode: results.mode, map: results.map, result: won ? 'win' : draw ? 'draw' : 'loss', kills: row.kills, deaths: row.deaths, rating: changes[row.id] || 0, ranked: !!results.ranked });
      if (p.history.length > 50) p.history.splice(0, p.history.length - 50);
    }
    this.save();
    room.match = null;
    room.state = 'results';
    room.voteDeadline = Date.now() + this.rematchWindow * 1000;
    for (const pid of room.players) {
      const p = this.player(pid);
      this.sendTo(pid, { t: 'match_end', results, ratingChange: changes[pid] || 0, rating: p.rating, voteSeconds: this.rematchWindow });
    }
    this.sendRoom(room);
  }
  vote(id, yes) {
    const room = this.roomOf(id);
    if (!room || room.state !== 'results') return;
    room.votes.set(id, yes);
    const online = room.players.filter((pid) => this.sessions.has(pid));
    const yesCount = online.filter((pid) => room.votes.get(pid)).length;
    this.sendRoom(room);
    if (online.length >= 2 && yesCount === online.length) { room.players = online; this.startMatch(room); }
  }
  checkVotes() {
    const t = Date.now();
    for (const room of [...this.rooms.values()]) {
      if (room.state !== 'results' || t < room.voteDeadline) continue;
      const online = room.players.filter((pid) => this.sessions.has(pid));
      const yes = online.filter((pid) => room.votes.get(pid));
      if (!room.private && yes.length >= 2 && yes.length > online.length / 2) {
        // Majority wants a rematch: keep the yes voters, everyone else goes back to the lobby.
        for (const pid of online) if (!room.votes.get(pid)) { room.players = room.players.filter((x) => x !== pid); this.sendTo(pid, { t: 'room', room: null }); }
        room.players = yes;
        this.startMatch(room);
      } else if (room.private) {
        room.state = 'lobby'; room.votes.clear(); room.voteDeadline = 0;
        room.players = online;
        if (!room.players.includes(room.hostId) && room.players.length) room.hostId = room.players[0];
        if (!room.players.length) this.rooms.delete(room.code); else this.sendRoom(room);
      } else {
        for (const pid of room.players) this.sendTo(pid, { t: 'room', room: null });
        this.rooms.delete(room.code);
      }
    }
  }

  // ---------------------------------------------------------------- ratings
  rate(results) {
    const K = 24, ch = {};
    const rating = (id) => (this.player(id) ? this.player(id).rating : 1000);
    const expect = (a, b) => 1 / (1 + Math.pow(10, (b - a) / 400));
    if (results.teamScores) {
      const teams = { blue: results.rows.filter((r) => r.team === 'blue'), orange: results.rows.filter((r) => r.team === 'orange') };
      const avg = (rows) => rows.reduce((s, r) => s + rating(r.id), 0) / Math.max(1, rows.length);
      for (const t of ['blue', 'orange']) {
        const other = t === 'blue' ? 'orange' : 'blue';
        const score = results.winnerTeam === null ? 0.5 : results.winnerTeam === t ? 1 : 0;
        const e = expect(avg(teams[t]), avg(teams[other]));
        for (const r of teams[t]) ch[r.id] = Math.round(K * (score - e));
      }
    } else {
      const rows = results.rows; // already ordered best first
      for (let i = 0; i < rows.length; i++) {
        let delta = 0;
        for (let j = 0; j < rows.length; j++) {
          if (i === j) continue;
          const tie = rows[i].kills === rows[j].kills && rows[i].deaths === rows[j].deaths;
          const score = tie ? 0.5 : i < j ? 1 : 0;
          delta += K * (score - expect(rating(rows[i].id), rating(rows[j].id)));
        }
        ch[rows[i].id] = Math.round(delta / Math.max(1, rows.length - 1));
      }
    }
    for (const [id, d] of Object.entries(ch)) { const p = this.player(id); if (p) p.rating = Math.max(100, p.rating + d); }
    return ch;
  }
  leaderboard() {
    return Object.values(this.db.players).filter((p) => p.matches > 0)
      .sort((a, b) => b.rating - a.rating).slice(0, 20)
      .map((p, i) => ({ rank: i + 1, name: p.name, rating: p.rating, wins: p.wins, matches: p.matches }));
  }

  // ---------------------------------------------------------------- friends & safety
  friendAdd(id, fc) {
    const me = this.player(id);
    const sess = this.sessions.get(id);
    const other = Object.values(this.db.players).find((p) => p.friendCode === String(fc || '').toUpperCase().trim());
    if (!other || other.id === id) return this.error(sess, 'No player with that friend code.');
    if (this.blocked(id, other.id)) return this.error(sess, 'You can’t add that player.');
    if (me.friends.includes(other.id)) return this.sendFriends(id);
    if (me.requests.includes(other.id)) {
      // They asked first: now you're friends.
      me.requests = me.requests.filter((x) => x !== other.id);
      me.friends.push(other.id); other.friends.push(id);
      other.requests = other.requests.filter((x) => x !== id);
    } else if (!other.requests.includes(id)) {
      other.requests.push(id);
      this.send(sess, { t: 'notice', msg: `Friend request sent to ${other.name}. You’ll be friends when they add you back.` });
    }
    this.save();
    this.sendFriends(id); this.sendFriends(other.id);
  }
  friendRemove(id, otherId) {
    const me = this.player(id), other = this.player(otherId);
    me.friends = me.friends.filter((x) => x !== otherId);
    me.requests = me.requests.filter((x) => x !== otherId);
    if (other) other.friends = other.friends.filter((x) => x !== id);
    this.save();
    this.sendFriends(id); if (other) this.sendFriends(otherId);
  }
  sendFriends(id) {
    const me = this.player(id); if (!me) return;
    const row = (fid) => {
      const f = this.player(fid); if (!f) return null;
      const room = this.roomOf(fid);
      return { id: fid, name: f.name, online: this.sessions.has(fid), status: room ? (room.state === 'playing' ? 'In a match' : 'In a room') : this.sessions.has(fid) ? 'Online' : 'Offline' };
    };
    this.sendTo(id, {
      t: 'friends', friends: me.friends.map(row).filter(Boolean), requests: me.requests.map(row).filter(Boolean),
      blocked: me.blocks.map((b) => ({ id: b, name: this.player(b) ? this.player(b).name : 'Player' }))
    });
  }
  notifyFriends(id) {
    const me = this.player(id); if (!me) return;
    for (const f of me.friends) if (this.sessions.has(f)) this.sendFriends(f);
  }
  invite(id, toId) {
    const me = this.player(id), to = this.player(toId);
    const sess = this.sessions.get(id);
    const room = this.roomOf(id);
    if (!to || !me.friends.includes(toId)) return this.error(sess, 'You can only invite friends.');
    if (!room || !room.private) return this.error(sess, 'Create a private room first, then invite friends.');
    if (!this.sessions.has(toId)) return this.error(sess, `${to.name} is offline.`);
    if (to.allowInvites === false || this.blocked(id, toId)) return this.send(sess, { t: 'notice', msg: `${to.name} isn’t taking invites right now.` });
    this.sendTo(toId, { t: 'invite', from: me.name, code: room.code, mode: room.mode, map: room.map });
    this.send(sess, { t: 'notice', msg: `Invite sent to ${to.name}.` });
  }
  block(id, otherId) {
    const me = this.player(id), other = this.player(otherId);
    if (!other || otherId === id) return;
    if (!me.blocks.includes(otherId)) me.blocks.push(otherId);
    me.friends = me.friends.filter((x) => x !== otherId);
    me.requests = me.requests.filter((x) => x !== otherId);
    other.friends = other.friends.filter((x) => x !== id);
    other.requests = other.requests.filter((x) => x !== id);
    this.save();
    this.sendFriends(id); this.sendFriends(otherId);
    this.sendTo(id, { t: 'notice', msg: `${other.name} is blocked. You won’t be matched or get invites from them.` });
  }
  report(id, otherId, reason) {
    const other = this.player(otherId);
    if (!other || otherId === id || !REPORT_REASONS.includes(reason)) return;
    const recent = this.db.reports.filter((r) => r.from === id && Date.now() - r.at < 60000).length;
    if (recent >= 5) return;
    const room = this.roomOf(id);
    this.db.reports.push({ at: Date.now(), from: id, about: otherId, aboutName: other.name, reason, room: room ? room.code : null });
    if (this.db.reports.length > 5000) this.db.reports.splice(0, this.db.reports.length - 5000);
    this.save();
    this.sendTo(id, { t: 'notice', msg: 'Thanks. Your report was sent to the Ben Zone team.' });
  }
  chat(id, i) {
    if (!Number.isInteger(i) || i < 0 || i >= QUICK_CHAT.length) return;
    const room = this.roomOf(id); if (!room) return;
    const t = Date.now(), sess = this.sessions.get(id);
    if (sess.lastChat && t - sess.lastChat < 1500) return;
    sess.lastChat = t;
    for (const pid of room.players) if (!this.blocked(pid, id)) this.sendTo(pid, { t: 'chat', id, name: this.player(id).name, i });
  }

  // ---------------------------------------------------------------- main loop
  tick() {
    const t = Date.now();
    const dt = Math.min(0.2, (t - this.lastTick) / 1000);
    this.lastTick = t;
    for (const room of this.rooms.values()) if (room.match) room.match.tick(dt);
    if (!this._slow || t - this._slow > 1000) {
      this._slow = t;
      this.formMatches();
      this.checkVotes();
      for (const [pid, sess] of this.sessions) {
        if (t - sess.conn.lastSeen > 45000) { sess.conn.close(4002, 'timeout'); continue; }
        sess.conn.ping();
        void pid;
      }
    }
  }

  stats() { return { players: this.sessions.size, rooms: this.rooms.size, matches: [...this.rooms.values()].filter((r) => r.match).length }; }
}

function fin(v) { return typeof v === 'number' && Number.isFinite(v); }
function sanitizeOutfit(o) {
  const n = (v, max) => (Number.isInteger(v) && v >= 0 && v < max ? v : 0);
  const hairs = ['spiky', 'buzz', 'mohawk', 'cap', 'helmet', 'beanie'], accs = ['none', 'goggles', 'headphones', 'jetpack', 'bandana'];
  return { skin: n(o.skin, 6), hair: hairs.includes(o.hair) ? o.hair : 'spiky', hairColor: n(o.hairColor, 6), shirt: n(o.shirt, 9), pants: n(o.pants, 6), acc: accs.includes(o.acc) ? o.acc : 'none' };
}
function sanitizeLoadout(l) {
  const ids = l.filter((w) => C.WEAPONS[w]).slice(0, 2);
  if (ids.length < 2 || ids[0] === ids[1]) return ['laser', 'scatter'];
  return ids;
}

module.exports = { Lobby, QUICK_CHAT, CAPACITY };
