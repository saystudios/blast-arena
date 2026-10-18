// Multiplayer server integration test: real WebSockets against a real server instance.
// Run: node tests/server.test.js   (Node 22+, no dependencies)
'use strict';
const assert = require('assert');
const C = require('../src/core.js');
const { createServer } = require('../server/index.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; console.error('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n    ') : e)); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const c = { ws, msgs: [], closed: false };
    c.send = (m) => ws.send(JSON.stringify(m));
    c.mark = () => c.msgs.length;
    // Flatten snapshot events into the message list as { t: 'ev', ...event } so tests can wait on them.
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      c.msgs.push(m);
      if (m.ev) for (const ev of m.ev) c.msgs.push(Object.assign({ t: 'ev' }, ev));
    };
    c.wait = async (pred, from = 0, timeout = 4000) => {
      const t0 = Date.now();
      for (;;) {
        for (let i = from; i < c.msgs.length; i++) if (pred(c.msgs[i])) return c.msgs[i];
        if (Date.now() - t0 > timeout) throw new Error('timed out waiting; last: ' + JSON.stringify(c.msgs.slice(-3)).slice(0, 300));
        await sleep(20);
      }
    };
    c.count = (pred, from = 0) => c.msgs.slice(from).filter(pred).length;
    c.close = () => { c.closed = true; ws.close(); };
    ws.onopen = () => resolve(c);
    ws.onerror = (e) => reject(e);
  });
}
async function login(port, extra) {
  const c = await client(port);
  c.send(Object.assign({ t: 'hello', v: C.PROTOCOL }, extra || {}));
  c.me = await c.wait((m) => m.t === 'welcome');
  return c;
}
const dirTo = (a, b) => { const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }; const l = Math.hypot(d.x, d.y, d.z); return [d.x / l, d.y / l, d.z / l]; };

