// Run with: npm test   (or: node tests/core.test.js)
const assert = require('assert');
const C = require('../src/core.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; }
}
const box = (x0, y0, z0, x1, y1, z1) => ({ min: { x: x0, y: y0, z: z0 }, max: { x: x1, y: y1, z: z1 } });
const floor = box(-50, -1, -50, 50, 0, 50);
const entity = (x, y, z) => ({ pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, radius: 0.42, height: 1.7, grounded: false });

console.log('Blast Arena core tests');

test('damage is full inside falloff start and reduced at max range', () => {
  const w = C.WEAPONS.laser;
  assert.strictEqual(C.damageAt(w, 10), w.damage);
  assert.ok(Math.abs(C.damageAt(w, w.range) - w.damage * w.minFalloff) < 1e-9);
  assert.strictEqual(C.damageAt(w, w.range + 1), 0);
});

test('weapons are balanced: time-to-eliminate between 0.5s and 1.5s at ideal range', () => {
  for (const w of Object.values(C.WEAPONS)) {
    const perShot = w.damage * w.pellets;
    const shots = Math.ceil(C.MAX_HEALTH / perShot);
    const ttk = (shots - 1) * (w.fireInterval + (w.chargeTime || 0));
    assert.ok(ttk >= 0.5 && ttk <= 1.5, `${w.id} ttk ${ttk}`);
  }
});

test('ray hits a box in front and misses a box behind', () => {
  const b = box(4, -1, -1, 6, 1, 1);
  assert.strictEqual(C.rayAABB({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, b), 4);
  assert.strictEqual(C.rayAABB({ x: 0, y: 0, z: 0 }, { x: -1, y: 0, z: 0 }, b), Infinity);
});

test('ray vs sphere returns nearest surface distance', () => {
  const t = C.raySphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: -10 }, 1);
  assert.ok(Math.abs(t - 9) < 1e-9);
  assert.strictEqual(C.raySphere({ x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -10 }, 1), Infinity);
});

test('spread directions stay unit length and inside the cone', () => {
  const d = { x: 0, y: 0, z: -1 };
  for (let i = 0; i < 500; i++) {
    const s = C.spreadDir(d, 0.1);
    assert.ok(Math.abs(Math.hypot(s.x, s.y, s.z) - 1) < 1e-9);
    assert.ok(Math.acos(-s.z) <= 0.1 + 1e-6);
  }
});

test('entity falls and lands on the floor', () => {
  const e = entity(0, 2, 0);
  for (let i = 0; i < 120; i++) { e.vel.y -= 22 / 60; C.moveEntity(e, [floor], 1 / 60); }
  assert.ok(Math.abs(e.pos.y) < 1e-6);
  assert.strictEqual(e.grounded, true);
});

test('wall blocks horizontal movement', () => {
  const wall = box(2, 0, -5, 3, 4, 5);
  const e = entity(0, 0, 0); e.grounded = true;
  for (let i = 0; i < 60; i++) { e.vel.x = 8; e.vel.y = -1; C.moveEntity(e, [floor, wall], 1 / 60); }
  assert.ok(e.pos.x + e.radius <= 2 + 1e-3, 'x=' + e.pos.x);
});

test('entity walks up a low step but not a tall ledge', () => {
  const step = box(2, 0, -5, 20, 0.375, 5);
  const e = entity(0, 0, 0); e.grounded = true;
  for (let i = 0; i < 60; i++) { e.vel.x = 6; e.vel.y -= 22 / 60; C.moveEntity(e, [floor, step], 1 / 60); }
  assert.ok(e.pos.y > 0.3, 'climbed step');
  const ledge = box(2, 0, -5, 4, 1.2, 5);
  const f = entity(0, 0, 0); f.grounded = true;
  for (let i = 0; i < 60; i++) { f.vel.x = 6; f.vel.y -= 22 / 60; C.moveEntity(f, [floor, ledge], 1 / 60); }
  assert.ok(f.pos.y < 0.01 && f.pos.x < 2, 'blocked by ledge');
});

test('spawn picker chooses the spawn farthest from threats', () => {
  const spawns = [{ x: 0, z: 0 }, { x: 30, z: 0 }];
  const s = C.pickSpawn(spawns, [{ x: 1, z: 0 }], () => 0);
  assert.strictEqual(s.x, 30);
});

