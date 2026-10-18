/*
 * Blast Arena — core game rules (engine-agnostic, no Three.js dependency).
 * Shared by the browser client and (in Phase 3) the authoritative server,
 * so hit detection, damage and match scoring are computed by the same code on both sides.
 * Works as a browser global (window.BlastCore) and as a Node module.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlastCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- Weapons ----------
  // To add a weapon: add an entry here and to WEAPON_ORDER, then a viewmodel in game.js.
  // type 'hitscan' = instant ray; 'projectile' = travels with speed/gravity, optional splash.
  const WEAPONS = {
    laser: {
      id: 'laser', name: 'Laser Blaster', role: 'Accurate all-rounder', type: 'hitscan',
      damage: 20, pellets: 1, spread: 0.014, adsSpread: 0.002,
      fireInterval: 0.15, mag: 16, reload: 1.4, range: 90, falloffStart: 35, minFalloff: 0.6,
      recoil: 0.016, color: 0x22d3ff, botRange: 16
    },
    scatter: {
      id: 'scatter', name: 'Scatter Blaster', role: 'Close-range spread', type: 'hitscan',
      damage: 11, pellets: 8, spread: 0.075, adsSpread: 0.055,
      fireInterval: 0.8, mag: 4, reload: 1.9, range: 30, falloffStart: 8, minFalloff: 0.25,
      recoil: 0.06, color: 0xff7a1a, botRange: 5
    },
    dart: {
      id: 'dart', name: 'Foam Dart Blaster', role: 'Fast darts, slight drop', type: 'projectile',
      damage: 26, pellets: 1, spread: 0.012, adsSpread: 0.003,
      fireInterval: 0.3, mag: 10, reload: 1.5, range: 80, speed: 55, gravity: 6,
      recoil: 0.02, color: 0x3b82f6, botRange: 14
    },
    paintball: {
      id: 'paintball', name: 'Paintball Launcher', role: 'Lobbed splash shots', type: 'projectile',
      damage: 45, pellets: 1, spread: 0.02, adsSpread: 0.01,
      fireInterval: 0.6, mag: 6, reload: 2.0, range: 60, speed: 30, gravity: 14,
      splash: 2.4, splashMin: 15, knockback: 4, selfScale: 0,
      recoil: 0.03, color: 0x7cff3a, botRange: 15
    },
    precision: {
      id: 'precision', name: 'Precision Blaster', role: 'Scoped long range', type: 'hitscan',
      damage: 55, pellets: 1, spread: 0.06, adsSpread: 0, headMult: 2,
      fireInterval: 1.1, mag: 5, reload: 2.2, range: 150, falloffStart: 150, minFalloff: 1,
      recoil: 0.05, zoom: 0.38, color: 0xff2d2d, botRange: 28
    },
    rapid: {
      id: 'rapid', name: 'Rapid-Fire Blaster', role: 'Huge mag, fast fire', type: 'hitscan',
      damage: 9, pellets: 1, spread: 0.032, adsSpread: 0.016,
      fireInterval: 0.065, mag: 40, reload: 2.0, range: 50, falloffStart: 15, minFalloff: 0.5,
      recoil: 0.007, color: 0xffd60a, botRange: 12
    },
    rocket: {
      id: 'rocket', name: 'Rocket Launcher', role: 'Big splash, knockback', type: 'projectile',
      damage: 80, pellets: 1, spread: 0.004, adsSpread: 0,
      fireInterval: 0.9, mag: 2, reload: 2.4, range: 120, speed: 30, gravity: 0,
      splash: 4, splashMin: 20, knockback: 13, selfScale: 0.35,
      recoil: 0.04, color: 0xff3b1f, botRange: 14
    },
    bow: {
      id: 'bow', name: 'Energy Bow', role: 'Hold to charge, release', type: 'projectile',
      damage: 85, damageMin: 30, pellets: 1, spread: 0.02, adsSpread: 0.006,
      fireInterval: 0.25, chargeTime: 0.8, mag: 0, reload: 0, range: 140,
      speed: 85, speedMin: 35, gravity: 9,
      recoil: 0.02, color: 0x7c5cff, botRange: 22
    }
  };
  const WEAPON_ORDER = ['laser', 'scatter', 'dart', 'paintball', 'precision', 'rapid', 'rocket', 'bow'];

  const HEAD_MULTIPLIER = 1.5;
  const MAX_HEALTH = 100;
  const STEP_HEIGHT = 0.4;
  const EPS = 1e-4;
  const TEAMS = ['blue', 'orange'];

  // ---------- Modes ----------
  const MODES = {
    duel: { id: 'duel', name: '1v1 Duel', bots: 1, teams: false, scoreLimit: 5, timeLimit: 180, respawn: 2.0 },
    ffa: { id: 'ffa', name: 'Free-for-All', bots: 5, teams: false, scoreLimit: 12, timeLimit: 240, respawn: 2.5 },
    team2: { id: 'team2', name: '2v2 Team', teams: true, teamSize: 2, scoreLimit: 10, timeLimit: 240, respawn: 2.5 },
    team3: { id: 'team3', name: '3v3 Team', teams: true, teamSize: 3, scoreLimit: 15, timeLimit: 270, respawn: 3 },
    team5: { id: 'team5', name: '5v5 Team', teams: true, teamSize: 5, scoreLimit: 25, timeLimit: 300, respawn: 3 },
    practice: { id: 'practice', name: 'Target Practice', bots: 0, teams: false, scoreLimit: Infinity, timeLimit: 60, respawn: 0 }
  };
  function botCount(mode) { return mode.teams ? mode.teamSize * 2 - 1 : mode.bots; }

  const DIFFICULTY = {
    easy: { id: 'easy', label: 'Chill', aimError: 0.11, reaction: 0.65, turnRate: 4, strafe: 0.5, jumpChance: 0.1, fireSlow: 1.4 },
    normal: { id: 'normal', label: 'Normal', aimError: 0.06, reaction: 0.4, turnRate: 7, strafe: 0.8, jumpChance: 0.25, fireSlow: 1.15 },
    hard: { id: 'hard', label: 'Spicy', aimError: 0.032, reaction: 0.22, turnRate: 11, strafe: 1, jumpChance: 0.45, fireSlow: 1.0 }
  };

  // ---------- Math helpers ----------
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  function cross(a, b) { return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }; }
  function normalize(v) {
    const l = Math.hypot(v.x, v.y, v.z) || 1;
    return { x: v.x / l, y: v.y / l, z: v.z / l };
  }

  function damageAt(weapon, dist) {
    if (dist > weapon.range) return 0;
    if (weapon.type === 'projectile' || dist <= weapon.falloffStart) return weapon.damage;
    const t = (dist - weapon.falloffStart) / (weapon.range - weapon.falloffStart);
    return weapon.damage * (1 - (1 - weapon.minFalloff) * t);
  }

  /** Splash damage at a distance from the blast center. */
  function splashDamage(weapon, dist) {
    if (!weapon.splash || dist > weapon.splash) return 0;
    return weapon.splashMin + (weapon.damage - weapon.splashMin) * (1 - dist / weapon.splash);
  }

  /** Energy bow: speed, damage and spread for a charge from 0 to 1. */
  function bowShot(weapon, charge) {
    const c = clamp01(charge);
    return {
      speed: weapon.speedMin + (weapon.speed - weapon.speedMin) * c,
      damage: weapon.damageMin + (weapon.damage - weapon.damageMin) * c,
      spread: weapon.spread * (1 - c)
    };
  }

  /** Ray vs axis-aligned box. Direction must be normalized. Returns distance or Infinity. */
  function rayAABB(o, d, b) {
    let tmin = 0, tmax = Infinity;
    for (const a of ['x', 'y', 'z']) {
      if (Math.abs(d[a]) < 1e-9) {
        if (o[a] < b.min[a] || o[a] > b.max[a]) return Infinity;
      } else {
        let t1 = (b.min[a] - o[a]) / d[a];
        let t2 = (b.max[a] - o[a]) / d[a];
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return Infinity;
      }
    }
    return tmin;
  }

  /** Which face of the box a point on its surface lies on (unit normal). */
  function boxNormal(p, b) {
    const c = [
      [Math.abs(p.x - b.min.x), { x: -1, y: 0, z: 0 }], [Math.abs(p.x - b.max.x), { x: 1, y: 0, z: 0 }],
      [Math.abs(p.y - b.min.y), { x: 0, y: -1, z: 0 }], [Math.abs(p.y - b.max.y), { x: 0, y: 1, z: 0 }],
      [Math.abs(p.z - b.min.z), { x: 0, y: 0, z: -1 }], [Math.abs(p.z - b.max.z), { x: 0, y: 0, z: 1 }]
    ];
    c.sort((a, b2) => a[0] - b2[0]);
    return c[0][1];
  }

  /** Ray vs sphere. Direction must be normalized. */
  function raySphere(o, d, c, r) {
    const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
    const b = ox * d.x + oy * d.y + oz * d.z;
    const cc = ox * ox + oy * oy + oz * oz - r * r;
    const disc = b * b - cc;
    if (disc < 0) return Infinity;
    const s = Math.sqrt(disc);
    let t = -b - s;
    if (t < 0) t = -b + s;
    return t < 0 ? Infinity : t;
  }

  /** Random direction inside a cone of half-angle ~spread (radians) around d. */
  function spreadDir(d, spread, rng) {
    rng = rng || Math.random;
    if (!spread) return normalize(d);
    const up = Math.abs(d.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const right = normalize(cross(d, up));
    const up2 = cross(right, d);
    const ang = rng() * Math.PI * 2;
    const rad = spread * Math.sqrt(rng());
    const cx = Math.cos(ang) * rad, cy = Math.sin(ang) * rad;
    return normalize({
      x: d.x + right.x * cx + up2.x * cy,
      y: d.y + right.y * cx + up2.y * cy,
      z: d.z + right.z * cx + up2.z * cy
    });
  }

  // ---------- Collision ----------
  // Entities are vertical boxes: feet at pos, half-width `radius`, height `height`.
  function overlaps(p, r, h, b) {
    return p.x - r < b.max.x - EPS && p.x + r > b.min.x + EPS &&
      p.z - r < b.max.z - EPS && p.z + r > b.min.z + EPS &&
      p.y < b.max.y - EPS && p.y + h > b.min.y + EPS;
  }
  function anyOverlap(p, r, h, boxes) {
    for (const b of boxes) if (overlaps(p, r, h, b)) return b;
    return null;
  }

  /**
   * Moves an entity {pos, vel, radius, height, grounded} through the world boxes.
   * Axis-separated with sub-steps, auto step-up onto low ledges (stairs).
   * Sets e.groundBox to the box being stood on (for belts and jump pads).
   */
  function moveEntity(e, boxes, dt) {
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const sdt = dt / steps;
    let landed = false, hitWall = false, hitCeiling = false;
    for (let s = 0; s < steps; s++) {
      for (const axis of ['x', 'z']) {
        const delta = e.vel[axis] * sdt;
        if (!delta) continue;
        e.pos[axis] += delta;
        for (const b of boxes) {
          if (!overlaps(e.pos, e.radius, e.height, b)) continue;
          const rise = b.max.y - e.pos.y;
          if (e.grounded && rise > 0 && rise <= STEP_HEIGHT) {
            const oldY = e.pos.y;
            e.pos.y = b.max.y;
            if (!anyOverlap(e.pos, e.radius, e.height, boxes)) continue;
            e.pos.y = oldY;
          }
          e.pos[axis] = delta > 0 ? b.min[axis] - e.radius - EPS * 2 : b.max[axis] + e.radius + EPS * 2;
          e.vel[axis] = 0;
          hitWall = true;
        }
      }
      const dy = e.vel.y * sdt;
      e.pos.y += dy;
      let ground = null;
      for (const b of boxes) {
        if (!overlaps(e.pos, e.radius, e.height, b)) continue;
        if (dy <= 0) { e.pos.y = b.max.y; e.vel.y = 0; ground = b; }
        else { e.pos.y = b.min.y - e.height - EPS * 2; e.vel.y = 0; hitCeiling = true; }
      }
      if (!ground && e.vel.y <= 0) {
        // Standing still on a surface: probe just below the feet.
        const probe = { x: e.pos.x, y: e.pos.y - 0.03, z: e.pos.z };
        for (const b of boxes) {
          if (b.max.y <= e.pos.y + EPS * 4 && overlaps(probe, e.radius, e.height, b)) { ground = b; break; }
        }
      }
      if (ground && !e.grounded) landed = true;
      e.grounded = !!ground;
      e.groundBox = ground;
    }
    return { landed, hitWall, hitCeiling };
  }

  /** Highest walkable surface at (x, z) no higher than maxY. Returns {y, box} or null. */
  function groundAt(boxes, x, z, maxY) {
    let best = null;
    for (const b of boxes) {
      if (x < b.min.x || x > b.max.x || z < b.min.z || z > b.max.z) continue;
      if (b.max.y > maxY) continue;
      if (!best || b.max.y > best.y) best = { y: b.max.y, box: b };
    }
    return best;
  }

  // ---------- Bot navigation ----------
  /**
   * Builds a walk graph over every surface a player can stand on, sampled on a grid.
   * Edges are directed: stairs/steps up to STEP_HEIGHT, drops down to 3.5 m, no gaps, no jump pads.
   */
  function buildNavGraph(boxes, o) {
    const step = o.step || 2, r = o.radius || 0.38, h = o.height || 1.7, maxY = o.maxY == null ? 12 : o.maxY;
    const nodes = [], cells = new Map();
    const ni = Math.round((o.maxX - o.minX) / step), nj = Math.round((o.maxZ - o.minZ) / step);
    for (let i = 0; i <= ni; i++) {
      for (let j = 0; j <= nj; j++) {
        const x = o.minX + i * step, z = o.minZ + j * step;
        const tops = new Set();
        for (const b of boxes) {
          if (b.noNav || b.pad || b.max.y > maxY) continue;
          if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) tops.add(b.max.y);
        }
        for (const y of tops) {
          if (anyOverlap({ x, y: y + 0.02, z }, r, h, boxes)) continue;
          const g = groundAt(boxes, x, z, y + 0.01);
          if (!g || g.y !== y) continue;
          const node = { id: nodes.length, x, y, z, edges: [] };
          nodes.push(node);
          const key = i + ',' + j;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(node);
          node.i = i; node.j = j;
        }
      }
    }
    for (const a of nodes) {
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          if (!di && !dj) continue;
          const list = cells.get((a.i + di) + ',' + (a.j + dj));
          if (!list) continue;
          for (const b of list) if (walkable(boxes, a, b, r, h)) a.edges.push(b.id);
        }
      }
    }
    // Keep only the largest connected area so bots never target unreachable spots.
    const comp = new Array(nodes.length).fill(-1), adj = nodes.map(() => []);
    nodes.forEach((n) => n.edges.forEach((e) => { adj[n.id].push(e); adj[e].push(n.id); }));
    let best = -1, bestSize = 0;
    for (let s = 0, c = 0; s < nodes.length; s++) {
      if (comp[s] !== -1) continue;
      const stack = [s]; comp[s] = c; let size = 0;
      while (stack.length) { const v = stack.pop(); size++; for (const w of adj[v]) if (comp[w] === -1) { comp[w] = c; stack.push(w); } }
      if (size > bestSize) { bestSize = size; best = c; }
      c++;
    }
    nodes.forEach((n) => { n.main = comp[n.id] === best; });
    return { nodes };
  }

  function walkable(boxes, a, b, r, h) {
    const dx = b.x - a.x, dz = b.z - a.z, dist = Math.hypot(dx, dz);
    const n = Math.max(1, Math.ceil(dist / 0.35));
    let y = a.y;
    for (let k = 1; k <= n; k++) {
      const t = k / n, x = a.x + dx * t, z = a.z + dz * t;
      const g = groundAt(boxes, x, z, y + 0.42);
      if (!g || g.y < y - 3.5 || g.box.pad) return false;
      if (anyOverlap({ x, y: g.y + 0.02, z }, r * 0.8, h, boxes)) return false;
      y = g.y;
    }
    return Math.abs(y - b.y) < 0.05;
  }

  function nearestNode(graph, p, maxDy) {
    maxDy = maxDy == null ? 2.5 : maxDy;
    let best = -1, bestD = Infinity;
    for (const n of graph.nodes) {
      if (n.main === false) continue;
      const dy = Math.abs(n.y - p.y);
      if (dy > maxDy) continue;
      const d = (n.x - p.x) ** 2 + (n.z - p.z) ** 2 + dy * dy * 4;
      if (d < bestD) { bestD = d; best = n.id; }
    }
    return best;
  }

  /** A* over the nav graph. Returns node ids from start to goal, or null. */
  function findPath(graph, start, goal) {
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [goal];
    const N = graph.nodes;
    const hcost = (i) => Math.hypot(N[i].x - N[goal].x, N[i].y - N[goal].y, N[i].z - N[goal].z);
    const g = new Map([[start, 0]]), f = new Map([[start, hcost(start)]]);
    const came = new Map(), open = new Set([start]), closed = new Set();
    let guard = 0;
    while (open.size && guard++ < 20000) {
      let cur = -1, cf = Infinity;
      for (const i of open) { const v = f.get(i); if (v < cf) { cf = v; cur = i; } }
      if (cur === goal) {
        const path = [cur];
        while (came.has(cur)) { cur = came.get(cur); path.push(cur); }
        return path.reverse();
      }
      open.delete(cur); closed.add(cur);
      for (const nb of N[cur].edges) {
        if (closed.has(nb)) continue;
        const a = N[cur], b = N[nb];
        const tg = g.get(cur) + Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (tg < (g.has(nb) ? g.get(nb) : Infinity)) {
          came.set(nb, cur); g.set(nb, tg); f.set(nb, tg + hcost(nb)); open.add(nb);
        }
      }
    }
    return null;
  }

  // ---------- Shared randomness & hitboxes (client and server must agree) ----------
  /** Small seeded RNG (mulberry32) so client visuals and server hits use identical pellet spread. */
  function makeRng(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  /** Pellet directions for one trigger pull. */
  function pelletDirs(weapon, dir, ads, seed) {
    const rng = makeRng(seed);
    const out = [];
    for (let i = 0; i < weapon.pellets; i++) out.push(spreadDir(dir, ads ? weapon.adsSpread : weapon.spread, rng));
    return out;
  }
  /** Player hitboxes from feet position and current height (1.7 standing, 1.05 crouched). */
  function playerHead(pos, height) { return { x: pos.x, y: pos.y + height - 0.32, z: pos.z }; }
  function playerBody(pos, height) {
    return { min: { x: pos.x - 0.46, y: pos.y, z: pos.z - 0.46 }, max: { x: pos.x + 0.46, y: pos.y + height - 0.7, z: pos.z + 0.46 } };
  }

  /** Chooses the spawn whose nearest threat is farthest away. */
  function pickSpawn(spawns, threats, rng) {
    rng = rng || Math.random;
    if (!threats.length) return spawns[Math.floor(rng() * spawns.length)];
    let best = spawns[0], bestScore = -Infinity;
    for (const s of spawns) {
      let near = Infinity;
      for (const t of threats) near = Math.min(near, Math.hypot(s.x - t.x, s.z - t.z));
      const score = near + rng() * 2;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  /** Splits ids into two teams of equal size, keeping the first id (the player) on blue. */
  function balanceTeams(ids) {
    const teamOf = {};
    ids.forEach((id, i) => { teamOf[id] = i % 2 === 0 ? 'blue' : 'orange'; });
    return teamOf;
  }

  // ---------- Match rules ----------
  function createMatch(modeId, ids, teamOf) {
    const mode = MODES[modeId];
    if (!mode) throw new Error('Unknown mode: ' + modeId);
    const scores = {};
    ids.forEach((id) => { scores[id] = { id, kills: 0, deaths: 0, team: teamOf ? teamOf[id] : null }; });
    return {
      mode, time: 0, scores, over: false, winnerId: null, winnerTeam: null, reason: null,
      teamScores: mode.teams ? { blue: 0, orange: 0 } : null
    };
  }

  function recordElimination(m, killerId, victimId) {
    if (m.over) return;
    const victim = m.scores[victimId];
    if (victim) victim.deaths++;
    const k = killerId && killerId !== victimId ? m.scores[killerId] : null;
    if (!k) return;
    if (m.mode.teams) {
      if (victim && k.team === victim.team) return; // no points for teammates
      k.kills++;
      m.teamScores[k.team]++;
      if (m.teamScores[k.team] >= m.mode.scoreLimit) { m.over = true; m.winnerTeam = k.team; m.reason = 'score'; }
    } else {
      k.kills++;
      if (k.kills >= m.mode.scoreLimit) { m.over = true; m.winnerId = killerId; m.reason = 'score'; }
    }
  }

  function standings(m) {
    return Object.values(m.scores).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
  }

  function tickMatch(m, dt) {
    if (m.over) return;
    m.time += dt;
    if (m.time >= m.mode.timeLimit) {
      m.over = true; m.reason = 'time';
      if (m.mode.teams) {
        const b = m.teamScores.blue, o = m.teamScores.orange;
        m.winnerTeam = b === o ? null : b > o ? 'blue' : 'orange';
      } else {
        const st = standings(m);
        const tie = st.length > 1 && st[0].kills === st[1].kills && st[0].deaths === st[1].deaths;
        m.winnerId = tie ? null : st[0].id;
      }
    }
  }

  function timeLeft(m) { return Math.max(0, m.mode.timeLimit - m.time); }

  return {
    WEAPONS, WEAPON_ORDER, MODES, DIFFICULTY, TEAMS, HEAD_MULTIPLIER, MAX_HEALTH, STEP_HEIGHT,
    makeRng, pelletDirs, playerHead, playerBody, PROTOCOL: 1,
    damageAt, splashDamage, bowShot, rayAABB, raySphere, boxNormal, spreadDir, normalize,
    overlaps, anyOverlap, moveEntity, groundAt, buildNavGraph, nearestNode, findPath, pickSpawn,
    balanceTeams, botCount, createMatch, recordElimination, standings, tickMatch, timeLeft
  };
});
