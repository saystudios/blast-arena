/*
 * Authoritative online match.
 * Movement: clients own their movement for responsiveness; the server validates every update
 *   (speed, vertical speed, walls, falling) and snaps cheaters back.
 * Combat: the server owns all damage. Hitscan shots are re-traced against players rewound to where
 *   the shooter saw them (lag compensation). Projectiles are simulated on the server.
 */
'use strict';
const C = require('../src/core.js');
const { getMap } = require('./maps-node.js');

const TICK = 1 / 20;
const REWIND_MAX = 0.25;          // seconds of lag compensation at most
const INTERP_DELAY = 0.1;         // clients render other players this far in the past
const HISTORY = 1.0;              // seconds of position history kept per player
const DISCONNECT_GRACE = 60;      // seconds a dropped player keeps their slot
const STRIKE_LIMIT = 25;          // corrections in STRIKE_WINDOW before a kick
const STRIKE_WINDOW = 10;
const now = () => Number(process.hrtime.bigint() / 1000n) / 1e6;
const fin = (v) => typeof v === 'number' && Number.isFinite(v);
const vec = (a) => (Array.isArray(a) && a.length === 3 && a.every(fin) ? { x: a[0], y: a[1], z: a[2] } : null);
const r2 = (v) => Math.round(v * 100) / 100;

class Match {
  /**
   * opts: { mode, map, players: [{ id, name, outfit, loadout }], ranked, countdown, send(id, msg), onEnd(results) }
   */
  constructor(opts) {
    this.mode = C.MODES[opts.mode];
    this.mapId = opts.map;
    this.geo = getMap(opts.map);
    this.ranked = !!opts.ranked;
    this.send = opts.send;
    this.onEnd = opts.onEnd;
    this.countdown = opts.countdown == null ? 3 : opts.countdown;
    this.state = 'countdown';
    this.startedAt = now();
    this.events = [];          // broadcast this tick
    this.private = new Map();  // id -> events only that player sees
    this.projectiles = [];
    this.nextPid = 1;
    this.players = new Map();
    const ids = opts.players.map((p) => p.id);
    const teamOf = this.mode.teams ? C.balanceTeams(ids) : null;
    for (const info of opts.players) {
      const loadout = (Array.isArray(info.loadout) ? info.loadout : []).filter((w) => C.WEAPONS[w]).slice(0, 2);
      while (loadout.length < 2) loadout.push(loadout[0] === 'laser' ? 'scatter' : 'laser');
      const p = {
        id: info.id, name: info.name, outfit: info.outfit, team: teamOf ? teamOf[info.id] : null, loadout,
        pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, crouch: false, charging: false,
        hp: C.MAX_HEALTH, alive: true, respawnT: 0, shieldT: 0, lastHurt: -99, lastAttacker: null,
        w: 0, ammo: {}, reloadT: 0, lastFire: -99, lastShotAt: -99, burstUsed: 0, swapAt: -99, slowT: 0,
        hist: [], lastInputAt: 0, ignoreUntil: 0, anchor: null, pushBudget: 0, strikes: [],
        connected: true, leftAt: null, rtt: 0.1, shots: 0, hits: 0
      };
      loadout.forEach((w) => { p.ammo[w] = C.WEAPONS[w].mag; });
      this.players.set(p.id, p);
    }
    this.match = C.createMatch(opts.mode, ids, teamOf);
    for (const p of this.players.values()) this.spawn(p, true);
  }

  // ---------------------------------------------------------------- lifecycle
  startMessage(forId) {
    const me = this.players.get(forId);
    return {
      t: 'match_start', mode: this.mode.id, map: this.mapId, you: forId, ranked: this.ranked,
      countdown: Math.max(0, this.countdown - (now() - this.startedAt)),
      timeLeft: C.timeLeft(this.match),
      spawn: [r2(me.pos.x), r2(me.pos.y), r2(me.pos.z)], yaw: r2(me.yaw), alive: me.alive,
      players: [...this.players.values()].map((p) => ({ id: p.id, name: p.name, team: p.team, outfit: p.outfit, loadout: p.loadout })),
      scores: this.scoreState()
    };
  }

