// Headless smoke test: boots the real page (with a Three.js stand-in), checks every map,
// plays team and free-for-all matches with bots, fires all 8 weapons, and exercises Loadout and Locker.
// Run: node tests/smoke.js   (needs the `playwright` package and a Chromium install)
const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

const root = path.join(__dirname, '..');
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8' });
    res.end(data);
  });
}).listen(0);

(async () => {
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/fonts|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.route('**/three.min.js', (r) => r.fulfill({ path: path.join(__dirname, 'three-stub.js'), contentType: 'text/javascript' }));
  await page.route('https://fonts.googleapis.com/**', (r) => r.fulfill({ body: '', contentType: 'text/css' }));
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForTimeout(800);

  const fatal = await page.$eval('#fatal', (e) => (e.hidden ? '' : e.textContent));
  if (fatal) throw new Error('Fatal screen: ' + fatal);

  let failed = false;
  const check = (ok, msg) => { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) failed = true; };

  // --- Every map builds, has a nav graph and valid spawns ---
  for (const id of ['neon', 'candy', 'sky', 'yard']) {
    const r = await page.evaluate((id) => {
      const b = window.__blast; const t0 = performance.now(); b.loadMap(id); const ms = performance.now() - t0;
      const w = b.world;
      const main = w.nav.nodes.filter((n) => n.main).length;
      const bad = w.spawns.filter((s) => b.C.anyOverlap({ x: s.x, y: s.y + 0.05, z: s.z }, 0.42, 1.8, w.boxes));
      const teams = { blue: w.spawns.filter((s) => s.team === 'blue').length, orange: w.spawns.filter((s) => s.team === 'orange').length };
      // every team spawn should be on the main walkable area
      const offNav = w.spawns.filter((s) => { const n = b.C.nearestNode(w.nav, { x: s.x, y: s.y, z: s.z }); return n < 0 || Math.hypot(w.nav.nodes[n].x - s.x, w.nav.nodes[n].z - s.z) > 3; });
      return { ms: Math.round(ms), boxes: w.boxes.length, main, bad: bad.length, teams, offNav: offNav.length };
    }, id);
    console.log(`    ${id}: ${JSON.stringify(r)}`);
    check(r.main > 80 && r.bad === 0 && r.teams.blue >= 5 && r.teams.orange >= 5 && r.offNav === 0, `${id} map: nav graph, 5+ spawns per team, no spawn inside walls`);
  }

  // --- The server builds exactly the same collision boxes as the browser ---
  {
    const { getMap } = require('../server/maps-node.js');
    let same = true;
    for (const id of ['neon', 'candy', 'sky', 'yard']) {
      const client = await page.evaluate((id) => { window.__blast.loadMap(id); return JSON.stringify(window.__blast.world.boxes); }, id);
      if (client !== JSON.stringify(getMap(id).boxes)) { same = false; console.log('    mismatch on ' + id); }
    }
    check(same, 'server collision matches the browser on all 4 maps');
  }

  // --- Bots are skinwalkers by default; the Settings switch brings back cartoon bots ---
  {
    const a = await page.evaluate(() => { const b = window.__blast; b.startMatch('duel'); return !!b.fighters[1].mesh.skinwalker; });
    const c = await page.evaluate(() => { const b = window.__blast; b.store.settings.spookyBots = false; b.startMatch('duel'); const r = !b.fighters[1].mesh.skinwalker; b.store.settings.spookyBots = true; return r; });
    check(a && c, 'bots are skinwalkers by default, cartoon when switched off');
  }

  // --- 3v3 on Sky Islands: bots fight, fall-offs are handled ---
  await page.evaluate(() => { const b = window.__blast; b.store.settings.map = 'sky'; b.startMatch('team3'); });
  await page.waitForTimeout(3200 + 14000);
  const sky = await page.evaluate(() => {
    const b = window.__blast, m = b.match;
    return { teamScores: m.teamScores, deaths: Object.values(m.scores).reduce((s, x) => s + x.deaths, 0), n: b.fighters.length,
      teams: b.fighters.map((f) => f.team), stuckInVoid: b.fighters.filter((f) => f.alive && f.pos.y < -14).length };
  });
  console.log('    sky 3v3 after 14s:', JSON.stringify(sky));
  check(sky.n === 6 && sky.teams.filter((t) => t === 'blue').length === 3, '3v3 has 6 players, 3 per team');
  check(sky.deaths > 0, 'eliminations happen on Sky Islands');
  check(sky.stuckInVoid === 0, 'nobody is left alive below the islands');

  // --- 5v5 on Candy Factory ---
  await page.evaluate(() => { const b = window.__blast; b.store.settings.map = 'candy'; b.startMatch('team5'); });
  await page.waitForTimeout(3200 + 12000);
  const candy = await page.evaluate(() => {
    const b = window.__blast;
    return { teamScores: b.match.teamScores, n: b.fighters.length,
      inBounds: b.fighters.every((f) => !f.alive || (Math.abs(f.pos.x) < 33 && Math.abs(f.pos.z) < 33 && f.pos.y > -1)) };
  });
  console.log('    candy 5v5 after 12s:', JSON.stringify(candy));
  check(candy.n === 10, '5v5 has 10 players');
  check(candy.teamScores.blue + candy.teamScores.orange > 0, 'team points are scored in Candy Factory');
  check(candy.inBounds, 'everyone stays inside the factory');

  // --- Team score limit ends the match with a result ---
  await page.evaluate(() => {
    const b = window.__blast, f = b.fighters;
    const me = f[0], foe = f.find((x) => x.team !== me.team);
    for (let i = 0; i < 25; i++) b.C.recordElimination(b.match, me.id, foe.id);
  });
  await page.waitForTimeout(1500);
  const res = await page.evaluate(() => ({ phase: window.__blast.state.phase, title: document.getElementById('resultTitle').textContent }));
  check(res.phase === 'results' && res.title === 'Victory!', 'reaching the team score limit shows Victory');

  // --- Practice: fire all 14 weapons at targets ---
  await page.evaluate(() => window.__blast.startMatch('practice'));
  await page.waitForTimeout(3300);
  const perWeapon = {};
  const nWeapons = await page.evaluate(() => window.__blast.fighters[0].weaponIds.length);
  for (let i = 0; i < nWeapons; i++) {
    if (i < 10) await page.keyboard.press(i === 9 ? 'Digit0' : 'Digit' + (i + 1)); // number keys 1-9, 0
    else await page.evaluate((i) => { const p = window.__blast.player; p.wIndex = i; p.swapT = 0.3; p.reloadT = 0; }, i);
    await page.waitForTimeout(400);
    const before = await page.evaluate(() => window.__blast.state.matchShots);
    for (let k = 0; k < 2; k++) { // 14 weapons x 2 holds fits inside the 60 s practice round
      await page.mouse.move(640, 400);
      await page.mouse.down();
      await page.waitForTimeout(1100); // long enough to fully charge the bow and rail
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    const after = await page.evaluate(() => ({ shots: window.__blast.state.matchShots, w: window.__blast.fighters[0].weaponIds[window.__blast.fighters[0].wIndex] }));
    perWeapon[after.w] = after.shots - before;
  }
  console.log('    shots per weapon:', JSON.stringify(perWeapon));
  check(Object.keys(perWeapon).length === 14 && Object.values(perWeapon).every((n) => n >= 2), 'all 14 weapons fire');
  check(perWeapon.burst >= 6 && perWeapon.burst % 3 === 0, 'Burst Blaster fires in 3-shot bursts');
  check(perWeapon.spin > 15, 'Spin Blaster spins up to a fast fire rate');

  // --- Duel on Neon City: aimed fire lands hits ---
  await page.evaluate(() => { const b = window.__blast; b.store.settings.map = 'neon'; b.startMatch('duel'); });
  await page.waitForTimeout(3300);
  await page.keyboard.press('Digit1');
  await page.mouse.down();
  for (let i = 0; i < 120; i++) {
    await page.evaluate(() => {
      const b = window.__blast, me = b.fighters[0], bot = b.fighters[1];
      if (!bot.alive) return;
      const dx = bot.pos.x - me.pos.x, dz = bot.pos.z - me.pos.z, dy = (bot.pos.y + 1.0) - (me.pos.y + me.eye);
      me.yaw = Math.atan2(-dx, -dz); me.pitch = Math.atan2(dy, Math.hypot(dx, dz)); me.recoilAcc = 0;
      me.pos.x += dx * 0.03; me.pos.z += dz * 0.03; me.pos.y = bot.pos.y;
    });
    await page.waitForTimeout(50);
  }
  await page.mouse.up();
  const duel = await page.evaluate(() => ({ hits: window.__blast.state.matchHits, shots: window.__blast.state.matchShots, scores: window.__blast.match.scores }));
  console.log('    neon duel:', JSON.stringify(duel));
  check(duel.hits > 0, 'aimed shots hit the bot in Neon City');

  // --- Loadout and Locker screens ---
  await page.evaluate(() => { document.getElementById('menuBtn').click(); });
  await page.evaluate(() => { const b = window.__blast; if (b.state.phase !== 'menu') { b.state.phase = 'results'; document.getElementById('menuBtn').click(); } });
  await page.waitForTimeout(300);
  await page.click('#loadoutBtn');
  await page.click('#weaponGrid [data-id="rocket"]');
  await page.click('#weaponGrid [data-id="bow"]');
  const lo = await page.evaluate(() => JSON.parse(localStorage.getItem('blastArena.v1')).settings.loadout);
  check(lo[0] === 'rocket' && lo[1] === 'bow', 'loadout picks are saved (' + lo.join(', ') + ')');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, 'loadout.png') });
  await page.click('#loadoutDone');
  await page.click('#lockerBtn');
  await page.click('#lockShirt [data-v="1"]');
  await page.click('#lockHair [data-v="mohawk"]');
  await page.click('#lockSlots [data-save="0"]');
  await page.waitForTimeout(700);
  const outfit = await page.evaluate(() => JSON.parse(localStorage.getItem('blastArena.v1')).settings);
  check(outfit.outfit.shirt === 1 && outfit.outfit.hair === 'mohawk' && outfit.outfits[0] && outfit.outfits[0].hair === 'mohawk', 'locker changes and saved outfit persist');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, 'locker.png') });
  await page.click('#lockerDone');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || __dirname, 'smoke.png') });

  check(errors.length === 0, 'no runtime errors' + (errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''));
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
