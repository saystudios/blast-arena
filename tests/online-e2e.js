// Online end-to-end test: the real game page (in headless Chromium, served by the real server)
// joins a private room made by a scripted player, plays a duel, takes and deals damage,
// gets eliminated and respawns, finishes, votes for a rematch, and leaves.
// Run: node tests/online-e2e.js   (needs the `playwright` package and a Chromium install)
'use strict';
const path = require('path');
const { chromium } = require('playwright');
const C = require('../src/core.js');
const { createServer } = require('../server/index.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) failed = true; };

function bot(port) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`);
    const b = { msgs: [] };
    b.send = (m) => ws.send(JSON.stringify(m));
    ws.onmessage = (e) => { const m = JSON.parse(e.data); b.msgs.push(m); if (m.ev) for (const ev of m.ev) b.msgs.push(Object.assign({ t: 'ev' }, ev)); };
    b.wait = async (pred, timeout = 6000) => { const t0 = Date.now(); for (;;) { const f = b.msgs.find(pred); if (f) return f; if (Date.now() - t0 > timeout) throw new Error('bot wait timeout'); await sleep(25); } };
    b.close = () => ws.close();
    ws.onopen = () => resolve(b);
  });
}

(async () => {
  console.log('Ben Zone online end-to-end');
  const app = createServer({ dataDir: null, countdown: 0.6, rematchWindow: 4 });
  const port = await app.listen(0);
  const L = app.lobby;

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route('**/three.min.js', (r) => r.fulfill({ path: path.join(__dirname, 'three-stub.js'), contentType: 'text/javascript' }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForTimeout(800);

  // Scripted opponent creates a room
  const X = await bot(port);
  X.send({ t: 'hello', v: C.PROTOCOL });
  const xme = await X.wait((m) => m.t === 'welcome');
  X.send({ t: 'room_create', mode: 'duel', map: 'yard' });
  const room = (await X.wait((m) => m.t === 'room' && m.room)).room;

  // The page goes online and joins by code
  await page.click('#onlineBtn');
  await page.waitForFunction(() => document.getElementById('netStatus').textContent === 'Online', null, { timeout: 5000 });
  const name = await page.textContent('#netName');
  check(/^[A-Z][a-z]+[A-Z][a-z]+\d{2}$/.test(name), 'page signs in with a generated name: ' + name);
  await page.fill('#joinCode', room.code.toLowerCase());
  await page.click('#joinBtn');
  await page.waitForFunction(() => !document.getElementById('room').hidden && document.querySelectorAll('#roomPlayers .frow').length === 2, null, { timeout: 5000 });
  check(true, 'page joins the room by code and sees both players');
  check(await page.isHidden('#roomStart'), 'non-host does not get a Start button');

  // Host starts
  X.send({ t: 'room_start' });
  await page.waitForFunction(() => window.__blast.state.online && window.__blast.state.phase === 'play', null, { timeout: 5000 });
  const pid = await page.evaluate(() => window.__blast.player.id);
  const info = await page.evaluate(() => ({ n: window.__blast.fighters.length, remote: window.__blast.fighters[1].remote, hud: !document.getElementById('hud').hidden }));
  check(info.n === 2 && info.remote && info.hud, 'match starts on the page with the opponent as a remote player');

  const m = () => L.roomOf(xme.id).match;
  // Inputs reach the server
  const before = { ...m().players.get(pid).pos };
  await page.keyboard.down('KeyW'); await sleep(700); await page.keyboard.up('KeyW');
  await sleep(200);
  const after = m().players.get(pid).pos;
  check(Math.hypot(after.x - before.x, after.z - before.z) > 1.5, 'walking on the page moves the player on the server');

  // Remote player is rendered where the server says
  const sp = m().players.get(xme.id);
  X.send({ t: 'input', p: [sp.pos.x + 0.3, sp.pos.y, sp.pos.z], yaw: 0, pitch: 0 });
  await sleep(500);
  const remotePos = await page.evaluate(() => { const f = window.__blast.fighters[1]; return { x: f.pos.x, z: f.pos.z }; });
  check(Math.hypot(remotePos.x - (sp.pos.x), remotePos.z - sp.pos.z) < 0.6, 'opponent appears at their server position (interpolated)');

  // Put both players in the open: page at z=22, opponent at z=16 (Training Yard), shields off.
  await sleep(800);
  const place = async (pageZ, botZ) => {
    await page.evaluate((z) => { const p = window.__blast.player; p.pos.set(0, 0, z); p.vel.set(0, 0, 0); }, pageZ);
    const mp = m().players.get(pid); mp.pos = { x: 0, y: 0, z: pageZ }; mp.anchor = { ...mp.pos }; mp.ignoreUntil = 0; mp.hist = []; mp.shieldT = 0;
    const mx = m().players.get(xme.id); mx.pos = { x: 0, y: 0, z: botZ }; mx.hist = []; mx.shieldT = 0;
    X.send({ t: 'input', p: [0, 0, botZ], yaw: Math.PI, pitch: 0 });
    await sleep(300);
  };
  await place(22, 16);

  // Opponent shoots the page player
  const hp0 = await page.evaluate(() => window.__blast.player.health);
  const eye = { x: 0, y: 1.55, z: 16 };
  for (let i = 0; i < 2; i++) {
    const tgt = { x: 0, y: 0.9, z: 22 };
    const d = [tgt.x - eye.x, tgt.y - eye.y, tgt.z - eye.z]; const l = Math.hypot(...d);
    X.send({ t: 'fire', w: 0, o: [eye.x, eye.y, eye.z], d: d.map((v) => v / l), s: 9 + i, a: 1 });
    await sleep(200);
  }
  await sleep(250);
  const hp1 = await page.evaluate(() => window.__blast.player.health);
  check(hp1 < hp0, `page player takes damage from server hits (${hp0} -> ${hp1})`);

  // Page shoots the opponent: aim at them and hold fire
  const xBefore = m().players.get(xme.id).hp;
  const aim = () => page.evaluate(() => { const p = window.__blast.player; p.yaw = 0; p.pitch = Math.atan2(1.0 - 1.55, 6); p.recoilAcc = 0; });
  await page.mouse.move(640, 400);
  await aim();
  await page.mouse.down();
  for (let i = 0; i < 4; i++) { await aim(); await sleep(50); } // hold aim steady (mouse moves would turn the camera)
  await page.mouse.up();
  await sleep(300);
  const xAfter = m().players.get(xme.id).hp;
  const pageHits = await page.evaluate(() => window.__blast.state.matchHits);
  check(xAfter < xBefore && pageHits > 0, `page shots are confirmed by the server (opponent ${xBefore} -> ${Math.round(xAfter)}, hit markers ${pageHits})`);

  // Opponent eliminates the page player -> death screen, then respawn
  await sleep(2600); // let the opponent respawn if the page knocked them out
  await place(22, 16);
  m().players.get(pid).shieldT = 0;
  m().players.get(pid).hp = 5;
  const tgt = { x: 0, y: 0.9, z: 22 };
  const d = [tgt.x - eye.x, tgt.y - eye.y, tgt.z - eye.z]; const l = Math.hypot(...d);
  await sleep(200);
  X.send({ t: 'fire', w: 0, o: [eye.x, eye.y, eye.z], d: d.map((v) => v / l), s: 77, a: 1 });
  await page.waitForFunction(() => !document.getElementById('deathOverlay').hidden, null, { timeout: 3000 });
  const by = await page.textContent('#deathBy');
  check(by.includes(xme.name), 'death screen names the opponent: ' + by);
  await page.waitForFunction(() => document.getElementById('deathOverlay').hidden && window.__blast.player.alive, null, { timeout: 5000 });
  check(true, 'page player respawns where the server says');

  // Finish the match: opponent reaches the limit
  for (let i = 0; i < 4; i++) C.recordElimination(m().match, xme.id, pid);
  await page.waitForFunction(() => !document.getElementById('results').hidden, null, { timeout: 5000 });
  const title = await page.textContent('#resultTitle');
  const reportBtns = await page.$$('#resultRows [data-act="report"]');
  check(title === 'Defeat' && reportBtns.length === 1, 'results show Defeat with Report/Block on the other player');

  // Report flow
  await reportBtns[0].click();
  await page.click('#reportReasons [data-reason="cheating"]');
  await sleep(300);
  check(L.db.reports.length === 1 && L.db.reports[0].about === xme.id, 'report from the results screen reaches the server');

  // Rematch
  await page.click('#rematchBtn');
  X.send({ t: 'vote', yes: true });
  await page.waitForFunction(() => window.__blast.state.online && (window.__blast.state.phase === 'countdown' || window.__blast.state.phase === 'play') && document.getElementById('results').hidden, null, { timeout: 5000 });
  check(true, 'both vote rematch and a new match starts on the page');

  // Quick chat
  X.send({ t: 'chat', i: 0 });
  await page.waitForFunction(() => [...document.querySelectorAll('#killfeed .chat')].some((e) => e.textContent.includes('Nice shot')), null, { timeout: 3000 });
  check(true, 'quick chat from the opponent shows up in the feed');

  // Leave the match from the pause menu
  await page.keyboard.press('KeyP');
  await page.waitForFunction(() => !document.getElementById('pause').hidden, null, { timeout: 2000 });
  check((await page.textContent('#quitBtn')) === 'Leave match', 'online pause menu offers Leave match');
  await page.click('#quitBtn');
  await page.waitForFunction(() => !document.getElementById('online').hidden && !window.__blast.state.online, null, { timeout: 4000 });
  await sleep(300);
  check(!L.roomOf(pid), 'leaving removes the player from the room on the server');

  check(errors.length === 0, 'no runtime errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, 'online.png') });
  X.close();
  await browser.close();
  await app.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