(async () => {
  console.log('Ben Zone server tests');
  const app = createServer({ dataDir: null, countdown: 0.2, queueWait: 1, rematchWindow: 1.5 });
  const port = await app.listen(0);
  const L = app.lobby;

  await test('serves the game but not server files or data', async () => {
    const ok = await fetch(`http://localhost:${port}/`); assert.strictEqual(ok.status, 200); assert.ok((await ok.text()).includes('Ben Zone'));
    assert.strictEqual((await fetch(`http://localhost:${port}/src/core.js`)).status, 200);
    assert.strictEqual((await fetch(`http://localhost:${port}/server/lobby.js`)).status, 404);
    assert.strictEqual((await fetch(`http://localhost:${port}/data/db.json`)).status, 404);
    const h = await (await fetch(`http://localhost:${port}/health`)).json(); assert.strictEqual(h.ok, true);
  });

  const A = await login(port, { loadout: ['laser', 'rocket'] });
  const B = await login(port);

  await test('new players get a generated kid-safe name, friend code and token', async () => {
    assert.ok(/^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/.test(A.me.name), A.me.name);
    assert.strictEqual(A.me.friendCode.length, 6);
    assert.ok(A.me.token.length >= 20);
    assert.strictEqual(A.me.rating, 1000);
  });

  await test('old client version is told to update', async () => {
    const X = await client(port); X.send({ t: 'hello', v: 0 });
    const e = await X.wait((m) => m.t === 'error'); assert.ok(/reload/i.test(e.msg)); X.close();
  });

  let room;
  await test('private room: create, join by code, both see the room', async () => {
    A.send({ t: 'room_create', mode: 'duel', map: 'yard' });
    room = (await A.wait((m) => m.t === 'room' && m.room)).room;
    assert.strictEqual(room.code.length, 5);
    const mk = B.mark();
    B.send({ t: 'room_join', code: room.code.toLowerCase() });
    const r = await B.wait((m) => m.t === 'room' && m.room && m.room.players.length === 2, mk);
    assert.strictEqual(r.room.host, A.me.id);
  });

  await test('wrong room code gives a clear error', async () => {
    const mk = B.mark();
    const X = await login(port); X.send({ t: 'room_join', code: 'ZZZZZ' });
    const e = await X.wait((m) => m.t === 'error'); assert.ok(/no room/i.test(e.msg)); X.close();
    void mk;
  });

  await test('only the host can start; match starts for both with teams/spawns', async () => {
    const mk = B.mark();
    B.send({ t: 'room_start' });
    await sleep(200);
    assert.strictEqual(B.count((m) => m.t === 'match_start', mk), 0);
    A.send({ t: 'room_start' });
    const sa = await A.wait((m) => m.t === 'match_start');
    const sb = await B.wait((m) => m.t === 'match_start', mk);
    assert.strictEqual(sa.players.length, 2); assert.strictEqual(sa.map, 'yard');
    assert.strictEqual(sb.you, B.me.id);
  });

  const match = () => L.roomOf(A.me.id).match;
  const place = (id, x, y, z) => { const p = match().players.get(id); p.pos = { x, y, z }; p.hist = []; p.anchor = { x, y, z }; p.ignoreUntil = 0; p.shieldT = 0; return p; };

  await test('snapshots stream at ~20 Hz with both players', async () => {
    const mk = A.mark();
    await sleep(600);
    const snaps = A.msgs.slice(mk).filter((m) => m.t === 'snap');
    assert.ok(snaps.length >= 9 && snaps.length <= 15, 'snapshots: ' + snaps.length);
    assert.strictEqual(snaps[snaps.length - 1].s.length, 2);
    assert.strictEqual(snaps[snaps.length - 1].st, 'play');
    assert.strictEqual(typeof snaps[snaps.length - 1].now, 'number', 'snapshot carries the server clock');
    assert.ok(snaps[snaps.length - 1].now > snaps[0].now);
  });

  await test('movement: normal steps accepted, teleport snapped back', async () => {
    await sleep(900); // past spawn grace
    const p = match().players.get(A.me.id);
    const start = { ...p.pos };
    A.send({ t: 'input', p: [start.x + 0.25, start.y, start.z], yaw: 0, pitch: 0 });
    await sleep(80);
    assert.ok(Math.abs(match().players.get(A.me.id).pos.x - (start.x + 0.25)) < 1e-6, 'small step accepted');
    const mk = A.mark();
    A.send({ t: 'input', p: [start.x + 30, start.y, start.z], yaw: 0, pitch: 0 });
    const c = await A.wait((m) => m.t === 'ev' && m.k === 'correct', mk);
    assert.strictEqual(c.why, 'speed');
  });

  await test('movement into a wall is refused', async () => {
    await sleep(500);
    place(A.me.id, 0, 0, 5.5); // just south of the center tower (tower spans z -4..4, height 3)
    await sleep(60);
    match().players.get(A.me.id).lastInputAt = 0;
    const mk = A.mark();
    A.send({ t: 'input', p: [0, 0.5, 2], yaw: 0, pitch: 0 }); // inside the tower
    const c = await A.wait((m) => m.t === 'ev' && m.k === 'correct', mk);
    assert.strictEqual(c.why, 'wall');
  });

  await test('server-side hitscan: laser shots damage and eliminate, with hit confirm + damage event', async () => {
    place(A.me.id, 0, 0, 22); place(B.me.id, 0, 0, 16);
    const eye = { x: 0, y: 1.55, z: 22 }, chest = { x: 0, y: 1.0, z: 16 };
    const ma = A.mark(), mb = B.mark();
    for (let i = 0; i < 8; i++) { // 150 health = 8 laser hits (fewer with a headshot)
      A.send({ t: 'fire', w: 0, o: [eye.x, eye.y, eye.z], d: dirTo(eye, chest), s: 100 + i, a: 1 });
      await sleep(170);
    }
    const elim = await B.wait((m) => m.t === 'ev' && m.k === 'elim' && m.v === B.me.id, mb);
    assert.strictEqual(elim.by, A.me.id);
    assert.ok(A.count((m) => m.t === 'ev' && m.k === 'hit', ma) >= 5); // headshots can finish sooner
    assert.ok(B.count((m) => m.t === 'ev' && m.k === 'dmg' && m.v === B.me.id, mb) >= 5);
    assert.strictEqual(match().match.scores[A.me.id].kills, 1);
  });

  await test('respawn event arrives and the victim is alive again', async () => {
    const sp = await B.wait((m) => m.t === 'ev' && m.k === 'spawn' && m.id === B.me.id, 0, 4000);
    assert.ok(Array.isArray(sp.p));
    assert.strictEqual(match().players.get(B.me.id).alive, true);
  });

  await test('anti-cheat: firing faster than the weapon allows is rejected', async () => {
    await sleep(1300); // spawn shield
    place(A.me.id, 0, 0, 22); place(B.me.id, 0, 0, 16);
    const eye = { x: 0, y: 1.55, z: 22 }, chest = { x: 0, y: 1.0, z: 16 };
    await sleep(200);
    const ma = A.mark();
    for (let i = 0; i < 6; i++) A.send({ t: 'fire', w: 0, o: [eye.x, eye.y, eye.z], d: dirTo(eye, chest), s: 7 + i, a: 1 });
    await sleep(300);
    assert.strictEqual(A.count((m) => m.t === 'ev' && m.k === 'hit', ma), 1);
    assert.ok(A.count((m) => m.t === 'ev' && m.k === 'ammo' && m.why === 'rate', ma) >= 4);
  });

  await test('anti-cheat: shots from a fake position are rejected', async () => {
    await sleep(300);
    const ma = A.mark();
    A.send({ t: 'fire', w: 0, o: [0, 1.55, 17], d: [0, 0, -1], s: 1, a: 1 });
    const r = await A.wait((m) => m.t === 'ev' && m.k === 'ammo', ma);
    assert.strictEqual(r.why, 'origin');
    assert.strictEqual(A.count((m) => m.t === 'ev' && m.k === 'hit', ma), 0);
  });

  await test('lag compensation: a shot hits where the shooter saw the target', async () => {
    await sleep(300);
    const m = match();
    const pb = place(B.me.id, 0, 0, 16);
    const t = Number(process.hrtime.bigint() / 1000n) / 1e6;
    // B was at x=0 120 ms ago and has since moved 3 m sideways.
    pb.hist = [{ t: t - 0.3, x: 0, y: 0, z: 16, c: false }, { t: t - 0.05, x: 0, y: 0, z: 16, c: false }, { t: t - 0.01, x: 3, y: 0, z: 16, c: false }];
    pb.pos = { x: 3, y: 0, z: 16 };
    m.players.get(A.me.id).rtt = 0.04; // rewind = 20 ms + 100 ms interpolation
    place(A.me.id, 0, 0, 22);
    const eye = { x: 0, y: 1.55, z: 22 };
    const ma = A.mark();
    A.send({ t: 'fire', w: 0, o: [eye.x, eye.y, eye.z], d: dirTo(eye, { x: 0, y: 1.0, z: 16 }), s: 3, a: 1 });
    const hit = await A.wait((x) => x.t === 'ev' && (x.k === 'hit' || x.k === 'ammo'), ma);
    assert.strictEqual(hit.k, 'hit');
  });

  await test('rocket: server projectile explodes with splash damage and knockback push', async () => {
    await sleep(1000);
    place(A.me.id, 0, 0, 22); place(B.me.id, 0, 0, 16);
    const ma = A.mark(), mb = B.mark();
    A.send({ t: 'input', p: [0, 0, 22], yaw: 0, pitch: 0, w: 1 });
    await sleep(250);
    const eye = { x: 0, y: 1.55, z: 22 };
    A.send({ t: 'fire', w: 1, o: [eye.x, eye.y, eye.z], d: dirTo(eye, { x: 0, y: 0.2, z: 16 }), s: 5, a: 0 });
    const boom = await B.wait((m) => m.t === 'ev' && m.k === 'boom', mb);
    assert.strictEqual(boom.w, 'rocket');
    await B.wait((m) => m.t === 'ev' && m.k === 'push', mb);
    await B.wait((m) => m.t === 'ev' && m.k === 'dmg' && m.v === B.me.id, mb);
    assert.ok(B.count((m) => m.t === 'ev' && m.k === 'proj', mb) === 1, 'B sees the rocket in flight');
    assert.strictEqual(A.count((m) => m.t === 'ev' && m.k === 'proj', ma), 0, 'shooter predicts its own rocket');
  });

  await test('reconnection: same token rejoins the running match', async () => {
    const token = B.me.token;
    B.close();
    await sleep(300);
    assert.strictEqual(match().players.get(B.me.id).connected, false);
    const B2 = await client(port);
    B2.send({ t: 'hello', v: C.PROTOCOL, token });
    const w = await B2.wait((m) => m.t === 'welcome');
    assert.strictEqual(w.id, B.me.id);
    const s = await B2.wait((m) => m.t === 'match_start');
    assert.strictEqual(s.resume, true);
    assert.strictEqual(match().players.get(B.me.id).connected, true);
    Object.assign(B, B2, { me: Object.assign(B.me, { token }) });
  });

  await test('match ends at the score limit; both vote rematch and a new match starts', async () => {
    const m = match();
    for (let i = 0; i < 4; i++) C.recordElimination(m.match, A.me.id, B.me.id);
    const ma = A.mark(), mb = B.mark();
    const end = await A.wait((x) => x.t === 'match_end', ma, 5000);
    assert.strictEqual(end.results.winnerId, A.me.id);
    assert.strictEqual(end.ratingChange, 0, 'private rooms are unranked');
    await B.wait((x) => x.t === 'match_end', mb);
    A.send({ t: 'vote', yes: true }); B.send({ t: 'vote', yes: true });
    await A.wait((x) => x.t === 'match_start', ma);
    await B.wait((x) => x.t === 'match_start', mb);
  });

  await test('match history records the private match', async () => {
    const mk = A.mark();
    A.send({ t: 'history' });
    const h = await A.wait((m) => m.t === 'history', mk);
    assert.strictEqual(h.rows[0].result, 'win');
    assert.strictEqual(h.rows[0].ranked, false);
  });

  await test('friends: mutual add, then invite to a private room', async () => {
    // end the running match first
    const m = match(); for (let i = 0; i < 5; i++) C.recordElimination(m.match, B.me.id, A.me.id);
    await A.wait((x) => x.t === 'match_end', A.mark() - 50, 5000);
    let mk = A.mark();
    A.send({ t: 'friend_add', code: B.me.friendCode });
    await A.wait((x) => x.t === 'notice' && /request sent/i.test(x.msg), mk);
    B.send({ t: 'friend_add', code: A.me.friendCode });
    const fl = await A.wait((x) => x.t === 'friends' && x.friends.some((f) => f.id === B.me.id), mk);
    assert.strictEqual(fl.friends[0].online, true);
    await sleep(1800); // rematch window passes; private room returns to its lobby
    mk = B.mark();
    A.send({ t: 'invite', id: B.me.id });
    const inv = await B.wait((x) => x.t === 'invite', mk);
    assert.strictEqual(inv.code, room.code);
  });

  await test('block: removes the friendship and stops invites', async () => {
    let mk = B.mark();
    B.send({ t: 'block', id: A.me.id });
    await B.wait((x) => x.t === 'notice' && /blocked/i.test(x.msg), mk);
    mk = A.mark();
    A.send({ t: 'invite', id: B.me.id });
    const e = await A.wait((x) => x.t === 'error', mk);
    assert.ok(/only invite friends/i.test(e.msg));
  });

  await test('report is stored for review', async () => {
    const mk = B.mark();
    B.send({ t: 'report', id: A.me.id, reason: 'mean' });
    await B.wait((x) => x.t === 'notice' && /report/i.test(x.msg), mk);
    assert.strictEqual(L.db.reports.length, 1);
    assert.strictEqual(L.db.reports[0].reason, 'mean');
    B.send({ t: 'report', id: A.me.id, reason: 'anything goes' });
    await sleep(100);
    assert.strictEqual(L.db.reports.length, 1, 'unknown reasons are ignored');
  });

  await test('quick match: two queued players are matched (ranked) and ratings change', async () => {
    const Cc = await login(port), D = await login(port);
    Cc.send({ t: 'queue', mode: 'duel' }); D.send({ t: 'queue', mode: 'duel' });
    const st = await Cc.wait((m) => m.t === 'match_start', 0, 4000);
    assert.strictEqual(st.ranked, true);
    assert.ok(['neon', 'candy', 'sky'].includes(st.map));
    await D.wait((m) => m.t === 'match_start');
    const m = L.roomOf(Cc.me.id).match;
    for (let i = 0; i < 5; i++) C.recordElimination(m.match, Cc.me.id, D.me.id);
    const end = await Cc.wait((x) => x.t === 'match_end', 0, 5000);
    assert.ok(end.ratingChange > 0, 'winner gains rating');
    const endD = await D.wait((x) => x.t === 'match_end', 0, 5000);
    assert.ok(endD.ratingChange < 0, 'loser loses rating');
    const mk = Cc.mark();
    Cc.send({ t: 'leaderboard' });
    const lb = await Cc.wait((x) => x.t === 'leaderboard', mk);
    assert.strictEqual(lb.rows[0].name, Cc.me.name);
    Cc.close(); D.close();
  });

  await test('quick match: blocked players are never matched together', async () => {
    const E = await login(port), F = await login(port);
    E.send({ t: 'block', id: F.me.id });
    await sleep(100);
    E.send({ t: 'queue', mode: 'duel' }); F.send({ t: 'queue', mode: 'duel' });
    await sleep(2200);
    assert.strictEqual(E.count((m) => m.t === 'match_start'), 0);
    E.close(); F.close();
  });

  await test('team mode in a private room balances players onto two teams', async () => {
    const P = [await login(port), await login(port), await login(port), await login(port)];
    P[0].send({ t: 'room_create', mode: 'team2', map: 'neon' });
    const r = (await P[0].wait((m) => m.t === 'room' && m.room)).room;
    for (const p of P.slice(1)) p.send({ t: 'room_join', code: r.code });
    await P[0].wait((m) => m.t === 'room' && m.room && m.room.players.length === 4);
    P[0].send({ t: 'room_start' });
    const st = await P[0].wait((m) => m.t === 'match_start');
    const teams = st.players.map((p) => p.team);
    assert.strictEqual(teams.filter((t) => t === 'blue').length, 2);
    assert.strictEqual(teams.filter((t) => t === 'orange').length, 2);
    P.forEach((p) => p.close());
  });

  await test('quick chat sends only fixed phrases', async () => {
    const X = await login(port), Y = await login(port);
    X.send({ t: 'room_create', mode: 'duel', map: 'neon' });
    const r = (await X.wait((m) => m.t === 'room' && m.room)).room;
    Y.send({ t: 'room_join', code: r.code });
    await Y.wait((m) => m.t === 'room' && m.room);
    X.send({ t: 'chat', i: 1 });
    const c = await Y.wait((m) => m.t === 'chat');
    assert.strictEqual(c.i, 1);
    X.send({ t: 'chat', i: 999 });
    await sleep(200);
    assert.strictEqual(Y.count((m) => m.t === 'chat'), 1);
    X.close(); Y.close();
  });

  // ---------------- Weapon pack 2 ----------------
  {
    const S = await login(port, { loadout: ['burst', 'rail'] });
    const T = await login(port, { loadout: ['frost', 'bounce'] });
    const U = await login(port, { loadout: ['spin', 'bubble'] });
    S.send({ t: 'room_create', mode: 'ffa', map: 'yard' });
    const r = (await S.wait((m) => m.t === 'room' && m.room)).room;
    T.send({ t: 'room_join', code: r.code }); U.send({ t: 'room_join', code: r.code });
    await S.wait((m) => m.t === 'room' && m.room && m.room.players.length === 3);
    S.send({ t: 'room_start' });
    await S.wait((m) => m.t === 'match_start');
    await sleep(500);
    const mm = () => L.roomOf(S.me.id).match;
    const put = (id, x, z) => { const q = mm().players.get(id); q.pos = { x, y: 0, z }; q.hist = []; q.anchor = { ...q.pos }; q.ignoreUntil = 0; q.shieldT = 0; q.hp = C.MAX_HEALTH; q.alive = true; return q; };
    const reset = () => { put(S.me.id, 0, 24); put(T.me.id, 0, 20); put(U.me.id, 0, 16); };
    const eyeS = { x: 0, y: 1.55, z: 24 };

    await test('burst: 3 shots per trigger accepted, a 4th right after is rejected', async () => {
      reset(); await sleep(200);
      const mk = S.mark();
      for (let i = 0; i < 4; i++) { S.send({ t: 'fire', w: 0, o: [0, 1.55, 24], d: dirTo(eyeS, { x: 0, y: 1.0, z: 20 }), s: 50 + i, a: 1 }); await sleep(75); }
      await sleep(300);
      assert.strictEqual(S.count((m) => m.t === 'ev' && m.k === 'hit', mk), 3);
      assert.ok(S.count((m) => m.t === 'ev' && m.k === 'ammo' && m.why === 'rate', mk) >= 1);
    });

    await test('rail: a full charge pierces through two enemies in a line', async () => {
      await sleep(1600); reset();
      S.send({ t: 'input', p: [0, 0, 24], yaw: 0, pitch: 0, w: 1 });
      await sleep(250);
      const mt = T.mark(), mu = U.mark();
      S.send({ t: 'fire', w: 1, o: [0, 1.55, 24], d: [0, -0.03, -1], s: 8, c: 1, a: 1 });
      await T.wait((m) => m.t === 'ev' && m.k === 'dmg' && m.v === T.me.id, mt);
      await U.wait((m) => m.t === 'ev' && m.k === 'dmg' && m.v === U.me.id, mu);
    });

    await test('frost: hits slow the target (event + snapshot flag)', async () => {
      await sleep(2600); reset();
      put(T.me.id, 0, 12); put(S.me.id, 0, 18); put(U.me.id, 20, 0);
      await sleep(200);
      const ms = S.mark();
      T.send({ t: 'fire', w: 0, o: [0, 1.55, 12], d: dirTo({ x: 0, y: 1.55, z: 12 }, { x: 0, y: 1.0, z: 18 }), s: 3, a: 1 });
      const sl = await S.wait((m) => m.t === 'ev' && m.k === 'slow', ms);
      assert.ok(sl.secs > 1 && sl.m < 1);
      const snap = await S.wait((m) => m.t === 'snap' && m.s.some((row) => row[0] === S.me.id && (row[7] & 32)), ms);
      assert.ok(snap);
    });

    await test('bounce bomb: server bounces it and it explodes with splash', async () => {
      await sleep(400);
      put(T.me.id, -6, 12); put(S.me.id, -6, 8.5); put(U.me.id, 20, 0); // open floor, clear of the tower stairs
      T.send({ t: 'input', p: [-6, 0, 12], yaw: 0, pitch: 0, w: 1 });
      await sleep(250);
      const ms = S.mark();
      // aimed at the floor in front of S so it bounces first
      T.send({ t: 'fire', w: 1, o: [-6, 1.55, 12], d: dirTo({ x: -6, y: 1.55, z: 12 }, { x: -6, y: 0, z: 10 }), s: 4, a: 1 });
      const boom = await S.wait((m) => m.t === 'ev' && m.k === 'boom' && m.w === 'bounce', ms, 4000);
      assert.ok(boom);
      await S.wait((m) => m.t === 'ev' && m.k === 'dmg' && m.v === S.me.id, ms);
    });

    await test('spin and bubble fire within their limits', async () => {
      await sleep(300); reset();
      put(U.me.id, 0, 22); put(S.me.id, 0, 18);
      await sleep(200);
      const mu = U.mark();
      for (let i = 0; i < 8; i++) { U.send({ t: 'fire', w: 0, o: [0, 1.55, 22], d: dirTo({ x: 0, y: 1.55, z: 22 }, { x: 0, y: 1, z: 18 }), s: i, a: 0 }); await sleep(60); }
      await sleep(200);
      assert.ok(U.count((m) => m.t === 'ev' && m.k === 'hit', mu) >= 5, 'spin hits');
    });
    S.close(); T.close(); U.close();
  }

  A.close(); B.close();
  await sleep(100);
  await app.close();
  console.log(`\n${passed} passed${failed ? `, ${failed} FAILED` : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