  tick(dt) {
    const t = now();
    if (this.state === 'countdown') {
      if (t - this.startedAt >= this.countdown) this.state = 'play';
    } else if (this.state === 'play') {
      C.tickMatch(this.match, dt);
      this.updateProjectiles(dt);
      for (const p of this.players.values()) this.updatePlayer(p, dt, t);
      if (this.match.over) this.finish();
    }
    this.flush(t);
  }

  updatePlayer(p, dt, t) {
    if (!p.connected && t - p.leftAt > DISCONNECT_GRACE) { this.removePlayer(p.id); return; }
    p.pushBudget = Math.max(0, p.pushBudget - dt * 6);
    if (p.shieldT > 0) p.shieldT -= dt;
    if (p.slowT > 0) p.slowT -= dt;
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) { const w = p.loadout[p.w]; p.ammo[w] = C.WEAPONS[w].mag; this.toPlayer(p.id, { k: 'ammo', w: p.w, n: p.ammo[w] }); }
    }
    if (!p.alive) {
      p.respawnT -= dt;
      if (p.respawnT <= 0 && !this.match.over) this.spawn(p, false);
      return;
    }
    if (p.hp < C.MAX_HEALTH && t - p.lastHurt > 3.5) p.hp = Math.min(C.MAX_HEALTH, p.hp + 20 * dt);
    this.recordHistory(p, t);
  }

  spawn(p, initial) {
    let pool = this.geo.spawns.filter((s) => (p.team ? s.team === p.team : true));
    if (!pool.length) pool = this.geo.spawns;
    const threats = [...this.players.values()].filter((o) => o !== p && o.alive && this.isEnemy(p, o)).map((o) => o.pos);
    const s = C.pickSpawn(pool, initial ? [] : threats);
    p.pos = { x: s.x, y: s.y + 0.05, z: s.z };
    p.yaw = Math.atan2(s.x, s.z); p.pitch = 0;
    p.hp = C.MAX_HEALTH; p.alive = true; p.shieldT = 1.2; p.reloadT = 0; p.lastAttacker = null; p.crouch = false;
    p.loadout.forEach((w) => { p.ammo[w] = C.WEAPONS[w].mag; });
    p.hist = []; p.anchor = { ...p.pos }; p.ignoreUntil = now() + 0.8;
    if (!initial) this.broadcast({ k: 'spawn', id: p.id, p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], yaw: r2(p.yaw) });
  }

  finish() {
    if (this.state === 'over') return;
    this.state = 'over';
    const st = C.standings(this.match);
    const results = {
      mode: this.mode.id, map: this.mapId, ranked: this.ranked, reason: this.match.reason,
      winnerTeam: this.match.winnerTeam, winnerId: this.match.winnerId, teamScores: this.match.teamScores,
      rows: st.map((r) => { const p = this.players.get(r.id); return { id: r.id, name: p ? p.name : 'Player', team: r.team, kills: r.kills, deaths: r.deaths, shots: p ? p.shots : 0, hits: p ? p.hits : 0 }; })
    };
    this.flush(now());
    if (this.onEnd) this.onEnd(results);
  }

  // ---------------------------------------------------------------- connections
  setConnected(id, connected) {
    const p = this.players.get(id); if (!p) return;
    p.connected = connected;
    p.leftAt = connected ? null : now();
    if (connected) { p.ignoreUntil = now() + 1.0; p.anchor = { ...p.pos }; }
  }
  removePlayer(id) {
    if (!this.players.has(id)) return;
    this.players.delete(id);
    this.broadcast({ k: 'left', id });
    // If only one side (or one player) remains, end the match.
    const left = [...this.players.values()];
    const teams = new Set(left.map((p) => p.team || p.id));
    if (this.state !== 'over' && teams.size < 2) {
      this.match.over = true; this.match.reason = 'forfeit';
      if (this.mode.teams) this.match.winnerTeam = left[0] ? left[0].team : null; else this.match.winnerId = left[0] ? left[0].id : null;
      this.finish();
    }
  }

  // ---------------------------------------------------------------- input & validation
  onInput(id, msg) {
    const p = this.players.get(id);
    if (!p || this.state === 'over') return;
    const t = now();
    const pos = vec(msg.p);
    if (fin(msg.yaw)) p.yaw = msg.yaw;
    if (fin(msg.pitch)) p.pitch = Math.max(-1.6, Math.min(1.6, msg.pitch));
    p.crouch = !!msg.cr; p.charging = !!msg.ch;
    if (Number.isInteger(msg.w) && msg.w >= 0 && msg.w < p.loadout.length && msg.w !== p.w) { p.w = msg.w; p.reloadT = 0; p.swapAt = t; }
    if (!pos || !p.alive) { p.lastInputAt = t; return; }
    // Ignore stale packets right after a spawn or correction (they were sent before the client got it).
    if (t < p.ignoreUntil && p.anchor && Math.hypot(pos.x - p.anchor.x, pos.z - p.anchor.z) > 3) return;
    const dt = Math.min(0.5, Math.max(0.02, t - (p.lastInputAt || t)));
    p.lastInputAt = t;
    const dh = Math.hypot(pos.x - p.pos.x, pos.z - p.pos.z);
    const maxH = 23 * dt + 1.2 + p.pushBudget;
    const maxUp = 14 * dt + 1.3 + p.pushBudget * 0.6 + (this.onPad(p) ? 4 : 0);
    const inWall = C.anyOverlap({ x: pos.x, y: pos.y + 0.2, z: pos.z }, 0.2, 0.9, this.geo.boxes);
    if (this.state === 'countdown' && dh > 1.5) return this.correct(p, 'countdown');
    if (dh > maxH || pos.y - p.pos.y > maxUp || inWall) return this.correct(p, inWall ? 'wall' : 'speed');
    p.pos = pos;
    const vy = this.geo.voidY;
    if (vy != null && pos.y < vy) {
      const credit = p.lastAttacker && t - p.lastHurt < 6 ? this.players.get(p.lastAttacker) : null;
      this.eliminate(p, credit || null);
    } else if (vy == null && (pos.y < -10 || Math.abs(pos.x) > 45 || Math.abs(pos.z) > 45)) {
      this.spawn(p, false);
    }
  }

  onPad(p) {
    const g = C.groundAt(this.geo.boxes, p.pos.x, p.pos.z, p.pos.y + 0.3);
    return !!(g && g.box.pad && p.pos.y - g.y < 0.6);
  }

  correct(p, why) {
    const t = now();
    p.strikes.push(t);
    while (p.strikes.length && t - p.strikes[0] > STRIKE_WINDOW) p.strikes.shift();
    p.anchor = { ...p.pos }; p.ignoreUntil = t + 0.4;
    this.toPlayer(p.id, { k: 'correct', p: [r2(p.pos.x), r2(p.pos.y), r2(p.pos.z)], why });
    if (p.strikes.length > STRIKE_LIMIT && this.onCheat) this.onCheat(p.id);
  }

  onSwapReload(id, msg) {
    const p = this.players.get(id); if (!p || !p.alive) return;
    if (msg.t === 'reload') {
      const w = C.WEAPONS[p.loadout[p.w]];
      if (w.mag && p.reloadT <= 0 && p.ammo[w.id] < w.mag) p.reloadT = w.reload;
    }
  }

  onFire(id, msg) {
    const p = this.players.get(id);
    if (!p || !p.alive || this.state !== 'play') return;
    const t = now();
    const wi = msg.w;
    if (!Number.isInteger(wi) || wi < 0 || wi >= p.loadout.length) return;
    if (wi !== p.w) { p.w = wi; p.reloadT = 0; p.swapAt = t; }
    const w = C.WEAPONS[p.loadout[wi]];
    const o = vec(msg.o), d0 = vec(msg.d);
    if (!o || !d0) return;
    const dl = Math.hypot(d0.x, d0.y, d0.z);
    if (dl < 0.9 || dl > 1.1) return this.reject(p, 'dir');
    const d = { x: d0.x / dl, y: d0.y / dl, z: d0.z / dl };
    const charge = w.chargeTime ? Math.max(0, Math.min(1, fin(msg.c) ? msg.c : 0)) : 1;
    const minGap = w.fireInterval * 0.8 + (w.chargeTime ? charge * w.chargeTime * 0.7 : 0) - 0.02;
    let burstShot = false;
    if (t - p.lastFire < minGap) {
      // Burst weapons: the follow-up shots of one trigger pull arrive inside the normal gap.
      if (w.burst && p.burstUsed < w.burst - 1 && t - p.lastShotAt >= w.burstGap * 0.6) burstShot = true;
      else return this.reject(p, 'rate');
    }
    if (t - p.swapAt < 0.15) return this.reject(p, 'swap');
    if (p.reloadT > 0) return this.reject(p, 'reload');
    if (w.mag && p.ammo[w.id] <= 0) { p.reloadT = w.reload; return this.reject(p, 'empty'); }
    const eye = { x: p.pos.x, y: p.pos.y + (p.crouch ? 0.88 : 1.55), z: p.pos.z };
    if (Math.hypot(o.x - eye.x, o.y - eye.y, o.z - eye.z) > 1.8) return this.reject(p, 'origin');
    if (burstShot) p.burstUsed++; else { p.lastFire = t; p.burstUsed = 0; }
    p.lastShotAt = t; p.shots++;
    if (w.mag) { p.ammo[w.id]--; if (p.ammo[w.id] <= 0) p.reloadT = w.reload; }
    const seed = Number.isInteger(msg.s) ? msg.s >>> 0 : 1;
    if (w.type === 'hitscan') this.fireHitscan(p, w, o, d, !!msg.a, seed, t, charge);
    else this.fireProjectile(p, w, o, d, !!msg.a, seed, charge);
  }

  reject(p, why) {
    const w = p.loadout[p.w];
    this.toPlayer(p.id, { k: 'ammo', w: p.w, n: p.ammo[w], r: p.reloadT > 0 ? 1 : 0, why });
  }

  // ---------------------------------------------------------------- combat
  isEnemy(a, b) { return a !== b && (!a.team || a.team !== b.team); }
  height(p) { return p.crouch ? 1.05 : 1.7; }

  recordHistory(p, t) {
    p.hist.push({ t, x: p.pos.x, y: p.pos.y, z: p.pos.z, c: p.crouch });
    while (p.hist.length && t - p.hist[0].t > HISTORY) p.hist.shift();
  }
  /** Where player p was at time t (interpolated from history). */
  posAt(p, t) {
    const h = p.hist;
    if (!h.length || t >= h[h.length - 1].t) return { pos: p.pos, crouch: p.crouch };
    if (t <= h[0].t) return { pos: { x: h[0].x, y: h[0].y, z: h[0].z }, crouch: h[0].c };
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1], b = h[i];
      if (a.t <= t && t <= b.t) {
        const k = (t - a.t) / (b.t - a.t || 1);
        return { pos: { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }, crouch: k < 0.5 ? a.c : b.c };
      }
    }
    return { pos: p.pos, crouch: p.crouch };
  }

  /** Nearest hit along a ray: { t, player, head, box }. rewindT: time to rewind other players to (or null). */
  castRay(o, d, max, shooter, rewindT) {
    let best = max, hitP = null, head = false, hitBox = null;
    for (const b of this.geo.boxes) { const tt = C.rayAABB(o, d, b); if (tt < best) { best = tt; hitBox = b; } }
    for (const q of this.players.values()) {
      if (q === shooter || !q.alive || !q.connected || !this.isEnemy(shooter, q)) continue;
      const at = rewindT != null ? this.posAt(q, rewindT) : { pos: q.pos, crouch: q.crouch };
      const h = at.crouch ? 1.05 : 1.7;
      const th = C.raySphere(o, d, C.playerHead(at.pos, h), 0.4);
      if (th < best) { best = th; hitP = q; head = true; hitBox = null; }
      const tb = C.rayAABB(o, d, C.playerBody(at.pos, h));
      if (tb < best) { best = tb; hitP = q; head = false; hitBox = null; }
    }
    return { t: best, player: hitP, head, box: hitBox };
  }

  /** All enemies a piercing ray passes through (rewound), plus where it hits a wall. */
  castRayPierce(o, d, max, shooter, rewindT) {
    let wallT = max;
    for (const b of this.geo.boxes) { const tt = C.rayAABB(o, d, b); if (tt < wallT) wallT = tt; }
    const hits = [];
    for (const q of this.players.values()) {
      if (q === shooter || !q.alive || !q.connected || !this.isEnemy(shooter, q)) continue;
      const at = this.posAt(q, rewindT);
      const h = at.crouch ? 1.05 : 1.7;
      const th = C.raySphere(o, d, C.playerHead(at.pos, h), 0.4), tb = C.rayAABB(o, d, C.playerBody(at.pos, h));
      const tt = Math.min(th, tb);
      if (tt < wallT) hits.push({ player: q, t: tt, head: th <= tb });
    }
    return { wallT, hits };
  }

  fireHitscan(p, w, o, d, ads, seed, t, charge) {
    const rewindT = t - Math.min(REWIND_MAX, p.rtt / 2 + INTERP_DELAY);
    const dirs = C.pelletDirs(w, d, ads, seed);
    const victims = new Map();
    const ends = [];
    const dmgAt = (dist) => (w.chargeTime ? C.chargedDamage(w, charge) : C.damageAt(w, dist));
    for (const dir of dirs) {
      if (w.pierce) {
        const ph = this.castRayPierce(o, dir, w.range, p, rewindT);
        ends.push([r2(o.x + dir.x * ph.wallT), r2(o.y + dir.y * ph.wallT), r2(o.z + dir.z * ph.wallT)]);
        for (const h of ph.hits) {
          const v = victims.get(h.player) || { dmg: 0, head: false };
          v.dmg += dmgAt(h.t) * (h.head ? (w.headMult || C.HEAD_MULTIPLIER) : 1); v.head = v.head || h.head;
          victims.set(h.player, v);
        }
        continue;
      }
      const hit = this.castRay(o, dir, w.range, p, rewindT);
      ends.push([r2(o.x + dir.x * hit.t), r2(o.y + dir.y * hit.t), r2(o.z + dir.z * hit.t)]);
      if (hit.player) {
        const v = victims.get(hit.player) || { dmg: 0, head: false };
        v.dmg += dmgAt(hit.t) * (hit.head ? (w.headMult || C.HEAD_MULTIPLIER) : 1);
        v.head = v.head || hit.head;
        victims.set(hit.player, v);
      }
    }
    this.broadcast({ k: 'shot', id: p.id, w: w.id, o: [r2(o.x), r2(o.y), r2(o.z)], e: ends }, p.id);
    if (victims.size) p.hits++;
    victims.forEach((v, q) => this.damage(q, v.dmg, p, v.head, w));
  }

  fireProjectile(p, w, o, d, ads, seed, charge) {
    const rng = C.makeRng(seed);
    let speed = w.speed, dmg = w.damage, spread = ads ? w.adsSpread : w.spread;
    if (w.chargeTime) { const b = C.bowShot(w, charge); speed = b.speed; dmg = b.damage; spread = ads ? Math.min(b.spread, w.adsSpread) : b.spread; }
    const dir = C.spreadDir(d, spread, rng);
    const color = w.id === 'paintball' ? (p.team === 'orange' ? 0xff7a1a : p.team === 'blue' ? 0x2f7bff : [0x9dff2e, 0x22d3ff, 0xff7a1a, 0xffd60a][seed % 4]) : w.color;
    const pr = {
      pid: this.nextPid++, owner: p, w, dmg, color, life: C.projectileLife(w, speed), bounces: w.bounces || 0,
      pos: { x: o.x + dir.x * 0.6, y: o.y + dir.y * 0.6, z: o.z + dir.z * 0.6 },
      vel: { x: dir.x * speed, y: dir.y * speed, z: dir.z * speed }
    };
    this.projectiles.push(pr);
    this.broadcast({ k: 'proj', pid: pr.pid, id: p.id, w: w.id, o: [r2(pr.pos.x), r2(pr.pos.y), r2(pr.pos.z)], v: [r2(pr.vel.x), r2(pr.vel.y), r2(pr.vel.z)], c: color }, p.id);
  }

  updateProjectiles(dt) {
    const keep = [];
    for (const pr of this.projectiles) {
      pr.life -= dt;
      if (pr.life <= 0 || !this.players.has(pr.owner.id)) { if (pr.w.splash && pr.life <= 0) this.explode(pr, pr.pos, null); continue; }
      pr.vel.y -= (pr.w.gravity || 0) * dt;
      const step = { x: pr.vel.x * dt, y: pr.vel.y * dt, z: pr.vel.z * dt };
      const len = Math.hypot(step.x, step.y, step.z) || 1e-6;
      const d = { x: step.x / len, y: step.y / len, z: step.z / len };
      const hit = this.castRay(pr.pos, d, len, pr.owner, null);
      if (hit.t < len) {
        const at = { x: pr.pos.x + d.x * hit.t, y: pr.pos.y + d.y * hit.t, z: pr.pos.z + d.z * hit.t };
        if (hit.box && pr.bounces > 0) {
          const n = C.boxNormal(at, hit.box);
          pr.vel = C.reflect(pr.vel, n, pr.w.bounceDamp || 0.6);
          pr.pos = { x: at.x + n.x * 0.06, y: at.y + n.y * 0.06, z: at.z + n.z * 0.06 };
          pr.bounces--;
          keep.push(pr);
          continue;
        }
        if (pr.w.splash) {
          const n = hit.box ? C.boxNormal(at, hit.box) : { x: -d.x, y: -d.y, z: -d.z };
          this.explode(pr, { x: at.x + n.x * 0.05, y: at.y + n.y * 0.05, z: at.z + n.z * 0.05 }, hit.player, n);
        } else {
          if (hit.player) { pr.owner.hits++; this.damage(hit.player, pr.dmg * (hit.head ? (pr.w.headMult || C.HEAD_MULTIPLIER) : 1), pr.owner, hit.head, pr.w); }
          this.broadcast({ k: 'impact', pid: pr.pid, id: pr.owner.id, p: [r2(at.x), r2(at.y), r2(at.z)] });
        }
        continue;
      }
      pr.pos.x += step.x; pr.pos.y += step.y; pr.pos.z += step.z;
      keep.push(pr);
    }
    this.projectiles = keep;
  }

  hasLOS(a, b) {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 0.01) return true;
    d.x /= len; d.y /= len; d.z /= len;
    for (const box of this.geo.boxes) if (C.rayAABB(a, d, box) < len - 0.05) return false;
    return true;
  }

  explode(pr, at, direct, normal) {
    const w = pr.w, owner = pr.owner;
    this.broadcast({ k: 'boom', pid: pr.pid, id: owner.id, w: w.id, p: [r2(at.x), r2(at.y), r2(at.z)], c: pr.color, n: normal ? [normal.x, normal.y, normal.z] : null });
    let any = false;
    for (const q of this.players.values()) {
      if (!q.alive || !q.connected) continue;
      if (q !== owner && !this.isEnemy(owner, q)) continue;
      const center = { x: q.pos.x, y: q.pos.y + this.height(q) * 0.5, z: q.pos.z };
      const dist = q === direct ? 0 : Math.max(0, Math.hypot(center.x - at.x, center.y - at.y, center.z - at.z) - 0.45);
      if (dist > w.splash) continue;
      if (q !== direct && !this.hasLOS(at, center)) continue;
      const self = q === owner;
      let dmg = C.splashDamage(w, dist);
      if (self) dmg *= w.selfScale || 0;
      const k = (w.knockback || 0) * (1 - dist / w.splash) * (self ? 1.1 : 1);
      if (k > 0 && (!self || w.selfScale > 0)) {
        let px = center.x - at.x, py = Math.max(center.y - at.y, 0) + 0.5, pz = center.z - at.z;
        const l = Math.hypot(px, py, pz) || 1;
        px = (px / l) * k; py = (py / l) * k; pz = (pz / l) * k;
        q.pushBudget += k * 1.2;
        this.toPlayer(q.id, { k: 'push', v: [r2(px), r2(py), r2(pz)] });
        if (!self) { q.lastAttacker = owner.id; q.lastHurt = now(); }
      }
      if (dmg > 0) { this.damage(q, dmg, owner, false); if (!self) any = true; }
    }
    if (any) owner.hits++;
  }

  damage(victim, amount, attacker, head, w) {
    if (!victim.alive || this.state !== 'play') return;
    const self = victim === attacker;
    if (victim.shieldT > 0) amount = 0;
    if (w && w.slow && amount > 0 && !self) { victim.slowT = w.slowTime; this.toPlayer(victim.id, { k: 'slow', secs: w.slowTime, m: w.slow }); }
    if (!self) this.toPlayer(attacker.id, { k: 'hit', v: victim.id, a: Math.round(amount), h: head ? 1 : 0, at: [r2(victim.pos.x), r2(victim.pos.y + 1.2), r2(victim.pos.z)] });
    if (amount <= 0) return;
    victim.hp -= amount;
    victim.lastHurt = now();
    if (!self) victim.lastAttacker = attacker.id;
    this.broadcast({ k: 'dmg', v: victim.id, a: Math.round(amount), f: attacker.id });
    if (victim.hp <= 0) this.eliminate(victim, self ? null : attacker);
  }

  eliminate(victim, killer) {
    if (!victim.alive) return;
    victim.alive = false; victim.hp = 0;
    victim.respawnT = this.mode.respawn;
    C.recordElimination(this.match, killer ? killer.id : null, victim.id);
    this.broadcast({ k: 'elim', v: victim.id, by: killer ? killer.id : null });
  }

  // ---------------------------------------------------------------- output
  broadcast(ev, exceptId) { this.events.push({ ev, except: exceptId || null }); }
  toPlayer(id, ev) { if (!this.private.has(id)) this.private.set(id, []); this.private.get(id).push(ev); }

  scoreState() {
    const sc = {};
    for (const [id, s] of Object.entries(this.match.scores)) sc[id] = [s.kills, s.deaths];
    return { sc, ts: this.match.teamScores };
  }

  flush(t) {
    const s = [];
    for (const p of this.players.values()) {
      const flags = (p.alive ? 1 : 0) | (p.crouch ? 2 : 0) | (p.shieldT > 0 ? 4 : 0) | (p.charging ? 8 : 0) | (p.connected ? 0 : 16) | (p.slowT > 0 ? 32 : 0);
      s.push([p.id, r2(p.pos.x), r2(p.pos.y), r2(p.pos.z), r2(p.yaw), r2(p.pitch), Math.ceil(p.hp), flags, p.w]);
    }
    // `now` is the server clock in ms (used by clients to smooth movement); `ts` is team scores.
    const base = Object.assign({ t: 'snap', st: this.state, tl: Math.round(C.timeLeft(this.match) * 10) / 10, s }, this.scoreState(), { now: Math.round(t * 1000) });
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      const evs = this.events.filter((e) => e.except !== p.id).map((e) => e.ev);
      const mine = this.private.get(p.id);
      if (mine) evs.push(...mine);
      const msg = evs.length ? Object.assign({ ev: evs }, base) : base;
      this.send(p.id, msg);
    }
    this.events = [];
    this.private.clear();
  }
}

module.exports = { Match, TICK };