test('match ends when score limit is reached', () => {
  const m = C.createMatch('duel', ['you', 'bot']);
  for (let i = 0; i < 4; i++) C.recordElimination(m, 'you', 'bot');
  assert.strictEqual(m.over, false);
  C.recordElimination(m, 'you', 'bot');
  assert.strictEqual(m.over, true);
  assert.strictEqual(m.winnerId, 'you');
});

test('match times out as a draw when tied', () => {
  const m = C.createMatch('duel', ['you', 'bot']);
  C.recordElimination(m, 'you', 'bot');
  C.recordElimination(m, 'bot', 'you');
  C.tickMatch(m, 999);
  assert.strictEqual(m.over, true);
  assert.strictEqual(m.winnerId, null);
});

test('self-elimination does not award a point', () => {
  const m = C.createMatch('ffa', ['a', 'b']);
  C.recordElimination(m, 'a', 'a');
  assert.strictEqual(m.scores.a.kills, 0);
  assert.strictEqual(m.scores.a.deaths, 1);
});

test('every weapon in WEAPON_ORDER is defined with a distinct color', () => {
  assert.strictEqual(C.WEAPON_ORDER.length, 8);
  const colors = new Set(C.WEAPON_ORDER.map((id) => C.WEAPONS[id].color));
  assert.strictEqual(colors.size, 8);
});

test('splash damage is full at center and zero outside the radius', () => {
  const w = C.WEAPONS.rocket;
  assert.strictEqual(C.splashDamage(w, 0), w.damage);
  assert.strictEqual(C.splashDamage(w, w.splash + 0.1), 0);
  assert.ok(C.splashDamage(w, w.splash * 0.5) < w.damage);
});

test('bow charge scales speed and damage', () => {
  const w = C.WEAPONS.bow;
  assert.strictEqual(C.bowShot(w, 0).damage, w.damageMin);
  assert.strictEqual(C.bowShot(w, 1).damage, w.damage);
  assert.ok(C.bowShot(w, 1).speed > C.bowShot(w, 0.2).speed);
});

test('team match: points go to the team and end at the limit', () => {
  const ids = ['you', 'b0', 'b1', 'b2'];
  const teams = C.balanceTeams(ids);
  assert.strictEqual(teams.you, 'blue');
  assert.strictEqual(Object.values(teams).filter((t) => t === 'blue').length, 2);
  const m = C.createMatch('team2', ids, teams);
  const blueMate = ids.find((id) => id !== 'you' && teams[id] === 'blue');
  const orange = ids.find((id) => teams[id] === 'orange');
  C.recordElimination(m, 'you', blueMate); // teammate: no point
  assert.strictEqual(m.teamScores.blue, 0);
  for (let i = 0; i < 10; i++) C.recordElimination(m, i % 2 ? 'you' : blueMate, orange);
  assert.strictEqual(m.over, true);
  assert.strictEqual(m.winnerTeam, 'blue');
});

test('nav graph climbs stairs and refuses to cross a gap', () => {
  const boxes = [box(-10, -1, -4, 0, 0, 4)];                // left floor
  for (let i = 0; i < 4; i++) boxes.push(box(0 + i, -1, -4, 1 + i, 0.375 * (i + 1), 4)); // stairs up
  boxes.push(box(4, -1, -4, 10, 1.5, 4));                   // upper deck
  boxes.push(box(14, -1, -4, 20, 1.5, 4));                  // island across a gap
  const g = C.buildNavGraph(boxes, { minX: -10, maxX: 20, minZ: -4, maxZ: 4, step: 1 });
  const a = C.nearestNode(g, { x: -8, y: 0, z: 0 });
  const b = C.nearestNode(g, { x: 8, y: 1.5, z: 0 });
  assert.ok(C.findPath(g, a, b), 'path up the stairs');
  const island = g.nodes.filter((n) => n.x >= 14);
  assert.ok(island.length > 0 && island.every((n) => !n.main), 'island is not reachable on foot');
});

test('ground lookup finds the highest surface under a point', () => {
  const boxes = [floor, box(-1, 0, -1, 1, 2, 1)];
  assert.strictEqual(C.groundAt(boxes, 0, 0, 5).y, 2);
  assert.strictEqual(C.groundAt(boxes, 0, 0, 1).y, 0);
  assert.strictEqual(C.groundAt(boxes, 99, 0, 5), null);
});

console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
