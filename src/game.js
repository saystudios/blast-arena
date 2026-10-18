/*
 * Blast Arena — client (Phase 2).
 * Renderer, maps, player controller, 8 weapons (hitscan + projectiles), bots with pathfinding,
 * team modes, character locker, loadout, HUD, input (touch / keyboard+mouse / gamepad), save.
 * Game rules live in core.js so the Phase 3 server can share them.
 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  let crashed = false;
  function showFatal(msg) {
    crashed = true;
    const f = $('fatal');
    if (f) { $('fatalMsg').textContent = msg; f.hidden = false; }
  }
  window.addEventListener('error', (e) => { if (!crashed) showFatal('Something went wrong: ' + (e.message || 'unknown error')); });

  if (!window.THREE) { showFatal('The 3D engine did not load. Check your internet connection and reload.'); return; }
  if (!window.BlastCore || !window.BA || !window.BA.MAPS || !window.BA.buildCharacter) { showFatal('A game file is missing. Reload the page.'); return; }
  const C = window.BlastCore;
  const BA = window.BA;
  const V3 = THREE.Vector3;
  const isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches) || ('ontouchstart' in window);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const rand = (a, b) => a + Math.random() * (b - a);
  const hex = (c) => '#' + c.toString(16).padStart(6, '0');
  const TEAM_COLOR = { blue: 0x2f7bff, orange: 0xff7a1a };
  const TEAM_NAME = { blue: 'Blue', orange: 'Orange' };
  const SPARKS = [0xff7a1a, 0x22d3ff, 0x9dff2e, 0xffd60a, 0xffffff, 0x2f7bff];

  // ======================================================================
  // Save system
  // ======================================================================
  const SAVE_KEY = 'blastArena.v1';
  const DEFAULTS = {
    settings: {
      sens: 1, touchSens: 1, invertY: false, fov: 80, difficulty: 'normal', sfx: 0.7, cbMode: false, lefty: false,
      mode: 'duel', map: 'neon', loadout: ['laser', 'scatter'], outfit: BA.DEFAULT_OUTFIT, outfits: [null, null, null],
      quickChat: true, allowInvites: true, server: ''
    },
    stats: { matches: 0, wins: 0, kills: 0, deaths: 0, shots: 0, hits: 0, bestPractice: 0 }
  };
  function loadSave() {
    const fresh = JSON.parse(JSON.stringify(DEFAULTS));
    let d = {};
    try { d = JSON.parse(localStorage.getItem(SAVE_KEY) || '{}') || {}; } catch (e) { d = {}; }
    const s = Object.assign(fresh.settings, d.settings);
    // Migrate Phase 1 saves and repair anything invalid
    if (typeof s.loadout === 'string') s.loadout = [s.loadout === 'foam' ? 'scatter' : s.loadout, s.loadout === 'laser' ? 'scatter' : 'laser'];
    if (!Array.isArray(s.loadout) || s.loadout.length !== 2 || !s.loadout.every((id) => C.WEAPONS[id]) || s.loadout[0] === s.loadout[1]) s.loadout = ['laser', 'scatter'];
    if (!C.MODES[s.mode]) s.mode = 'duel';
    if (!BA.MAPS[s.map]) s.map = 'neon';
    if (!C.DIFFICULTY[s.difficulty]) s.difficulty = 'normal';
    s.outfit = BA.cleanOutfit(s.outfit);
    if (!Array.isArray(s.outfits)) s.outfits = [null, null, null];
    s.outfits = [0, 1, 2].map((i) => (s.outfits[i] ? BA.cleanOutfit(s.outfits[i]) : null));
    return { settings: s, stats: Object.assign(fresh.stats, d.stats) };
  }
  const store = loadSave();
  function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(store)); } catch (e) { /* storage blocked: play continues */ } }

  // ======================================================================
  // Sound (synthesized — no audio files to load)
  // ======================================================================
  const Sfx = (() => {
    let ctx = null, master = null, noiseBuf = null;
    function ensure() {
      if (!ctx) {
        try { ctx = new (window.AudioContext || window.webkitAudioContext)(); master = ctx.createGain(); master.connect(ctx.destination); }
        catch (e) { ctx = null; }
      }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      if (master) master.gain.value = store.settings.sfx;
      return ctx;
    }
    function tone(type, f0, f1, dur, vol, delay) {
      const c = ctx; if (!c || vol <= 0) return;
      const t = c.currentTime + (delay || 0);
      const o = c.createOscillator(), g = c.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
    }
    function noise(dur, vol, freq, delay, q) {
      const c = ctx; if (!c || vol <= 0) return;
      if (!noiseBuf) {
        noiseBuf = c.createBuffer(1, c.sampleRate * 0.8, c.sampleRate);
        const d = noiseBuf.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      const t = c.currentTime + (delay || 0);
      const s = c.createBufferSource(); s.buffer = noiseBuf;
      const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q || 1;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.02);
    }
    const shots = {
      laser: (v) => { tone('square', 1400, 300, 0.12, 0.1 * v); tone('sine', 2200, 900, 0.08, 0.05 * v); },
      scatter: (v) => { noise(0.18, 0.38 * v, 650, 0, 0.7); tone('triangle', 200, 80, 0.15, 0.16 * v); },
      dart: (v) => { noise(0.07, 0.25 * v, 2600, 0, 1.5); tone('sine', 700, 350, 0.06, 0.06 * v); },
      paintball: (v) => { tone('sine', 220, 70, 0.12, 0.2 * v); noise(0.08, 0.15 * v, 500, 0, 1); },
      precision: (v) => { tone('square', 900, 110, 0.28, 0.12 * v); noise(0.25, 0.25 * v, 1800, 0, 0.6); },
      rapid: (v) => { tone('square', 1800, 600, 0.05, 0.06 * v); },
      rocket: (v) => { noise(0.45, 0.3 * v, 300, 0, 0.5); tone('sawtooth', 140, 60, 0.3, 0.08 * v); },
      bow: (v) => { tone('triangle', 520, 180, 0.2, 0.16 * v); noise(0.1, 0.15 * v, 3000, 0, 2); }
    };
    return {
      unlock: ensure,
      setVolume(v) { if (master) master.gain.value = v; },
      shot(id, vol) { (shots[id] || shots.laser)(vol == null ? 1 : vol); },
      boom(vol) { noise(0.6, 0.55 * vol, 180, 0, 0.6); tone('sine', 110, 30, 0.5, 0.35 * vol); },
      splat(vol) { noise(0.12, 0.3 * vol, 1300, 0, 1.2); },
      hit(head) { tone('sine', head ? 1750 : 1150, head ? 1950 : 1250, 0.07, 0.16); },
      elim() { [880, 1175, 1568].forEach((f, i) => tone('square', f, f, 0.12, 0.08, i * 0.07)); },
      hurt() { tone('sawtooth', 240, 120, 0.14, 0.07); },
      reload() { noise(0.05, 0.2, 2400, 0, 4); noise(0.05, 0.2, 1800, 0.35, 4); },
      empty() { tone('square', 300, 280, 0.04, 0.05); },
      jump() { tone('sine', 380, 620, 0.1, 0.05); },
      dash() { noise(0.18, 0.22, 900, 0, 0.5); },
      pad() { tone('sine', 300, 1100, 0.3, 0.12); },
      step() { noise(0.04, 0.05, 500, 0, 1.5); },
      charge() { tone('sine', 300, 900, 0.75, 0.04); },
      beep(hi) { tone('square', hi ? 1320 : 660, hi ? 1320 : 660, hi ? 0.3 : 0.12, 0.07); },
      win() { [523, 659, 784, 1047].forEach((f, i) => tone('square', f, f, 0.22, 0.08, i * 0.12)); },
      lose() { [392, 330, 262].forEach((f, i) => tone('triangle', f, f * 0.98, 0.26, 0.1, i * 0.16)); },
      pop() { tone('sine', 600, 1400, 0.08, 0.12); noise(0.06, 0.15, 3000, 0, 2); },
      click() { tone('sine', 900, 1100, 0.04, 0.05); }
    };
  })();

  // ======================================================================
  // Renderer, scene, camera
  // ======================================================================
  const canvas = $('game');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: !isTouch, powerPreference: 'high-performance' });
  } catch (e) {
    showFatal('This device could not start 3D graphics (WebGL). Try another browser or turn off low-power mode.');
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1.6 : 2));
  renderer.outputEncoding = THREE.sRGBEncoding;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x86ccff);
  scene.fog = new THREE.Fog(0x86ccff, 70, 160);
  const camera = new THREE.PerspectiveCamera(store.settings.fov, 1, 0.05, 400);
  camera.rotation.order = 'YXZ';
  const vmScene = new THREE.Scene();
  const vmCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x7f9bb8, 0.95);
  const sun = new THREE.DirectionalLight(0xfff1d6, 0.85);
  sun.position.set(30, 55, 20);
  sun.castShadow = true;
  { const s = isTouch ? 1024 : 2048; sun.shadow.mapSize.set(s, s); const c = sun.shadow.camera; c.left = -42; c.right = 42; c.top = 42; c.bottom = -42; c.near = 1; c.far = 150; sun.shadow.bias = -0.0006; }
  scene.add(hemi, sun);
  vmScene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.0));
  { const l = new THREE.DirectionalLight(0xffffff, 0.7); l.position.set(1, 2, 1); vmScene.add(l); }

  // Locker (character preview) scene
  const lockerScene = new THREE.Scene();
  lockerScene.background = new THREE.Color(0x0e1a30);
  const lockerCam = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
  lockerCam.position.set(0, 1.25, 6); lockerCam.lookAt(0, 1.0, 0);
  lockerScene.add(new THREE.HemisphereLight(0xffffff, 0x334466, 1.0));
  { const l = new THREE.DirectionalLight(0xffffff, 0.9); l.position.set(2, 4, 3); lockerScene.add(l);
    const rim = new THREE.DirectionalLight(0x22d3ff, 0.6); rim.position.set(-3, 2, -3); lockerScene.add(rim);
    const plat = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.4, 0.2, 40), new THREE.MeshStandardMaterial({ color: 0x1b2a44, roughness: 0.5 }));
    plat.position.y = -0.1; lockerScene.add(plat);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.35, 0.04, 8, 48), new THREE.MeshBasicMaterial({ color: 0x9dff2e }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.01; lockerScene.add(ring); }
  let lockerChar = null, lockerYaw = -0.5, lockerWave = 0;

  function resize() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    for (const c of [camera, vmCamera, lockerCam]) { c.aspect = w / h; c.updateProjectionMatrix(); }
    if (w > h) lockerCam.setViewOffset(w, h, w * 0.24, 0, w, h);
    else lockerCam.setViewOffset(w, h, 0, h * 0.22, w, h);
  }
  window.addEventListener('resize', resize);
  resize();

  // ======================================================================
  // Maps
  // ======================================================================
  const mapGroup = new THREE.Group();
  scene.add(mapGroup);
  const world = { boxes: [], spawns: [], nav: null, map: null, updates: [] };
  const navCache = {};
  const matCache = {};
  const blockMat = (c) => matCache[c] || (matCache[c] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 }));
  const edgeMat = new THREE.LineBasicMaterial({ color: 0x0b1426, transparent: true, opacity: 0.25 });

  function canvasTex(w, h, draw, rx, ry) {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(rx || 1, ry || 1);
    t.encoding = THREE.sRGBEncoding; t.anisotropy = 4;
    return t;
  }
  const tex = {
    checker: (c1, c2, rep) => canvasTex(128, 128, (g) => {
      g.fillStyle = c1; g.fillRect(0, 0, 128, 128); g.fillStyle = c2; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
      g.strokeStyle = 'rgba(11,20,38,0.15)'; g.lineWidth = 2; g.strokeRect(0, 0, 128, 128);
    }, rep, rep),
    grid: (bg, line, rep) => canvasTex(128, 128, (g) => {
      g.fillStyle = bg; g.fillRect(0, 0, 128, 128);
      g.strokeStyle = line; g.globalAlpha = 0.25; g.lineWidth = 6; g.strokeRect(0, 0, 128, 128);
      g.globalAlpha = 0.8; g.lineWidth = 2; g.strokeRect(0, 0, 128, 128);
    }, rep, rep),
    stripes: (c1, c2, rx, ry, diagonal) => canvasTex(64, 64, (g) => {
      g.fillStyle = c1; g.fillRect(0, 0, 64, 64); g.fillStyle = c2;
      if (diagonal) { for (let i = -64; i < 128; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 16, 0); g.lineTo(i + 16 - 64, 64); g.lineTo(i - 64, 64); g.fill(); } }
      else g.fillRect(0, 0, 32, 64);
    }, rx, ry),
    choc: () => canvasTex(64, 64, (g) => {
      g.fillStyle = '#5a321c'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#7a4a2c';
      for (let x = 0; x < 2; x++) for (let y = 0; y < 2; y++) g.fillRect(x * 32 + 4, y * 32 + 4, 24, 24);
    }),
    windows: () => canvasTex(64, 128, (g) => {
      g.fillStyle = '#05070f'; g.fillRect(0, 0, 64, 128);
      for (let x = 0; x < 4; x++) for (let y = 0; y < 10; y++) {
        if (Math.random() < 0.45) continue;
        g.fillStyle = ['#ffd60a', '#22d3ff', '#ffffff', '#ff7a1a'][Math.floor(Math.random() * 4)];
        g.globalAlpha = 0.5 + Math.random() * 0.5; g.fillRect(x * 16 + 4, y * 12 + 3, 8, 6);
      }
    })
  };
  let windowsTex = null;
  const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const puffGeo = new THREE.SphereGeometry(1, 12, 10);

  const ctx = {
    tex,
    mat: (color, o) => new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.75 }, o || {})),
    box(cx, y0, cz, w, h, d, color, opt) {
      opt = opt || {};
      const b = { min: { x: cx - w / 2, y: y0, z: cz - d / 2 }, max: { x: cx + w / 2, y: y0 + h, z: cz + d / 2 } };
      if (opt.belt) b.belt = opt.belt;
      if (opt.pad) b.pad = opt.pad;
      if (opt.noNav) b.noNav = true;
      world.boxes.push(b);
      if (opt.invisible) return null;
      const geo = new THREE.BoxGeometry(w, h, d);
      const m = new THREE.Mesh(geo, opt.material || blockMat(color));
      m.position.set(cx, y0 + h / 2, cz);
      m.castShadow = opt.cast !== false; m.receiveShadow = true;
      if (opt.edges !== false) m.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), edgeMat));
      mapGroup.add(m);
      return m;
    },
    deco(obj) { mapGroup.add(obj); return obj; },
    scroll(t, sx, sy) { world.updates.push((dt) => { t.offset.x += sx * dt; t.offset.y += sy * dt; }); },
    stairs(x0, z0, dx, dz, steps, stepH, stepD, width, color) {
      for (let i = 0; i < steps; i++) {
        const off = (i + 0.5) * stepD, h = (steps - i) * stepH;
        ctx.box(x0 + dx * off, 0, z0 + dz * off, dx ? stepD : width, h, dx ? width : stepD, color, { edges: i % 2 === 0 });
      }
    },
    glowBar(x, y, z, w, h, d, color) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial({ color }));
      m.position.set(x, y, z); return m;
    },
    cloud(x, y, z, s) {
      const g = new THREE.Group(); g.position.set(x, y, z);
      for (let k = 0; k < 4; k++) { const m = new THREE.Mesh(puffGeo, cloudMat); m.position.set((k - 1.5) * 0.9 * s, rand(-0.2, 0.3) * s, rand(-0.3, 0.3) * s); m.scale.setScalar(s * rand(0.7, 1.1)); g.add(m); }
      mapGroup.add(g); return g;
    },
    fan(x, y, z) {
      const g = new THREE.Group(); g.position.set(x, y, z);
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.85, 0.05, 20), blockMat(0x2a3346)); g.add(disc);
      const blades = new THREE.Group(); blades.position.y = 0.05; g.add(blades);
      for (let i = 0; i < 3; i++) { const b = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.03, 0.22), blockMat(0xc8d0dc)); b.rotation.y = (i / 3) * Math.PI; blades.add(b); }
      world.updates.push((dt) => { blades.rotation.y += dt * 6; });
      return g;
    },
    tank(x, z) {
      const g = new THREE.Group(); g.position.set(x, 0, z);
      const body = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.4, 2.6, 20), blockMat(0x6b7891)); body.position.y = 1.3; body.castShadow = true; g.add(body);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.5, 0.6, 20), blockMat(0x46557a)); roof.position.y = 2.9; g.add(roof);
      return g;
    },
    sign(x, y, z, color, rotY) {
      const words = ['ZAP', 'BOOM', 'GO!', 'MAX', 'TURBO'];
      const word = words[Math.floor(Math.random() * words.length)];
      const t = canvasTex(256, 200, (g, w, h) => {
        g.fillStyle = '#070b16'; g.fillRect(0, 0, w, h);
        g.strokeStyle = hex(color); g.lineWidth = 10; g.strokeRect(12, 12, w - 24, h - 24);
        g.fillStyle = hex(color); g.font = '900 72px Arial Black, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.shadowColor = hex(color); g.shadowBlur = 20; g.fillText(word, w / 2, h / 2 + 4);
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.2), new THREE.MeshBasicMaterial({ map: t }));
      m.position.set(x, y, z); m.rotation.y = rotY; return m;
    },
    skyscraper(x, z, w, h) {
      if (!windowsTex) windowsTex = tex.windows();
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h + 30, w), new THREE.MeshStandardMaterial({ color: 0x0c1222, emissive: 0xffffff, emissiveMap: windowsTex, emissiveIntensity: 0.85, roughness: 0.9 }));
      m.position.set(x, (h + 30) / 2 - 30, z);
      const top = new THREE.Mesh(new THREE.BoxGeometry(w + 0.2, 0.3, w + 0.2), new THREE.MeshBasicMaterial({ color: [0x22d3ff, 0xff7a1a, 0x9dff2e][Math.floor(Math.random() * 3)] }));
      top.position.y = (h + 30) / 2; m.add(top);
      return m;
    },
    moon(x, y, z) { const m = new THREE.Mesh(new THREE.SphereGeometry(8, 24, 16), new THREE.MeshBasicMaterial({ color: 0xe8f0ff, fog: false })); m.position.set(x, y, z); return m; },
    mixer(x, y, z) {
      const g = new THREE.Group(); g.position.set(x, y, z);
      const vat = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 0.9, 1.3, 20), blockMat(0x9dff2e)); vat.position.y = 0.65; vat.castShadow = true; g.add(vat);
      const paddle = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 0.2), blockMat(0xf4f8ff)); paddle.position.y = 1.5; g.add(paddle);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 1.2), blockMat(0xf4f8ff)); pole.position.y = 1.8; g.add(pole);
      world.updates.push((dt) => { paddle.rotation.y += dt * 2; });
      return g;
    },
    gumdrop(x, z, color) {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1.35, 20, 14, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color, roughness: 0.3 }));
      m.position.set(x, 0, z); m.scale.y = 1.45; m.castShadow = true; return m;
    },
    lollipop(x, y, z, color) {
      const t = canvasTex(128, 128, (g) => {
        g.fillStyle = '#f4f8ff'; g.fillRect(0, 0, 128, 128); g.strokeStyle = hex(color); g.lineWidth = 12;
        g.beginPath(); for (let a = 0; a < 18; a += 0.1) { const r = a * 3.4; g.lineTo(64 + Math.cos(a) * r, 64 + Math.sin(a) * r); } g.stroke();
      });
      const m = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.6, 0.3, 32), [blockMat(color), new THREE.MeshStandardMaterial({ map: t }), new THREE.MeshStandardMaterial({ map: t })]);
      m.position.set(x, y, z); m.rotation.x = Math.PI / 2; m.castShadow = true;
      world.updates.push((dt) => { m.rotation.z += dt * 0.5; });
      return m;
    },
    pipe(x, y, z, len, color) {
      const g = new THREE.Group(); g.position.set(x, y, z);
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, len, 16), blockMat(color)); p.rotation.z = Math.PI / 2; g.add(p);
      for (let i = -3; i <= 3; i++) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.08, 6, 16), blockMat(0xf4f8ff)); r.position.x = i * len / 7; r.rotation.y = Math.PI / 2; g.add(r); }
      return g;
    },
    island(x, z, w, d, topY) {
      topY = topY || 0;
      ctx.box(x, topY - 3, z, w, 3, d, 0x8a5a36, { edges: false });
      const grass = new THREE.Mesh(new THREE.BoxGeometry(w + 0.12, 0.42, d + 0.12), blockMat(0x58c24a));
      grass.position.set(x, topY - 0.19, z); grass.receiveShadow = true; mapGroup.add(grass);
      const rock = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.62, Math.max(w, d) * 0.55, 7), blockMat(0x6b7280));
      rock.rotation.x = Math.PI; rock.position.set(x, topY - 3 - Math.max(w, d) * 0.275, z); mapGroup.add(rock);
    },
    bridge(x, z, w, d, alongZ) {
      const t = tex.stripes('#a0703c', '#8a5e30', alongZ ? 1 : 8, alongZ ? 8 : 1, false);
      if (!alongZ) t.rotation = 0;
      ctx.box(x, -0.35, z, w, 0.35, d, null, { material: new THREE.MeshStandardMaterial({ map: t, roughness: 0.9 }), edges: false });
      const len = alongZ ? d : w;
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(alongZ ? 0.06 : len, 0.06, alongZ ? len : 0.06), blockMat(0xd9c29a));
        rail.position.set(x + (alongZ ? side * (w / 2) : 0), 0.9, z + (alongZ ? 0 : side * (d / 2))); mapGroup.add(rail);
        for (let i = 0; i <= 4; i++) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.95, 0.12), blockMat(0x6b4a2b));
          const o = -len / 2 + (i / 4) * len;
          post.position.set(x + (alongZ ? side * (w / 2) : o), 0.45, z + (alongZ ? o : side * (d / 2))); mapGroup.add(post);
        }
      }
    },
    pad(x, z, vec) {
      ctx.box(x, 0, z, 1.6, 0.2, 1.6, null, { material: new THREE.MeshStandardMaterial({ color: 0x9dff2e, emissive: 0x9dff2e, emissiveIntensity: 0.6 }), pad: vec });
      const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.7, 4), new THREE.MeshBasicMaterial({ color: 0x9dff2e }));
      arrow.position.set(x, 1.2, z);
      const dir = new V3(vec.x, vec.y, vec.z).normalize();
      arrow.quaternion.setFromUnitVectors(new V3(0, 1, 0), dir);
      mapGroup.add(arrow);
      const t0 = Math.random() * 6;
      world.updates.push(() => { arrow.position.y = 1.2 + Math.sin(state.time * 3 + t0) * 0.15; });
    },
    farIsland(x, y, z) {
      const g = new THREE.Group(); g.position.set(x, y, z);
      const s = rand(4, 7);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(s, s * 0.9, 1, 9), blockMat(0x58c24a)); g.add(top);
      const rock = new THREE.Mesh(new THREE.ConeGeometry(s * 0.9, s * 1.4, 7), blockMat(0x6b7280)); rock.rotation.x = Math.PI; rock.position.y = -s * 0.75; g.add(rock);
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 2.5), blockMat(0x6b4a2b)); trunk.position.y = 1.7; g.add(trunk);
      const leaves = new THREE.Mesh(new THREE.SphereGeometry(1.6, 10, 8), blockMat(0x3fbf3f)); leaves.position.y = 3.6; g.add(leaves);
      return g;
    }
  };

  function loadMap(id) {
    if (world.map && world.map.id === id) return;
    const m = BA.MAPS[id] || BA.MAPS.neon;
    for (const c of mapGroup.children.slice()) {
      mapGroup.remove(c);
      c.traverse((o) => { if (o.geometry && o.geometry !== puffGeo) o.geometry.dispose(); });
    }
    world.boxes = []; world.updates = [];
    world.map = m;
    scene.background.setHex(m.sky); scene.fog.color.setHex(m.sky); scene.fog.near = m.fog[0]; scene.fog.far = m.fog[1];
    hemi.color.setHex(m.hemi[0]); hemi.groundColor.setHex(m.hemi[1]); hemi.intensity = m.hemi[2];
    sun.color.setHex(m.sun[0]); sun.intensity = m.sun[1];
    const spawns = m.build(ctx);
    world.spawns = spawns.map((s) => { const g = C.groundAt(world.boxes, s.x, s.z, 30); return { x: s.x, z: s.z, y: g ? g.y : 0, team: s.team || null }; });
    if (!navCache[m.id]) navCache[m.id] = C.buildNavGraph(world.boxes, Object.assign({ step: 2 }, m.bounds));
    world.nav = navCache[m.id];
  }

  // ======================================================================
  // Effects: tracers, particles, paint splats, blasts, damage numbers
  // ======================================================================
  const tracerGeo = new THREE.CylinderGeometry(1, 1, 1, 6, 1, true);
  tracerGeo.translate(0, 0.5, 0);
  const tracers = [];
  for (let i = 0; i < 64; i++) {
    const m = new THREE.Mesh(tracerGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false }));
    m.visible = false; m.userData.life = 0; scene.add(m); tracers.push(m);
  }
  let tracerIdx = 0;
  const UP = new V3(0, 1, 0);
  function spawnTracer(from, to, color, thick, life) {
    const m = tracers[tracerIdx++ % tracers.length];
    const dir = new V3().subVectors(to, from);
    const len = dir.length(); if (len < 0.05) return;
    m.position.copy(from);
    m.quaternion.setFromUnitVectors(UP, dir.divideScalar(len));
    m.scale.set(thick, len, thick);
    m.material.color.setHex(color); m.material.opacity = 0.9;
    m.userData.life = m.userData.max = life; m.visible = true;
  }

  const partGeo = new THREE.BoxGeometry(1, 1, 1);
  const particles = [];
  for (let i = 0; i < 320; i++) {
    const m = new THREE.Mesh(partGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }));
    m.visible = false; m.userData = { life: 0, max: 1, vel: new V3(), spin: new V3(), size: 0.1, grav: 0, grow: 0 };
    scene.add(m); particles.push(m);
  }
  let partIdx = 0;
  function burst(pos, colors, count, speed, size, life, grav, opts) {
    opts = opts || {};
    for (let i = 0; i < count; i++) {
      const m = particles[partIdx++ % particles.length];
      const u = m.userData;
      m.position.copy(pos);
      u.vel.set(rand(-1, 1), rand(-0.2, 1.2), rand(-1, 1)).normalize().multiplyScalar(speed * rand(0.4, 1));
      u.spin.set(rand(-8, 8), rand(-8, 8), rand(-8, 8));
      u.size = size * rand(0.7, 1.3); u.life = u.max = life * rand(0.7, 1.2); u.grav = grav; u.grow = opts.grow || 0;
      m.material.color.setHex(colors[i % colors.length]);
      m.material.opacity = opts.opacity || 1;
      m.scale.setScalar(u.size); m.visible = true;
    }
  }

  // Expanding blast spheres
  const blasts = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffa21a, transparent: true, depthWrite: false }));
    m.visible = false; m.userData = { life: 0, max: 0.35, r: 1 }; scene.add(m); blasts.push(m);
  }
  let blastIdx = 0;
  function blastFx(pos, radius, color) {
    const m = blasts[blastIdx++ % blasts.length];
    m.position.copy(pos); m.material.color.setHex(color); m.userData.life = m.userData.max = 0.32; m.userData.r = radius; m.visible = true;
    burst(pos, [color, 0xffd60a, 0xffffff, 0x8a97a8], 26, radius * 2.5, 0.16, 0.8, 6);
  }

  // Paint splats on surfaces
  const splatGeo = new THREE.CircleGeometry(1, 14);
  const splats = [];
  for (let i = 0; i < 70; i++) {
    const m = new THREE.Mesh(splatGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.92, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false }));
    m.visible = false; scene.add(m); splats.push(m);
  }
  let splatIdx = 0;
  function paintSplat(point, normal, color, size) {
    const m = splats[splatIdx++ % splats.length];
    m.position.set(point.x + normal.x * 0.02, point.y + normal.y * 0.02, point.z + normal.z * 0.02);
    m.lookAt(point.x + normal.x, point.y + normal.y, point.z + normal.z);
    m.scale.setScalar(size * rand(0.8, 1.2));
    m.rotation.z = Math.random() * 6;
    m.material.color.setHex(color); m.visible = true;
  }

  const fxLayer = $('fx');
  const dmgPool = [];
  for (let i = 0; i < 20; i++) {
    const el = document.createElement('div'); el.className = 'dmg'; el.hidden = true;
    fxLayer.appendChild(el); dmgPool.push({ el, pos: new V3(), life: 0 });
  }
  let dmgIdx = 0;
  function floatNumber(pos, amount, head) {
    const d = dmgPool[dmgIdx++ % dmgPool.length];
    d.pos.copy(pos); d.life = 0.75;
    d.el.textContent = Math.round(amount);
    d.el.className = 'dmg' + (head ? ' head' : '');
    d.el.hidden = false;
  }

  function updateEffects(dt) {
    for (const m of tracers) {
      if (!m.visible) continue;
      m.userData.life -= dt;
      if (m.userData.life <= 0) { m.visible = false; continue; }
      m.material.opacity = 0.9 * (m.userData.life / m.userData.max);
    }
    for (const m of particles) {
      if (!m.visible) continue;
      const u = m.userData;
      u.life -= dt;
      if (u.life <= 0) { m.visible = false; continue; }
      u.vel.y -= u.grav * dt;
      m.position.addScaledVector(u.vel, dt);
      if (u.grav > 0 && m.position.y < -20) { m.visible = false; continue; }
      m.rotation.x += u.spin.x * dt; m.rotation.y += u.spin.y * dt; m.rotation.z += u.spin.z * dt;
      const k = u.grow ? 1 + (1 - u.life / u.max) * u.grow : Math.min(1, u.life / (u.max * 0.4));
      m.scale.setScalar(u.size * k);
      if (u.grow) m.material.opacity = 0.6 * (u.life / u.max);
    }
    for (const m of blasts) {
      if (!m.visible) continue;
      const u = m.userData; u.life -= dt;
      if (u.life <= 0) { m.visible = false; continue; }
      const k = 1 - u.life / u.max;
      m.scale.setScalar(u.r * (0.3 + 0.7 * k)); m.material.opacity = 0.75 * (1 - k);
    }
    const w = window.innerWidth, h = window.innerHeight;
    const p = new V3();
    for (const d of dmgPool) {
      if (d.el.hidden) continue;
      d.life -= dt;
      if (d.life <= 0) { d.el.hidden = true; continue; }
      d.pos.y += dt * 1.2;
      p.copy(d.pos).project(camera);
      if (p.z > 1) { d.el.style.opacity = 0; continue; }
      d.el.style.opacity = Math.min(1, d.life * 3);
      d.el.style.transform = `translate(${(p.x * 0.5 + 0.5) * w}px, ${(-p.y * 0.5 + 0.5) * h}px) translate(-50%,-50%)`;
    }
    for (const u of world.updates) u(dt);
  }

  // ======================================================================
  // Fighters
  // ======================================================================
  const BOT_NAMES = ['Bolt', 'Rex', 'Jax', 'Ace', 'Turbo', 'Blitz', 'Kai', 'Zane', 'Rocco', 'Nova'];
  const markerMats = {
    enemy: new THREE.MeshBasicMaterial({ color: 0xff3b1f }),
    enemyTeam: new THREE.MeshBasicMaterial({ color: 0xff7a1a }),
    cb: new THREE.MeshBasicMaterial({ color: 0xffd60a }),
    ally: new THREE.MeshBasicMaterial({ color: 0x2f7bff, depthTest: false, transparent: true, opacity: 0.9 })
  };

  function makeFighter(o) {
    const f = {
      id: o.id, name: o.name, isPlayer: !!o.isPlayer, team: o.team || null, color: o.color || 0xffffff,
      pos: new V3(), vel: new V3(), radius: 0.42, height: o.isPlayer ? 1.7 : 1.8, grounded: false, groundBox: null,
      yaw: 0, pitch: 0, eye: 1.55, health: C.MAX_HEALTH, alive: true, respawnT: 0, shieldT: 0, lastHurt: -99,
      weaponIds: o.weaponIds, wIndex: o.wIndex || 0, ammo: {}, reloadT: 0, cool: 0, swapT: 0, charge: 0,
      jumpsLeft: 1, dashT: 0, dashCd: 0, dashDir: new V3(), slideT: 0, slideCd: 0, slideDir: new V3(), crouching: false,
      ads: false, recoilAcc: 0, stepT: 0, hitFlash: 0, walkPhase: 0, lastAttacker: null, padCd: 0, airCap: 6.4,
      ai: { think: 0, target: null, seenT: 0, lastSeen: new V3(), hasLast: false, path: null, pi: 0, repath: 0, goal: null,
        strafeT: 0, strafeDir: 1, stuckT: 0, burst: 0, pause: 0, charge: -1 },
      mesh: null
    };
    f.weaponIds.forEach((id) => { f.ammo[id] = C.WEAPONS[id].mag; });
    if (!f.isPlayer) {
      f.mesh = BA.buildCharacter(o.outfit || BA.randomOutfit(), { weapon: f.weaponIds[0] });
      f.color = BA.OUTFIT.shirts[f.mesh.outfit.shirt];
      if (f.team) { f.mesh.teamBand.visible = true; f.mesh.teamBand.material = new THREE.MeshStandardMaterial({ color: TEAM_COLOR[f.team], emissive: TEAM_COLOR[f.team], emissiveIntensity: 0.4 }); }
      scene.add(f.mesh.group);
    }
    return f;
  }

  const weaponOf = (f) => C.WEAPONS[f.weaponIds[f.wIndex]];
  const eyePos = (f, out) => out.set(f.pos.x, f.pos.y + (f.isPlayer ? f.eye : f.remote ? (f.crouching ? 0.88 : 1.55) : 1.4), f.pos.z);
  const headCenter = (f) => (f.isPlayer || f.remote ? C.playerHead(f.pos, f.height) : { x: f.pos.x, y: f.pos.y + 1.38, z: f.pos.z });
  const bodyBox = (f) => {
    if (f.isPlayer || f.remote) return C.playerBody(f.pos, f.height);
    return { min: { x: f.pos.x - 0.46, y: f.pos.y, z: f.pos.z - 0.46 }, max: { x: f.pos.x + 0.46, y: f.pos.y + 1.05, z: f.pos.z + 0.46 } };
  };
  const isEnemy = (a, b) => a !== b && (!a.team || a.team !== b.team);
  const displayName = (f) => (f.isPlayer ? 'You' : f.name);
  const nameColor = (f) => (f.team ? TEAM_COLOR[f.team] : f.isPlayer ? 0xffd60a : f.color);

  // ======================================================================
  // Player viewmodels (one per weapon)
  // ======================================================================
  const vm = new THREE.Group();
  vmScene.add(vm);
  const VM_BASE = new V3(0.28, -0.27, -0.55);
  let vmKick = 0, vmSwap = 0, vmBob = 0, vmBow = null;
  function vmMat(c, glow) { return glow ? new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.7 }) : blockMat(c); }
  function buildViewmodel(id) {
    while (vm.children.length) vm.remove(vm.children[0]);
    vmBow = null;
    const B = (w, h, d, c, x, y, z, glow) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), vmMat(c, glow)); m.position.set(x, y, z); vm.add(m); return m; };
    const Cy = (r1, r2, len, c, x, y, z, glow) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, len, 14), vmMat(c, glow)); m.rotation.x = Math.PI / 2; m.position.set(x, y, z); vm.add(m); return m; };
    const grip = (c) => B(0.08, 0.17, 0.1, c || 0x0b1426, 0, -0.13, 0.1);
    switch (id) {
      case 'laser':
        B(0.12, 0.14, 0.44, 0xdfe6ee, 0, 0, 0); grip(); B(0.13, 0.04, 0.22, 0xff7a1a, 0, 0.085, -0.02);
        Cy(0.035, 0.035, 0.28, 0x22d3ff, 0, 0.01, -0.34, true); break;
      case 'scatter':
        B(0.17, 0.16, 0.4, 0xff7a1a, 0, 0, 0); grip();
        Cy(0.065, 0.075, 0.22, 0x2f7bff, 0, 0.01, -0.3); B(0.18, 0.05, 0.12, 0x0b1426, 0, -0.1, -0.15); break;
      case 'dart':
        B(0.13, 0.15, 0.42, 0x2f7bff, 0, 0, 0); grip(); B(0.08, 0.16, 0.1, 0xff7a1a, 0, -0.12, -0.12);
        Cy(0.04, 0.04, 0.24, 0xdfe6ee, 0, 0.02, -0.32); Cy(0.025, 0.025, 0.06, 0xff7a1a, 0, 0.02, -0.46); break;
      case 'paintball': {
        B(0.14, 0.14, 0.4, 0x23262e, 0, 0, 0); grip(0x3fbf3f);
        const hop = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 10), vmMat(0x9dff2e)); hop.position.set(0, 0.15, -0.02); vm.add(hop);
        Cy(0.05, 0.05, 0.2, 0x8a97a8, 0, 0.01, -0.3); break;
      }
      case 'precision':
        B(0.1, 0.13, 0.62, 0x23262e, 0, 0, -0.06); grip(); B(0.11, 0.03, 0.4, 0xff2d2d, 0, 0.075, -0.06);
        Cy(0.045, 0.045, 0.24, 0x5a6478, 0, 0.13, -0.05); Cy(0.02, 0.02, 0.32, 0x8a97a8, 0, 0.01, -0.52); break;
      case 'rapid':
        B(0.15, 0.15, 0.4, 0xffd60a, 0, 0, 0); grip(); B(0.08, 0.2, 0.12, 0x23262e, 0, -0.16, -0.1);
        for (const [x, y] of [[-0.035, 0.03], [0.035, 0.03], [0, -0.03]]) Cy(0.02, 0.02, 0.26, 0x23262e, x, y, -0.32); break;
      case 'rocket':
        Cy(0.09, 0.09, 0.75, 0x4b5d3a, 0, 0.02, -0.1); grip(0x23262e);
        Cy(0.1, 0.1, 0.06, 0xffd60a, 0, 0.02, -0.46); Cy(0.05, 0.08, 0.14, 0xff3b1f, 0, 0.02, -0.5, true); break;
      case 'bow': {
        const holder = new THREE.Group(); holder.position.set(-0.05, 0.02, -0.25); vm.add(holder);
        const arcG = new THREE.Group(); arcG.rotation.y = Math.PI / 2; holder.add(arcG);
        const arc = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.022, 8, 28, Math.PI), vmMat(0x7c5cff, true)); arc.rotation.z = -Math.PI / 2; arcG.add(arc);
        const gripB = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.06), vmMat(0x0b1426)); gripB.position.set(0, 0, -0.32); holder.add(gripB);
        const string = new THREE.Mesh(new THREE.BoxGeometry(0.008, 0.64, 0.008), new THREE.MeshBasicMaterial({ color: 0xc8f7ff })); holder.add(string);
        const arrow = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.6, 8), vmMat(0x9dff2e, true)); arrow.rotation.x = Math.PI / 2; holder.add(arrow);
        vmBow = { string, arrow };
        break;
      }
    }
  }

  // ======================================================================
  // Game state
  // ======================================================================
  const state = { phase: 'menu', screen: 'menu', countdown: 0, lastBeep: 0, time: 0, menuAngle: 0, practiceScore: 0, matchShots: 0, matchHits: 0, endT: null, shake: 0 };
  // Online: net is replaced by online.js when a server connection exists.
  let net = { send() {} };
  let fighters = [];
  let player = null;
  let match = null;
  let targets = [];
  const projectiles = [];

  function clearMatchObjects() {
    for (const f of fighters) if (f.mesh) scene.remove(f.mesh.group);
    for (const t of targets) scene.remove(t.mesh);
    for (const p of projectiles) { p.active = false; for (const k in p.meshes) p.meshes[k].visible = false; }
    fighters = []; targets = []; player = null;
    for (const arr of [particles, tracers, splats, blasts]) for (const m of arr) m.visible = false;
    for (const d of dmgPool) d.el.hidden = true;
    $('killfeed').innerHTML = '';
  }

  function respawn(f) {
    if (f.isPlayer && match.mode.id === 'practice') {
      f.pos.set(0, 0, 24); f.yaw = 0;
    } else {
      let pool = world.spawns.filter((s) => (f.team ? s.team === f.team : true));
      if (!pool.length) pool = world.spawns;
      const threats = fighters.filter((o) => o.alive && isEnemy(f, o)).map((o) => o.pos);
      const s = C.pickSpawn(pool, threats);
      f.pos.set(s.x, s.y + 0.05, s.z);
      f.yaw = Math.atan2(s.x, s.z);
    }
    f.vel.set(0, 0, 0); f.pitch = 0; f.health = C.MAX_HEALTH; f.alive = true; f.shieldT = 1.2;
    f.weaponIds.forEach((id) => { f.ammo[id] = C.WEAPONS[id].mag; });
    f.reloadT = 0; f.cool = 0.3; f.dashT = 0; f.slideT = 0; f.crouching = false; f.charge = 0; f.height = f.isPlayer ? 1.7 : 1.8;
    f.lastAttacker = null; f.lastHurt = -99;
    f.ai.target = null; f.ai.hasLast = false; f.ai.path = null; f.ai.charge = -1;
    if (f.mesh) f.mesh.group.visible = true;
    if (f.isPlayer) { $('deathOverlay').hidden = true; buildViewmodel(f.weaponIds[f.wIndex]); }
  }

  function startMatch(modeId) {
    Sfx.unlock();
    clearMatchObjects();
    const s = store.settings;
    s.mode = modeId; persist();
    const mode = C.MODES[modeId];
    loadMap(modeId === 'practice' ? 'yard' : s.map);
    const pIds = modeId === 'practice' ? C.WEAPON_ORDER.slice() : s.loadout.slice();
    const pIndex = modeId === 'practice' ? Math.max(0, C.WEAPON_ORDER.indexOf(s.loadout[0])) : 0;
    const ids = ['you'];
    const nBots = C.botCount(mode);
    for (let i = 0; i < nBots; i++) ids.push('bot' + i);
    const teamOf = mode.teams ? C.balanceTeams(ids) : null;
    player = makeFighter({ id: 'you', name: 'You', isPlayer: true, team: teamOf ? teamOf.you : null, weaponIds: pIds, wIndex: pIndex });
    fighters.push(player);
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < nBots; i++) {
      const weapon = C.WEAPON_ORDER[Math.floor(Math.random() * C.WEAPON_ORDER.length)];
      fighters.push(makeFighter({ id: 'bot' + i, name: names[i % names.length], team: teamOf ? teamOf['bot' + i] : null, weaponIds: [weapon] }));
    }
    match = C.createMatch(modeId, ids, teamOf);
    fighters.forEach(respawn);
    if (modeId === 'practice') { spawnTargets(); state.practiceScore = 0; }
    state.matchShots = 0; state.matchHits = 0; state.endT = null;
    state.phase = 'countdown'; state.countdown = 3.0; state.lastBeep = 4;
    showScreen(null);
    $('hud').hidden = false;
    $('touch').hidden = !isTouch;
    touch.aimOn = false; touch.crouchOn = false;
    $('tAim').classList.remove('on'); $('tCrouch').classList.remove('on');
    tryLock();
    hudCache = {};
  }

  function endMatch() {
    state.phase = 'results';
    releaseLock();
    const st = store.stats, mode = match.mode;
    st.shots += state.matchShots; st.hits += state.matchHits;
    const acc = state.matchShots ? Math.round((state.matchHits / state.matchShots) * 100) : 0;
    let title, sub;
    if (mode.id === 'practice') {
      const best = st.bestPractice < state.practiceScore;
      if (best) st.bestPractice = state.practiceScore;
      title = best ? 'New best!' : 'Time!';
      sub = `${state.practiceScore} points · ${state.matchHits} targets · ${acc}% accuracy`;
      Sfx.win(); celebrate();
    } else {
      st.matches++;
      const me = match.scores.you;
      st.kills += me.kills; st.deaths += me.deaths;
      const won = mode.teams ? match.winnerTeam === player.team : match.winnerId === 'you';
      const draw = mode.teams ? match.winnerTeam === null : match.winnerId === null;
      if (won) { st.wins++; title = 'Victory!'; Sfx.win(); celebrate(); }
      else if (draw) { title = 'Draw!'; Sfx.lose(); }
      else { title = 'Defeat'; Sfx.lose(); }
      if (mode.teams) sub = `Blue ${match.teamScores.blue} – ${match.teamScores.orange} Orange`;
      else {
        const winner = fighters.find((f) => f.id === match.winnerId);
        sub = match.reason === 'time' ? 'Time ran out' : `${winner ? displayName(winner) : '—'} reached ${mode.scoreLimit} blasts`;
      }
      sub += ` · ${me.kills} blasts · ${acc}% accuracy`;
    }
    persist();
    $('resultTitle').textContent = title;
    $('resultTitle').className = 'result-title ' + (title === 'Defeat' ? 'lose' : 'win');
    $('resultSub').textContent = sub;
    const rows = $('resultRows');
    rows.innerHTML = '';
    if (mode.id !== 'practice') {
      C.standings(match).forEach((r, i) => {
        const f = fighters.find((x) => x.id === r.id);
        const tr = document.createElement('tr');
        if (f.isPlayer) tr.className = 'me';
        const td = (t) => { const c = document.createElement('td'); c.textContent = t; return c; };
        tr.appendChild(td(String(i + 1)));
        const nameTd = document.createElement('td');
        const dot = document.createElement('span'); dot.className = 'dot'; dot.style.background = hex(nameColor(f));
        nameTd.append(dot, displayName(f) + (f.team ? ` (${TEAM_NAME[f.team]})` : ''));
        tr.appendChild(nameTd); tr.appendChild(td(String(r.kills))); tr.appendChild(td(String(r.deaths)));
        rows.appendChild(tr);
      });
    }
    $('resultTable').hidden = mode.id === 'practice';
    $('deathOverlay').hidden = true; $('hud').hidden = true; $('touch').hidden = true; $('scope').hidden = true;
    showScreen('results');
    renderStats();
  }

  function celebrate() {
    const p = new V3();
    camera.getWorldDirection(p);
    p.multiplyScalar(3).add(camera.position);
    burst(p, SPARKS, 70, 6, 0.09, 1.8, 6);
  }

  // ======================================================================
  // Shooting, projectiles & damage
  // ======================================================================
  const tmpA = new V3(), tmpB = new V3();

  function hasLOS(a, b) {
    const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 0.01) return true;
    d.x /= len; d.y /= len; d.z /= len;
    for (const box of world.boxes) if (C.rayAABB(a, d, box) < len - 0.05) return false;
    return true;
  }

  function muzzleWorld(f, out) {
    if (f.isPlayer) out.set(0.22, -0.2, -0.9).applyQuaternion(camera.quaternion).add(camera.position);
    else f.mesh.tip.getWorldPosition(out);
    return out;
  }

  /** Nearest thing a ray hits within maxDist: { t, fighter, head, target, box }. */
  function castRay(origin, d, maxDist, shooter) {
    let best = maxDist, hitF = null, head = false, hitT = null, hitBox = null;
    for (const b of world.boxes) { const t = C.rayAABB(origin, d, b); if (t < best) { best = t; hitBox = b; } }
    for (const o of fighters) {
      if (o === shooter || !o.alive || !isEnemy(shooter, o)) continue;
      const th = C.raySphere(origin, d, headCenter(o), 0.4);
      if (th < best) { best = th; hitF = o; head = true; hitT = null; hitBox = null; }
      const tb = C.rayAABB(origin, d, bodyBox(o));
      if (tb < best) { best = tb; hitF = o; head = false; hitT = null; hitBox = null; }
    }
    for (const t of targets) {
      if (!t.alive) continue;
      const tt = C.raySphere(origin, d, t.mesh.position, 0.65);
      if (tt < best) { best = tt; hitT = t; hitF = null; hitBox = null; }
    }
    return { t: best, fighter: hitF, head, target: hitT, box: hitBox };
  }

  function fireHitscan(f, origin, baseDir, ads, seed) {
    const w = weaponOf(f);
    const muzzle = muzzleWorld(f, new V3());
    const victims = new Map();
    let popped = false;
    const dirs = state.online ? C.pelletDirs(w, baseDir, ads, seed) : null;
    for (let p = 0; p < w.pellets; p++) {
      const d = dirs ? dirs[p] : C.spreadDir(baseDir, ads ? w.adsSpread : w.spread);
      const hit = castRay(origin, d, w.range, f);
      const end = new V3(origin.x + d.x * hit.t, origin.y + d.y * hit.t, origin.z + d.z * hit.t);
      const thick = w.id === 'precision' ? 0.05 : w.id === 'laser' ? 0.035 : w.id === 'rapid' ? 0.018 : 0.022;
      spawnTracer(muzzle, end, w.color, thick, w.id === 'precision' ? 0.22 : 0.09);
      if (hit.fighter && state.online) burst(end, [0xffffff, w.color], 3, 2.5, 0.07, 0.3, 4); // server decides damage
      else if (hit.fighter) {
        const v = victims.get(hit.fighter) || { dmg: 0, head: false, point: end };
        v.dmg += C.damageAt(w, hit.t) * (hit.head ? (w.headMult || C.HEAD_MULTIPLIER) : 1);
        v.head = v.head || hit.head;
        victims.set(hit.fighter, v);
      } else if (hit.target) { popTarget(hit.target, hit.t); popped = true; }
      else if (hit.t < w.range) burst(end, [w.color, 0xffffff], w.pellets > 1 ? 2 : 4, 2.5, 0.07, 0.3, 4);
    }
    victims.forEach((v, victim) => applyDamage(victim, v.dmg, f, v.head, v.point));
    return victims.size > 0 || popped;
  }

  // --- Projectiles ---
  function projMesh(type, color) {
    let m;
    if (type === 'paintball') m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), new THREE.MeshBasicMaterial({ color }));
    else if (type === 'rocket') {
      m = new THREE.Group();
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.45, 10), blockMat(0xdfe6ee)); body.rotation.x = Math.PI / 2; m.add(body);
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.18, 10), new THREE.MeshBasicMaterial({ color: 0xff3b1f })); nose.rotation.x = -Math.PI / 2; nose.position.z = -0.3; m.add(nose);
    } else if (type === 'bow') m = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.05, 0.7), new THREE.MeshBasicMaterial({ color: 0x9dff2e }));
    else {
      m = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.26), new THREE.MeshBasicMaterial({ color: 0x2f7bff })); m.add(shaft);
      const tip = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.075, 0.07), new THREE.MeshBasicMaterial({ color: 0xff7a1a })); tip.position.z = -0.15; m.add(tip);
    }
    m.visible = false; scene.add(m);
    return m;
  }
  function spawnProjectile(f, origin, dir, opts) {
    const w = opts.weapon || weaponOf(f);
    let p = projectiles.find((x) => !x.active);
    if (!p) { if (projectiles.length >= 80) return; p = { meshes: {}, pos: new V3(), vel: new V3() }; projectiles.push(p); }
    const speed = opts.speed || w.speed;
    p.active = true; p.owner = f; p.w = w; p.damage = opts.damage || w.damage; p.life = w.range / speed + 0.5;
    p.visual = !!state.online; p.pid = opts.pid || 0;
    p.pos.set(origin.x + dir.x * 0.6, origin.y + dir.y * 0.6, origin.z + dir.z * 0.6);
    p.vel.set(dir.x * speed, dir.y * speed, dir.z * speed);
    p.color = opts.color != null ? opts.color : w.id === 'paintball' ? (f.team ? TEAM_COLOR[f.team] : [0x9dff2e, 0x22d3ff, 0xff7a1a, 0xffd60a][opts.seed != null ? opts.seed % 4 : Math.floor(Math.random() * 4)]) : w.color;
    if (opts.vel) { p.pos.set(origin.x, origin.y, origin.z); p.vel.set(opts.vel.x, opts.vel.y, opts.vel.z); }
    p.visualOffset = f.isPlayer || f.mesh ? muzzleWorld(f, new V3()).sub(p.pos) : new V3();
    for (const k in p.meshes) p.meshes[k].visible = false;
    if (!p.meshes[w.id]) p.meshes[w.id] = projMesh(w.id, p.color);
    p.mesh = p.meshes[w.id];
    if (w.id === 'paintball') p.mesh.material.color.setHex(p.color);
    p.mesh.visible = true;
    p.trailT = 0;
  }

  const segDir = new V3(), tmpEnd = new V3();
  function updateProjectiles(dt) {
    for (const p of projectiles) {
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { if (p.w.splash) explode(p.pos.clone(), p.owner, p.w, null, p.color, null, p.visual); deactivate(p); continue; }
      p.vel.y -= (p.w.gravity || 0) * dt;
      segDir.copy(p.vel).multiplyScalar(dt);
      const len = segDir.length();
      segDir.divideScalar(len || 1);
      const hit = castRay(p.pos, segDir, len, p.owner);
      if (hit.t < len) {
        const point = new V3(p.pos.x + segDir.x * hit.t, p.pos.y + segDir.y * hit.t, p.pos.z + segDir.z * hit.t);
        if (p.w.splash) {
          const n = hit.box ? C.boxNormal(point, hit.box) : { x: -segDir.x, y: -segDir.y, z: -segDir.z };
          if (p.w.id === 'paintball' && hit.box) paintSplat(point, n, p.color, 0.8);
          explode(point.add(new V3(n.x * 0.05, n.y * 0.05, n.z * 0.05)), p.owner, p.w, hit.fighter, p.color, null, p.visual);
        } else if (p.visual) {
          burst(point, [p.w.color, 0xffffff], 4, 2, 0.06, 0.3, 4);
        } else if (hit.fighter) {
          applyDamage(hit.fighter, p.damage * (hit.head ? (p.w.headMult || C.HEAD_MULTIPLIER) : 1), p.owner, hit.head, point);
          if (p.owner === player) state.matchHits++;
        } else if (hit.target) {
          popTarget(hit.target, p.owner.pos.distanceTo(point));
          if (p.owner === player) state.matchHits++;
        } else {
          burst(point, [p.w.color, 0xffffff], 4, 2, 0.06, 0.3, 4);
        }
        deactivate(p);
        continue;
      }
      p.pos.addScaledVector(segDir, len);
      // Blend the visual from the muzzle to the true path over the first moments of flight
      p.visualOffset.multiplyScalar(Math.max(0, 1 - dt * 10));
      p.mesh.position.copy(p.pos).add(p.visualOffset);
      tmpEnd.copy(p.mesh.position).add(p.vel);
      p.mesh.lookAt(tmpEnd);
      p.trailT -= dt;
      if (p.trailT <= 0) {
        if (p.w.id === 'rocket') { p.trailT = 0.025; burst(p.mesh.position, [0xdfe6ee, 0xb8c2cf, 0xffa21a], 1, 0.4, 0.22, 0.6, -1, { grow: 2, opacity: 0.6 }); }
        else if (p.w.id === 'bow') { p.trailT = 0.03; burst(p.mesh.position, [0x9dff2e, 0x7c5cff], 1, 0.2, 0.07, 0.3, 0); }
      }
    }
  }
  function deactivate(p) { p.active = false; p.mesh.visible = false; }

  function explode(point, owner, w, direct, color, normal, visualOnly) {
    blastFx(point, w.splash, w.id === 'rocket' ? 0xff7a1a : (color || w.color));
    if (normal && w.id === 'paintball') paintSplat(point, normal, color || w.color, 0.8);
    if (w.id === 'paintball') {
      Sfx.splat(volumeAt(point));
      const g = C.groundAt(world.boxes, point.x, point.z, point.y + 0.3);
      if (g && point.y - g.y < 1.2) paintSplat(new V3(point.x, g.y, point.z), { x: 0, y: 1, z: 0 }, color || w.color, 1.1);
    } else Sfx.boom(volumeAt(point));
    const pd = player && player.alive ? player.pos.distanceTo(point) : 99;
    if (pd < 12) state.shake = Math.max(state.shake, (1 - pd / 12) * (w.id === 'rocket' ? 0.5 : 0.15));
    if (visualOnly) return;
    let ownerHit = false;
    for (const f of fighters) {
      if (!f.alive) continue;
      if (f !== owner && !isEnemy(owner, f)) continue;
      const center = new V3(f.pos.x, f.pos.y + f.height * 0.5, f.pos.z);
      const d = f === direct ? 0 : Math.max(0, center.distanceTo(point) - 0.45);
      if (d > w.splash) continue;
      if (f !== direct && !hasLOS(point, center)) continue;
      let dmg = C.splashDamage(w, d);
      const self = f === owner;
      if (self) dmg *= w.selfScale || 0;
      const k = (w.knockback || 0) * (1 - d / w.splash) * (self ? 1.1 : 1);
      if (k > 0 && (!self || w.selfScale > 0)) {
        const push = new V3().subVectors(center, point); push.y = Math.max(push.y, 0) + 0.5; push.normalize().multiplyScalar(k);
        f.vel.add(push); f.grounded = false; f.airCap = Math.max(f.airCap, Math.hypot(f.vel.x, f.vel.z));
        if (!self) { f.lastAttacker = owner; f.lastHurt = state.time; }
      }
      if (dmg > 0) { applyDamage(f, dmg, owner, false, center); if (!self) ownerHit = true; }
    }
    for (const t of targets) if (t.alive && t.mesh.position.distanceTo(point) < w.splash) { popTarget(t, owner.pos.distanceTo(point)); ownerHit = true; }
    if (ownerHit && owner === player) state.matchHits++;
  }

  function volumeAt(point) { return player ? clamp(1 - player.pos.distanceTo(point) / 60, 0.08, 1) : 0.3; }

  /** Fires the fighter's current weapon. charge (0..1) is for the bow. Returns true if a hitscan hit landed. */
  function shoot(f, origin, dir, ads, charge, seed) {
    const w = weaponOf(f);
    if (w.type === 'hitscan') return fireHitscan(f, origin, dir, ads, seed);
    const rng = seed != null ? C.makeRng(seed) : undefined; // same spread as the server online
    if (w.chargeTime) {
      const b = C.bowShot(w, charge);
      spawnProjectile(f, origin, C.spreadDir(dir, ads ? Math.min(b.spread, w.adsSpread) : b.spread, rng), { speed: b.speed, damage: b.damage, seed });
    } else {
      spawnProjectile(f, origin, C.spreadDir(dir, ads ? w.adsSpread : w.spread, rng), { seed });
    }
    return false;
  }

  function applyDamage(victim, amount, attacker, head, point) {
    if (state.online || !victim.alive || state.phase !== 'play') return;
    if (victim.shieldT > 0) amount = 0;
    if (attacker.isPlayer && victim !== attacker) {
      showHitmarker(head, amount === 0);
      if (amount > 0) { Sfx.hit(head); floatNumber(point, amount, head); }
    }
    if (amount <= 0) return;
    victim.health -= amount;
    victim.lastHurt = state.time;
    if (victim !== attacker) victim.lastAttacker = attacker;
    victim.hitFlash = 0.12;
    if (victim.isPlayer) { Sfx.hurt(); if (victim !== attacker) hurtFlash(attacker); }
    else if (victim !== attacker && (!victim.ai.target || !victim.ai.target.alive)) victim.ai.target = attacker;
    burst(point, [0xffffff, victim.team ? TEAM_COLOR[victim.team] : 0xffd60a], 5, 3, 0.07, 0.35, 5);
    if (victim.health <= 0) eliminate(victim, victim === attacker ? null : attacker);
  }

  /** attacker may be null (fell off / own blast). */
  function eliminate(victim, attacker) {
    if (!victim.alive) return;
    victim.health = 0; victim.alive = false;
    victim.respawnT = match.mode.respawn;
    const center = new V3(victim.pos.x, Math.max(victim.pos.y, -10) + 1, victim.pos.z);
    burst(center, SPARKS.concat([victim.color]), 36, 7, 0.12, 1.4, 12);
    if (victim.mesh) victim.mesh.group.visible = false;
    C.recordElimination(match, attacker ? attacker.id : null, victim.id);
    addKillfeed(attacker, victim);
    if (attacker && attacker.isPlayer) { Sfx.elim(); banner(`Blasted ${victim.name}!`); }
    else if (victim.isPlayer) Sfx.pop();
    if (victim.isPlayer) {
      $('deathBy').textContent = attacker ? `Blasted by ${attacker.name}` : 'You took a tumble!';
      $('deathOverlay').hidden = false;
      $('hurt').style.opacity = 0; $('scope').hidden = true;
    }
  }

  function checkFall(f) {
    const voidY = world.map.voidY;
    if (state.online) {
      // The server decides falls online. Stop the fall far below so the camera doesn't drift forever.
      if (voidY != null && f.pos.y < voidY - 25) { f.pos.y = voidY - 25; f.vel.set(0, 0, 0); }
      if (voidY == null && (f.pos.y < -10 || Math.abs(f.pos.x) > 45 || Math.abs(f.pos.z) > 45) && state.time - (state.stuckAt || 0) > 1) { state.stuckAt = state.time; net.send({ t: 'stuck' }); }
      return false;
    }
    if (voidY != null && f.pos.y < voidY) {
      // Knocked off by someone in the last 6 seconds? They get the point.
      const credit = f.lastAttacker && f.lastAttacker !== f && state.time - f.lastHurt < 6 ? f.lastAttacker : null;
      eliminate(f, credit);
      return true;
    }
    if (voidY == null && (f.pos.y < -10 || Math.abs(f.pos.x) > 45 || Math.abs(f.pos.z) > 45)) { respawn(f); return true; }
    return false;
  }

  // ======================================================================
  // Target practice
  // ======================================================================
  const targetGeo = new THREE.SphereGeometry(0.6, 20, 14);
  const ringGeo = new THREE.TorusGeometry(0.62, 0.07, 8, 24);
  function spawnTargets() {
    for (let i = 0; i < 7; i++) {
      const g = new THREE.Group();
      const ball = new THREE.Mesh(targetGeo, blockMat([0xff7a1a, 0x22d3ff, 0x9dff2e, 0xffd60a, 0x2f7bff][i % 5])); ball.castShadow = true; g.add(ball);
      g.add(new THREE.Mesh(ringGeo, blockMat(0xffffff)));
      const bull = new THREE.Mesh(new THREE.CircleGeometry(0.22, 18), new THREE.MeshBasicMaterial({ color: 0xffffff })); bull.position.z = 0.6; g.add(bull);
      scene.add(g);
      const t = { mesh: g, base: new V3(), alive: true, respawnT: 0, amp: 0, speed: 0, phase: Math.random() * 6 };
      placeTarget(t); targets.push(t);
    }
  }
  function placeTarget(t) {
    for (let tries = 0; tries < 30; tries++) {
      t.base.set(rand(-18, 18), rand(1.2, 5), rand(-26, 10));
      if (!C.anyOverlap({ x: t.base.x, y: t.base.y - 0.7, z: t.base.z }, 1.2, 1.4, world.boxes)) break;
    }
    t.amp = Math.random() < 0.5 ? rand(1.5, 3.5) : 0;
    t.speed = rand(0.8, 1.8);
    t.alive = true; t.mesh.visible = true;
  }
  function popTarget(t, dist) {
    if (!t.alive) return;
    t.alive = false; t.mesh.visible = false; t.respawnT = 0.5;
    const pts = 10 + Math.round(dist / 2) + (t.amp ? 5 : 0);
    state.practiceScore += pts;
    burst(t.mesh.position.clone(), SPARKS, 22, 6, 0.1, 1, 10);
    floatNumber(t.mesh.position.clone(), pts, t.amp > 0);
    Sfx.pop();
  }
  function updateTargets(dt) {
    for (const t of targets) {
      if (!t.alive) { t.respawnT -= dt; if (t.respawnT <= 0) placeTarget(t); continue; }
      t.phase += dt * t.speed;
      t.mesh.position.set(t.base.x + Math.sin(t.phase) * t.amp, t.base.y + Math.sin(t.phase * 1.7) * 0.25, t.base.z);
      if (player) t.mesh.lookAt(camera.position.x, t.mesh.position.y, camera.position.z);
    }
  }

  // ======================================================================
  // Input: keyboard + mouse, touch, gamepad
  // ======================================================================
  const keys = new Set(), pressed = new Set();
  const GAME_KEYS = new Set(['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ControlLeft', 'KeyC', 'KeyQ', 'KeyR', 'KeyE', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8']);
  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (GAME_KEYS.has(e.code) && (state.phase === 'play' || state.phase === 'countdown')) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code); pressed.add(e.code);
    if (e.code === 'KeyP' || (e.code === 'Escape' && !document.pointerLockElement)) togglePause();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => { keys.clear(); mouse.l = mouse.r = false; if (state.phase === 'play') pauseGame(); });

  const mouse = { dx: 0, dy: 0, l: false, r: false, wheel: false };
  let lockWanted = false;
  function tryLock() {
    if (isTouch || !canvas.requestPointerLock) return;
    lockWanted = true;
    try { const r = canvas.requestPointerLock(); if (r && r.catch) r.catch(() => { lockWanted = false; }); }
    catch (e) { lockWanted = false; }
  }
  function releaseLock() { lockWanted = false; if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock(); }
  document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && lockWanted && state.phase === 'play') pauseGame(); });
  document.addEventListener('pointerlockerror', () => { lockWanted = false; });
  canvas.addEventListener('mousedown', (e) => {
    if (isTouch) return;
    if ((state.phase === 'play' || state.phase === 'countdown') && !document.pointerLockElement) tryLock();
    if (e.button === 0) mouse.l = true;
    if (e.button === 2) mouse.r = true;
  });
  window.addEventListener('mouseup', (e) => { if (e.button === 0) mouse.l = false; if (e.button === 2) mouse.r = false; });
  window.addEventListener('mousemove', (e) => {
    if (isTouch) return;
    if (document.pointerLockElement || mouse.l || mouse.r) { mouse.dx += e.movementX || 0; mouse.dy += e.movementY || 0; }
  });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => { if (state.phase === 'play') { mouse.wheel = true; e.preventDefault(); } }, { passive: false });

  // --- Touch ---
  const touch = { joyId: null, ox: 0, oy: 0, mx: 0, my: 0, look: new Map(), lookDX: 0, lookDY: 0, fire: 0, aimOn: false, crouchOn: false, pressed: new Set() };
  const joyBase = $('joyBase'), joyKnob = $('joyKnob');
  function trackLook(e) { touch.look.set(e.pointerId, { x: e.clientX, y: e.clientY }); }
  $('joyZone').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (touch.joyId !== null) return;
    touch.joyId = e.pointerId; touch.ox = e.clientX; touch.oy = e.clientY;
    joyBase.style.left = e.clientX + 'px'; joyBase.style.top = e.clientY + 'px';
    joyBase.classList.add('on');
  });
  $('lookZone').addEventListener('pointerdown', (e) => { e.preventDefault(); trackLook(e); });
  for (const id of ['tFire', 'tFireL']) {
    $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); touch.fire++; $(id).classList.add('down'); trackLook(e); $(id).dataset.pid = e.pointerId; });
  }
  const tapButtons = { tJump: 'jump', tDash: 'dash', tReload: 'reload', tSwap: 'swap' };
  for (const id in tapButtons) $(id).addEventListener('pointerdown', (e) => { e.preventDefault(); touch.pressed.add(tapButtons[id]); $(id).classList.add('down'); });
  $('tAim').addEventListener('pointerdown', (e) => { e.preventDefault(); touch.aimOn = !touch.aimOn; $('tAim').classList.toggle('on', touch.aimOn); });
  $('tCrouch').addEventListener('pointerdown', (e) => { e.preventDefault(); touch.pressed.add('crouch'); touch.crouchOn = !touch.crouchOn; $('tCrouch').classList.toggle('on', touch.crouchOn); });
  window.addEventListener('pointermove', (e) => {
    if (e.pointerId === touch.joyId) {
      let dx = e.clientX - touch.ox, dy = e.clientY - touch.oy;
      const R = 56, l = Math.hypot(dx, dy);
      if (l > R) { dx *= R / l; dy *= R / l; }
      touch.mx = dx / R; touch.my = dy / R;
      joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
    }
    const lp = touch.look.get(e.pointerId);
    if (lp) { touch.lookDX += e.clientX - lp.x; touch.lookDY += e.clientY - lp.y; lp.x = e.clientX; lp.y = e.clientY; }
  }, { passive: true });
  function endPointer(e) {
    if (e.pointerId === touch.joyId) { touch.joyId = null; touch.mx = touch.my = 0; joyKnob.style.transform = ''; joyBase.classList.remove('on'); }
    touch.look.delete(e.pointerId);
    for (const id of ['tFire', 'tFireL']) {
      const el = $(id);
      if (el.dataset.pid === String(e.pointerId)) { el.dataset.pid = ''; touch.fire = Math.max(0, touch.fire - 1); el.classList.remove('down'); }
    }
    for (const id in tapButtons) $(id).classList.remove('down');
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);

  // --- Gamepad ---
  let padPrev = [];
  function readPad(inp, dt) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let pad = null;
    for (const p of pads) if (p && p.connected) { pad = p; break; }
    if (!pad) { padPrev = []; return; }
    const dz = (v) => (Math.abs(v) < 0.15 ? 0 : v);
    const b = (i) => !!(pad.buttons[i] && (pad.buttons[i].pressed || pad.buttons[i].value > 0.4));
    const edge = (i) => b(i) && !padPrev[i];
    inp.moveX += dz(pad.axes[0] || 0); inp.moveY += -dz(pad.axes[1] || 0);
    const k = 3.0 * dt * store.settings.sens;
    inp.lookX += dz(pad.axes[2] || 0) * k; inp.lookY += dz(pad.axes[3] || 0) * k * 0.75;
    if (b(7)) inp.fire = true;
    if (b(6)) inp.aim = true;
    if (edge(0)) inp.jumpPressed = true;
    if (b(1)) inp.crouch = true;
    if (edge(1)) inp.crouchPressed = true;
    if (edge(2)) inp.reloadPressed = true;
    if (edge(3)) inp.swapPressed = true;
    if (edge(4) || edge(5)) inp.dashPressed = true;
    if (b(10) || Math.hypot(pad.axes[0] || 0, pad.axes[1] || 0) > 0.95) inp.sprint = true;
    if (edge(9)) togglePause();
    padPrev = pad.buttons.map((x) => x.pressed);
  }

  function readInput(dt) {
    const s = store.settings;
    const k = (c) => keys.has(c), p = (c) => pressed.has(c);
    let select = -1;
    for (let i = 1; i <= 8; i++) if (p('Digit' + i)) select = i - 1;
    const inp = {
      moveX: (k('KeyD') || k('ArrowRight') ? 1 : 0) - (k('KeyA') || k('ArrowLeft') ? 1 : 0),
      moveY: (k('KeyW') || k('ArrowUp') ? 1 : 0) - (k('KeyS') || k('ArrowDown') ? 1 : 0),
      lookX: mouse.dx * 0.0022 * s.sens, lookY: mouse.dy * 0.0022 * s.sens,
      fire: mouse.l, aim: mouse.r,
      sprint: k('ShiftLeft') || k('ShiftRight'),
      crouch: k('KeyC') || k('ControlLeft'),
      crouchPressed: p('KeyC') || p('ControlLeft'),
      jumpPressed: p('Space'), dashPressed: p('KeyQ') || p('KeyE'),
      reloadPressed: p('KeyR'), swapPressed: mouse.wheel, select
    };
    mouse.dx = mouse.dy = 0; mouse.wheel = false; pressed.clear();
    if (isTouch) {
      inp.moveX += touch.mx; inp.moveY += -touch.my;
      inp.lookX += touch.lookDX * 0.0045 * s.touchSens; inp.lookY += touch.lookDY * 0.0045 * s.touchSens;
      touch.lookDX = touch.lookDY = 0;
      if (touch.fire > 0) inp.fire = true;
      if (touch.aimOn) inp.aim = true;
      if (touch.crouchOn) inp.crouch = true;
      if (Math.hypot(touch.mx, touch.my) > 0.92) inp.sprint = true;
      for (const [key, field] of [['jump', 'jumpPressed'], ['dash', 'dashPressed'], ['reload', 'reloadPressed'], ['swap', 'swapPressed'], ['crouch', 'crouchPressed']]) if (touch.pressed.has(key)) inp[field] = true;
      touch.pressed.clear();
    }
    readPad(inp, dt);
    return inp;
  }

  // ======================================================================
  // Shared movement helpers (player + bots)
  // ======================================================================
  function applySurface(f) {
    // Jump pads launch; conveyor belts carry.
    if (f.padCd > 0) return;
    const g = f.grounded && f.groundBox;
    if (g && g.pad) {
      f.vel.set(g.pad.x, g.pad.y, g.pad.z); f.grounded = false; f.padCd = 0.5; f.jumpsLeft = 1;
      f.airCap = Math.hypot(g.pad.x, g.pad.z);
      if (f.ai) f.ai.path = null;
      if (f.isPlayer) Sfx.pad();
      burst(new V3(f.pos.x, f.pos.y + 0.2, f.pos.z), [0x9dff2e, 0xffffff], 10, 3, 0.1, 0.5, 2);
    }
  }
  function moveWithBelt(f, dt) {
    const belt = f.grounded && f.groundBox && f.groundBox.belt;
    if (belt) { f.vel.x += belt.x; f.vel.z += belt.z; }
    C.moveEntity(f, world.boxes, dt);
    if (belt) { f.vel.x -= belt.x; f.vel.z -= belt.z; }
    if (f.padCd > 0) f.padCd -= dt;
    applySurface(f);
  }

  // ======================================================================
  // Player controller
  // ======================================================================
  function startReload(f) {
    const w = weaponOf(f);
    if (!w.mag || f.reloadT > 0 || f.ammo[w.id] >= w.mag) return;
    f.reloadT = w.reload;
    if (f.isPlayer) { Sfx.reload(); if (state.online) net.send({ t: 'reload' }); }
  }
  function selectWeapon(p, idx) {
    if (idx === p.wIndex || idx < 0 || idx >= p.weaponIds.length) return;
    p.wIndex = idx; p.swapT = 0.3; p.reloadT = 0; p.charge = 0; vmSwap = 1;
    buildViewmodel(p.weaponIds[p.wIndex]);
    Sfx.click();
  }

  function updatePlayer(dt, inp, frozen) {
    const p = player, s = store.settings;
    const w0 = weaponOf(p);
    const scoped = p.ads && w0.zoom;
    const lookK = scoped ? w0.zoom : p.ads ? 0.62 : 1;
    p.yaw -= inp.lookX * lookK;
    p.pitch -= inp.lookY * lookK * (s.invertY ? -1 : 1);
    const rec = p.recoilAcc * Math.min(1, dt * 7);
    p.pitch -= rec; p.recoilAcc -= rec;
    p.pitch = clamp(p.pitch, -1.45, 1.45);

    if (!p.alive) {
      camera.position.set(p.pos.x, Math.max(p.pos.y, -8) + 2.4, p.pos.z);
      camera.rotation.set(-0.5, p.yaw, 0);
      return;
    }
    if (p.shieldT > 0) p.shieldT -= dt;
    p.dashCd -= dt; p.slideCd -= dt; p.cool -= dt;
    if (p.swapT > 0) p.swapT -= dt;
    if (p.dashT > 0) p.dashT -= dt;
    if (p.slideT > 0) p.slideT -= dt;

    let mx = inp.moveX, mz = inp.moveY;
    let len = Math.hypot(mx, mz);
    if (len > 1) { mx /= len; mz /= len; len = 1; }
    if (frozen) { mx = mz = len = 0; }
    const sn = Math.sin(p.yaw), cs = Math.cos(p.yaw);
    const dx = -sn * mz + cs * mx, dz = -cs * mz - sn * mx;
    const hSpeed = Math.hypot(p.vel.x, p.vel.z);
    const sprint = inp.sprint && mz > 0.3 && !p.ads;

    if (!frozen && inp.crouchPressed && p.grounded && hSpeed > 6 && p.slideCd <= 0) {
      p.slideT = 0.7; p.slideCd = 1.0;
      p.slideDir.set(p.vel.x / hSpeed, 0, p.vel.z / hSpeed);
      touch.crouchOn = false; $('tCrouch').classList.remove('on');
      Sfx.dash();
    }
    if (!frozen && inp.dashPressed && p.dashCd <= 0) {
      if (len > 0.1) p.dashDir.set(dx / len, 0, dz / len); else p.dashDir.set(-sn, 0, -cs);
      p.dashT = 0.17; p.dashCd = 1.5; p.slideT = 0;
      Sfx.dash();
      burst(new V3(p.pos.x, p.pos.y + 0.3, p.pos.z), [0xffffff, 0xbfe9ff], 8, 2, 0.12, 0.4, 0);
    }

    const wantCrouch = (inp.crouch || p.slideT > 0) && !frozen;
    if (wantCrouch) { p.crouching = true; p.height = 1.05; }
    else if (p.crouching && !C.anyOverlap(p.pos, p.radius, 1.7, world.boxes)) { p.crouching = false; p.height = 1.7; }
    p.eye += ((p.crouching ? 0.88 : 1.55) - p.eye) * Math.min(1, dt * 14);
    p.ads = !!inp.aim && p.swapT <= 0 && p.dashT <= 0 && p.slideT <= 0 && !frozen;

    const target = p.ads ? 4.4 : p.crouching ? 3.4 : sprint ? 9.2 : 6.4;
    if (p.dashT > 0) {
      p.vel.x = p.dashDir.x * 21; p.vel.z = p.dashDir.z * 21;
      p.airCap = Math.max(p.airCap, 9.2);
    } else if (p.slideT > 0) {
      const sp = 6 + 9 * (p.slideT / 0.7);
      p.vel.x = p.slideDir.x * sp + dx * 1.5; p.vel.z = p.slideDir.z * sp + dz * 1.5;
      p.airCap = sp;
    } else if (p.grounded) {
      const k = Math.min(1, 14 * dt);
      p.vel.x += (dx * target - p.vel.x) * k;
      p.vel.z += (dz * target - p.vel.z) * k;
      p.airCap = Math.max(target, Math.hypot(p.vel.x, p.vel.z));
    } else if (len > 0.1) {
      // Air control: steer without losing momentum from jumps, pads or blasts
      p.vel.x += dx * 20 * dt; p.vel.z += dz * 20 * dt;
      const hs = Math.hypot(p.vel.x, p.vel.z), cap = Math.max(target, p.airCap);
      if (hs > cap) { p.vel.x *= cap / hs; p.vel.z *= cap / hs; }
    }
    if (p.grounded) p.jumpsLeft = 1;
    if (!frozen && inp.jumpPressed) {
      if (p.grounded) { p.vel.y = 7.6; p.grounded = false; Sfx.jump(); }
      else if (p.jumpsLeft > 0) {
        p.vel.y = 7.0; p.jumpsLeft = 0; Sfx.jump();
        burst(new V3(p.pos.x, p.pos.y, p.pos.z), [0xffffff], 6, 2, 0.12, 0.35, 0);
      }
      if (p.slideT > 0) p.slideT = 0;
    }
    const lowG = world.map.lowGravity ? 0.5 : 1;
    if (p.dashT <= 0) p.vel.y -= 22 * lowG * dt; else p.vel.y = Math.max(p.vel.y, 0);
    moveWithBelt(p, dt);
    if (checkFall(p)) { updateCamera(dt); return; }

    if (p.grounded && hSpeed > 2 && p.slideT <= 0) {
      p.stepT -= dt * (hSpeed / 6.4);
      if (p.stepT <= 0) { p.stepT = 0.4; Sfx.step(); }
      vmBob += dt * hSpeed * 1.6;
    }

    // Weapons
    if (!frozen) {
      if (inp.select >= 0) selectWeapon(p, inp.select);
      else if (inp.swapPressed && p.weaponIds.length > 1) selectWeapon(p, (p.wIndex + 1) % p.weaponIds.length);
      const w = weaponOf(p);
      if (inp.reloadPressed) startReload(p);
      if (p.reloadT > 0) { p.reloadT -= dt; if (p.reloadT <= 0) { p.reloadT = 0; p.ammo[w.id] = w.mag; } }
      const ready = p.cool <= 0 && p.swapT <= 0 && p.reloadT <= 0;
      if (w.chargeTime) {
        if (inp.fire && ready) {
          if (p.charge === 0) Sfx.charge();
          p.charge = Math.min(1, p.charge + dt / w.chargeTime);
        } else if (!inp.fire && p.charge > 0) {
          if (p.charge > 0.08) firePlayer(p, w, p.charge);
          p.charge = 0;
        }
      } else if (inp.fire && ready) {
        if (!w.mag || p.ammo[w.id] > 0) firePlayer(p, w, 1);
        else { Sfx.empty(); p.cool = 0.25; startReload(p); }
      }
    }
    updateCamera(dt);
  }

  function firePlayer(p, w, charge) {
    updateCamera(0);
    const dir = new V3();
    camera.getWorldDirection(dir);
    const origin = camera.position.clone();
    const seed = Math.floor(Math.random() * 2147483647);
    const hit = shoot(p, origin, dir, p.ads, charge, state.online ? seed : undefined);
    if (state.online) {
      const r = (v) => Math.round(v * 1000) / 1000;
      net.send({ t: 'fire', w: p.wIndex, o: [r(origin.x), r(origin.y), r(origin.z)], d: [r(dir.x), r(dir.y), r(dir.z)], c: r(charge), a: p.ads ? 1 : 0, s: seed });
    }
    if (w.mag) p.ammo[w.id]--;
    p.cool = w.fireInterval;
    state.matchShots++; if (hit) state.matchHits++;
    const kick = w.recoil * (p.ads ? 0.55 : 1);
    p.pitch += kick; p.recoilAcc += kick * 0.75;
    p.yaw += rand(-0.3, 0.3) * kick;
    vmKick = 1;
    Sfx.shot(w.id);
    if (w.mag && p.ammo[w.id] === 0) startReload(p);
  }

  let fovNow = store.settings.fov;
  function updateCamera(dt) {
    const p = player;
    camera.position.set(p.pos.x, p.pos.y + p.eye, p.pos.z);
    const roll = p.slideT > 0 ? 0.08 : 0;
    const sh = state.shake;
    camera.rotation.set(p.pitch + rand(-sh, sh) * 0.06, p.yaw + rand(-sh, sh) * 0.06, camera.rotation.z + (roll - camera.rotation.z) * Math.min(1, dt * 10));
    const base = store.settings.fov, w = weaponOf(p);
    let target = p.ads ? base * (w.zoom || 0.72) : base;
    if (p.dashT > 0 || p.slideT > 0) target += 8;
    fovNow += (target - fovNow) * Math.min(1, dt * 14);
    if (dt === 0) fovNow = fovNow || base;
    if (Math.abs(camera.fov - fovNow) > 0.01) { camera.fov = fovNow; camera.updateProjectionMatrix(); }
  }

  // ======================================================================
  // Bots
  // ======================================================================
  function pickBotTarget(b) {
    let best = null, bestScore = Infinity;
    for (const o of fighters) {
      if (!o.alive || !isEnemy(b, o)) continue;
      if (match.mode.id === 'duel' && !o.isPlayer) continue;
      let d = b.pos.distanceTo(o.pos);
      if (o === b.lastAttacker) d *= 0.6;
      if (hasLOS(eyePos(b, tmpA), eyePos(o, tmpB))) d *= 0.5;
      if (d < bestScore) { bestScore = d; best = o; }
    }
    return best;
  }
  function angleDiff(a, b) { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }

  /** True if stepping `dist` meters in (mx, mz) would leave solid ground (a ledge into the void). */
  function unsafeAhead(b, mx, mz, dist) {
    if (world.map.voidY == null) return false;
    const l = Math.hypot(mx, mz); if (l < 0.01) return false;
    const g = C.groundAt(world.boxes, b.pos.x + (mx / l) * dist, b.pos.z + (mz / l) * dist, b.pos.y + 0.5);
    return !g || g.y < b.pos.y - 3.6;
  }

  /** Steers along a nav path toward goal. Returns {x, z} direction. */
  function navigate(b, goal, dt) {
    const ai = b.ai, nav = world.nav;
    ai.repath -= dt;
    if (!ai.path || ai.repath <= 0) {
      ai.repath = rand(0.9, 1.5);
      const s = C.nearestNode(nav, b.pos), g = C.nearestNode(nav, goal, 6);
      ai.path = C.findPath(nav, s, g); ai.pi = 0;
    }
    let tx = goal.x, tz = goal.z;
    if (ai.path && ai.pi < ai.path.length) {
      let n = nav.nodes[ai.path[ai.pi]];
      if (Math.hypot(n.x - b.pos.x, n.z - b.pos.z) < 0.9 && Math.abs(n.y - b.pos.y) < 1.5) {
        ai.pi++;
        if (ai.pi < ai.path.length) n = nav.nodes[ai.path[ai.pi]];
      }
      tx = n.x; tz = n.z;
    }
    const dx = tx - b.pos.x, dz = tz - b.pos.z, l = Math.hypot(dx, dz) || 1;
    return { x: dx / l, z: dz / l };
  }

  function updateBot(b, dt) {
    const ai = b.ai, diff = C.DIFFICULTY[store.settings.difficulty] || C.DIFFICULTY.normal;
    const w = weaponOf(b);
    if (b.shieldT > 0) b.shieldT -= dt;
    b.cool -= dt; ai.pause -= dt;
    ai.think -= dt;
    if (ai.think <= 0) { ai.think = rand(0.25, 0.45); ai.target = pickBotTarget(b); }
    const t = ai.target && ai.target.alive ? ai.target : null;
    let seen = false, dist = 0;
    const eye = eyePos(b, new V3());
    const aim = new V3();
    if (t) {
      aim.set(t.pos.x, t.pos.y + (t.isPlayer ? t.height * 0.62 : 1.0), t.pos.z);
      dist = b.pos.distanceTo(t.pos);
      seen = dist < 60 && hasLOS(eye, aim);
    }
    if (seen) { ai.seenT += dt; ai.lastSeen.copy(t.pos); ai.hasLast = true; } else ai.seenT = 0;

    let mx = 0, mz = 0, wantYaw = b.yaw, wantPitch = 0;
    if (seen) {
      const pref = w.botRange;
      const dxT = t.pos.x - b.pos.x, dzT = t.pos.z - b.pos.z;
      const l = Math.hypot(dxT, dzT) || 1, fx = dxT / l, fz = dzT / l;
      const fwd = dist > pref + 3 ? 1 : dist < pref - 3 ? -0.7 : 0;
      ai.strafeT -= dt;
      if (ai.strafeT <= 0) { ai.strafeT = rand(0.5, 1.8); ai.strafeDir = Math.random() < 0.5 ? -1 : 1; }
      mx = fx * fwd - fz * ai.strafeDir * diff.strafe;
      mz = fz * fwd + fx * ai.strafeDir * diff.strafe;
      if (unsafeAhead(b, mx, mz, 1.3)) { ai.strafeDir *= -1; mx = fx * fwd - fz * ai.strafeDir * diff.strafe; mz = fz * fwd + fx * ai.strafeDir * diff.strafe; if (unsafeAhead(b, mx, mz, 1.3)) { mx = mz = 0; } }
      // Aim point: lead moving targets and arc for gravity
      const tt = w.type === 'projectile' ? dist / (w.chargeTime ? w.speed * 0.9 : w.speed) : 0;
      const lead = diff.id === 'easy' ? 0.4 : diff.id === 'normal' ? 0.75 : 1;
      if (tt) {
        aim.x += t.vel.x * tt * lead; aim.z += t.vel.z * tt * lead;
        aim.y += 0.5 * (w.gravity || 0) * tt * tt;
        if (w.splash) aim.y -= 0.6; // aim at the feet for splash
      }
      const ad = new V3().subVectors(aim, eye);
      wantYaw = Math.atan2(-ad.x, -ad.z);
      wantPitch = Math.atan2(ad.y, Math.hypot(ad.x, ad.z));
      if (b.grounded && Math.random() < diff.jumpChance * dt && !unsafeAhead(b, mx, mz, 3)) b.vel.y = 7.6;
      ai.path = null;
    } else {
      let goal;
      if (ai.hasLast) { goal = ai.lastSeen; if (b.pos.distanceTo(goal) < 2) ai.hasLast = false; }
      if (!goal) {
        if (!ai.goal || Math.hypot(ai.goal.x - b.pos.x, ai.goal.z - b.pos.z) < 2 || ai.goalT <= 0) {
          const nodes = world.nav.nodes.filter((n) => n.main);
          ai.goal = t && Math.random() < 0.65 ? { x: t.pos.x, y: t.pos.y, z: t.pos.z } : nodes[Math.floor(Math.random() * nodes.length)];
          ai.goalT = 6; ai.path = null;
        }
        ai.goalT -= dt;
        goal = ai.goal;
      }
      const d = navigate(b, goal, dt);
      mx = d.x; mz = d.z;
      if (unsafeAhead(b, mx, mz, 0.9)) { mx = mz = 0; ai.path = null; ai.goal = null; }
      wantYaw = mx || mz ? Math.atan2(-mx, -mz) : b.yaw;
    }
    const ml = Math.hypot(mx, mz);
    if (ml > 1) { mx /= ml; mz /= ml; }

    b.yaw += clamp(angleDiff(b.yaw, wantYaw), -diff.turnRate * dt, diff.turnRate * dt);
    b.pitch += (wantPitch - b.pitch) * Math.min(1, dt * 8);

    const speed = 5.6;
    if (b.grounded) {
      const k = Math.min(1, 10 * dt);
      b.vel.x += (mx * speed - b.vel.x) * k;
      b.vel.z += (mz * speed - b.vel.z) * k;
    }
    b.vel.y -= 22 * (world.map.lowGravity ? 0.5 : 1) * dt;
    moveWithBelt(b, dt);
    if (checkFall(b)) return;
    const hs = Math.hypot(b.vel.x, b.vel.z);
    if (ml > 0.3 && hs < 1.2 && b.grounded) {
      ai.stuckT += dt;
      if (ai.stuckT > 0.35 && !unsafeAhead(b, mx, mz, 2)) b.vel.y = 7.6;
      if (ai.stuckT > 1.4) { ai.path = null; ai.goal = null; ai.hasLast = false; ai.stuckT = 0; }
    } else ai.stuckT = 0;
    b.walkPhase += dt * hs * 2.2;

    // Weapon handling
    if (w.mag) {
      if (b.reloadT > 0) { b.reloadT -= dt; if (b.reloadT <= 0) { b.reloadT = 0; b.ammo[w.id] = w.mag; } }
      else if (b.ammo[w.id] <= 0) startReload(b);
      else if (!seen && b.ammo[w.id] < w.mag * 0.5) startReload(b);
    }
    const facing = Math.abs(angleDiff(b.yaw, wantYaw)) < 0.22;
    const tooClose = w.selfScale > 0 && dist < 4.5;
    const canFire = seen && ai.seenT > diff.reaction && facing && b.cool <= 0 && b.reloadT <= 0 && ai.pause <= 0 && dist < w.range * 0.85 && (!w.mag || b.ammo[w.id] > 0) && !tooClose;
    if (w.chargeTime) {
      if (ai.charge >= 0) {
        ai.charge += dt;
        const full = w.chargeTime * (diff.id === 'easy' ? 0.6 : diff.id === 'normal' ? 0.85 : 1);
        if (ai.charge >= full) { if (canFire || seen) botFire(b, w, eye, aim, t, diff, ai.charge / w.chargeTime); ai.charge = -1; }
        else if (!seen) ai.charge = -1;
      } else if (canFire) ai.charge = 0;
    } else if (canFire) botFire(b, w, eye, aim, t, diff, 1);
  }

  function botFire(b, w, eye, aim, t, diff, charge) {
    const ai = b.ai;
    const dir = new V3().subVectors(aim, eye).normalize();
    const tSpeed = Math.hypot(t.vel.x, t.vel.z);
    const err = diff.aimError * (1 + tSpeed / 12) * (w.id === 'precision' ? 0.7 : 1);
    shoot(b, eye, C.spreadDir(dir, err), false, charge);
    if (w.mag) b.ammo[w.id]--;
    b.cool = w.fireInterval * diff.fireSlow;
    if (w.fireInterval < 0.2) { ai.burst++; if (ai.burst >= 4 + Math.floor(Math.random() * 4)) { ai.burst = 0; ai.pause = rand(0.35, 0.8); } }
    Sfx.shot(w.id, clamp(1 - (player && player.alive ? player.pos.distanceTo(b.pos) : 30) / 50, 0.06, 0.5));
  }

  function syncBotMesh(b, dt) {
    const m = b.mesh;
    if (!m) return;
    m.group.visible = b.alive && !(b.shieldT > 0 && Math.floor(state.time * 12) % 2 === 0);
    if (!b.alive) return;
    m.group.position.copy(b.pos);
    m.group.rotation.y = b.yaw;
    const sw = Math.sin(b.walkPhase);
    m.feet[0].position.z = -0.04 + sw * 0.18; m.feet[1].position.z = -0.04 - sw * 0.18;
    m.feet[0].position.y = 0.09 + Math.max(0, sw) * 0.08; m.feet[1].position.y = 0.09 + Math.max(0, -sw) * 0.08;
    if (b.hitFlash > 0) b.hitFlash -= dt;
    m.shirtMat.emissiveIntensity = b.hitFlash > 0 ? 0.6 : 0;
    const sq = b.hitFlash > 0 ? 0.92 : 1;
    m.group.scale.set(2 - sq, sq, 2 - sq);
    const ally = player && !isEnemy(player, b);
    const cb = store.settings.cbMode && !ally;
    m.marker.material = ally ? markerMats.ally : cb ? markerMats.cb : b.team ? markerMats.enemyTeam : markerMats.enemy;
    m.marker.renderOrder = ally ? 999 : 0;
    m.marker.scale.set(cb ? 1.5 : 1, cb ? 2.1 : 1.4, cb ? 1.5 : 1);
    m.marker.rotation.y += dt * 2.5;
    m.marker.position.y = 2.2 + Math.sin(state.time * 3) * 0.06;
    m.outline.visible = cb;
    // bow draw pose
    m.gun.position.z = b.ai.charge >= 0 ? -0.22 : -0.32;
  }

  // ======================================================================
  // HUD
  // ======================================================================
  const hud = {
    healthFill: $('healthFill'), healthNum: $('healthNum'), ammo: $('ammoNum'), mag: $('ammoMag'), wname: $('weaponName'),
    reload: $('reloadTag'), timer: $('timer'), score: $('scoreLine'), dash: $('dashPip'), cross: $('crosshair'),
    hit: $('hitmarker'), hurt: $('hurt'), dir: $('hurtDir'), banner: $('banner'), count: $('countdown'), death: $('deathTimer'),
    charge: $('chargeBar'), chargeFill: $('chargeFill'), scope: $('scope'), slots: $('slots')
  };
  let hitmarkerT = 0, bannerT = 0, hurtT = 0;
  function showHitmarker(head, shielded) {
    hitmarkerT = 0.18;
    hud.hit.className = 'hitmarker on' + (head ? ' head' : '') + (shielded ? ' shield' : '');
  }
  function hurtFlash(attacker) {
    hurtT = 0.5;
    const a = Math.atan2(-(attacker.pos.x - player.pos.x), -(attacker.pos.z - player.pos.z));
    hud.dir.style.transform = `translate(-50%,-50%) rotate(${-angleDiff(player.yaw, a)}rad)`;
  }
  function banner(text) { hud.banner.textContent = text; hud.banner.classList.remove('pop'); void hud.banner.offsetWidth; hud.banner.classList.add('pop'); bannerT = 1.4; }
  function addKillfeed(a, v) {
    const el = document.createElement('div');
    el.className = 'kf' + ((a && a.isPlayer) || v.isPlayer ? ' mine' : '');
    const name = (f) => { const b = document.createElement('b'); b.style.color = hex(nameColor(f)); b.textContent = displayName(f); return b; };
    if (!a) el.append(name(v), ' took a tumble');
    else { const icon = document.createElement('span'); icon.className = 'kf-icon'; icon.textContent = '✖'; el.append(name(a), icon, name(v)); }
    const feed = $('killfeed');
    feed.prepend(el);
    while (feed.children.length > 4) feed.lastChild.remove();
    setTimeout(() => el.remove(), 4500);
  }
  const fmt = (s) => { s = Math.ceil(s); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  let hudCache = {};
  function setText(el, key, v) { if (hudCache[key] !== v) { hudCache[key] = v; el.textContent = v; } }
  function setHTML(el, key, v) { if (hudCache[key] !== v) { hudCache[key] = v; el.innerHTML = v; } }

  function updateHud(dt) {
    if (!player) return;
    const p = player, w = weaponOf(p);
    const hp = Math.max(0, Math.ceil(p.health));
    setText(hud.healthNum, 'hp', String(hp));
    hud.healthFill.style.transform = `scaleX(${hp / 100})`;
    hud.healthFill.classList.toggle('low', hp <= 35);
    setText(hud.ammo, 'ammo', w.mag ? String(p.ammo[w.id]) : '∞');
    setText(hud.mag, 'mag', w.mag ? '/ ' + w.mag : '');
    setText(hud.wname, 'wn', w.name);
    hud.reload.hidden = !(p.reloadT > 0);
    hud.dash.classList.toggle('ready', p.dashCd <= 0);
    setText(hud.timer, 'time', fmt(C.timeLeft(match)));
    let line;
    if (match.mode.id === 'practice') line = `Score <b>${state.practiceScore}</b>`;
    else if (match.mode.teams) line = `<span class="t-blue">BLUE ${match.teamScores.blue}</span> – <span class="t-orange">${match.teamScores.orange} ORANGE</span>`;
    else if (match.mode.id === 'duel') {
      const bot = fighters.find((f) => !f.isPlayer);
      const mine = match.scores[player.id] ? match.scores[player.id].kills : 0;
      line = bot && match.scores[bot.id] ? `You ${mine} – ${match.scores[bot.id].kills} ${bot.name}` : `You ${mine}`;
    } else {
      const st = C.standings(match);
      const mine = match.scores[player.id] ? match.scores[player.id].kills : 0;
      line = `#${st.findIndex((r) => r.id === player.id) + 1} · ${mine}/${match.mode.scoreLimit} blasts`;
    }
    setHTML(hud.score, 'score', line);
    const slotKey = p.weaponIds.join() + p.wIndex;
    if (hudCache.slots !== slotKey) {
      hudCache.slots = slotKey;
      hud.slots.innerHTML = '';
      p.weaponIds.forEach((id, i) => {
        const s = document.createElement('span');
        s.className = 'slot' + (i === p.wIndex ? ' on' : '');
        s.textContent = (i + 1) + ' ' + C.WEAPONS[id].name.split(' ')[0];
        hud.slots.appendChild(s);
      });
    }
    const scoped = p.alive && p.ads && w.zoom && state.phase !== 'paused';
    hud.scope.hidden = !scoped;
    const spread = p.ads ? w.adsSpread : w.spread;
    const moving = Math.hypot(p.vel.x, p.vel.z) > 1 ? 4 : 0;
    hud.cross.style.setProperty('--gap', (5 + spread * 260 + moving + (p.cool > 0 ? 3 : 0)) + 'px');
    hud.cross.classList.toggle('ads', p.ads);
    hud.cross.hidden = !!scoped;
    hud.charge.hidden = !w.chargeTime;
    if (w.chargeTime) { hud.chargeFill.style.transform = `scaleX(${p.charge})`; hud.chargeFill.classList.toggle('full', p.charge >= 1); }
    if (hitmarkerT > 0) { hitmarkerT -= dt; if (hitmarkerT <= 0) hud.hit.className = 'hitmarker'; }
    if (bannerT > 0) { bannerT -= dt; if (bannerT <= 0) hud.banner.classList.remove('pop'); }
    hurtT = Math.max(0, hurtT - dt);
    hud.hurt.style.opacity = p.alive ? Math.max(hurtT * 1.6, hp < 35 ? 0.35 : 0) : 0;
    hud.dir.style.opacity = hurtT * 2;
    if (!p.alive) setText(hud.death, 'death', `Back in ${Math.max(1, Math.ceil(p.respawnT))}…`);
    $('shieldTag').hidden = !(p.shieldT > 0 && p.alive);
  }

  // ======================================================================
  // Screens & menus
  // ======================================================================
  const screens = ['menu', 'settings', 'pause', 'results', 'loadout', 'locker', 'online', 'room'];
  let settingsReturn = 'menu';
  function showScreen(name) {
    state.screen = name;
    for (const s of screens) $(s).hidden = s !== name;
    if (name === 'locker') rebuildLockerChar();
  }
  function pauseGame() {
    if (state.phase !== 'play' && state.phase !== 'countdown') return;
    if (state.online) {
      // Online matches keep running; the menu just opens on top and your character stands still.
      if (state.screen) return;
      mouse.l = mouse.r = false; keys.clear(); releaseLock();
      $('quitBtn').textContent = 'Leave match';
      showScreen('pause');
      return;
    }
    state.resumePhase = state.phase; state.phase = 'paused';
    mouse.l = mouse.r = false; keys.clear();
    showScreen('pause');
  }
  function resumeGame() {
    if (state.online) { if (state.screen === 'pause' || state.screen === 'settings') { showScreen(null); tryLock(); } return; }
    if (state.phase !== 'paused') return;
    state.phase = state.resumePhase || 'play';
    showScreen(null); tryLock();
  }
  function togglePause() { if (state.phase === 'paused' || (state.online && state.screen === 'pause')) resumeGame(); else pauseGame(); }
  function quitToMenu() {
    if (state.online) { onlineHooks.leaveMatch(); return; }
    releaseLock(); clearMatchObjects();
    state.phase = 'menu';
    $('hud').hidden = true; $('touch').hidden = true; $('deathOverlay').hidden = true; $('scope').hidden = true;
    loadMap(store.settings.mode === 'practice' ? 'yard' : store.settings.map);
    showScreen('menu'); renderStats();
  }

  function renderStats() {
    const st = store.stats;
    $('statMatches').textContent = st.matches;
    $('statWins').textContent = st.wins;
    $('statKills').textContent = st.kills;
    $('statAcc').textContent = st.shots ? Math.round((st.hits / st.shots) * 100) + '%' : '—';
    $('statBest').textContent = st.bestPractice;
    $('loadoutSummary').textContent = store.settings.loadout.map((id) => C.WEAPONS[id].name).join(' + ');
  }

  function bindSegment(groupId, key, onChange) {
    const group = $(groupId);
    const sync = () => group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === String(store.settings[key]))));
    group.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      store.settings[key] = b.dataset.v; persist(); sync(); Sfx.unlock(); Sfx.click();
      if (onChange) onChange();
    });
    sync();
  }
  // Build mode + map pickers from data
  {
    const modeBlurb = { duel: 'First to 5', ffa: '6 players · first to 12', team2: 'First team to 10', team3: 'First team to 15', team5: 'First team to 25', practice: '60s, all 8 weapons' };
    const modeShort = { duel: '1v1 Duel', ffa: 'Free-for-All', team2: '2v2', team3: '3v3', team5: '5v5', practice: 'Practice' };
    $('modePick').innerHTML = Object.keys(C.MODES).map((id) => `<button data-v="${id}"><b>${modeShort[id]}</b><small>${modeBlurb[id]}</small></button>`).join('');
    $('mapPick').innerHTML = BA.MAP_ORDER.map((id) => `<button data-v="${id}" class="map-${id}"><b>${BA.MAPS[id].name}</b><small>${BA.MAPS[id].blurb}</small></button>`).join('');
  }
  const syncMapVisibility = () => {
    const practice = store.settings.mode === 'practice';
    $('mapRow').hidden = practice;
    if (state.phase === 'menu') loadMap(practice ? 'yard' : store.settings.map);
  };
  bindSegment('modePick', 'mode', syncMapVisibility);
  bindSegment('diffPick', 'difficulty');
  bindSegment('mapPick', 'map', syncMapVisibility);

  function bindRange(id, key, fmtFn) {
    const el = $(id), out = $(id + 'Val');
    el.value = store.settings[key];
    const show = () => { out.textContent = fmtFn(Number(el.value)); };
    el.addEventListener('input', () => { store.settings[key] = Number(el.value); show(); persist(); if (key === 'sfx') Sfx.setVolume(store.settings.sfx); });
    show();
  }
  bindRange('setSens', 'sens', (v) => v.toFixed(2) + '×');
  bindRange('setTouch', 'touchSens', (v) => v.toFixed(2) + '×');
  bindRange('setFov', 'fov', (v) => v + '°');
  bindRange('setSfx', 'sfx', (v) => Math.round(v * 100) + '%');
  function bindToggle(id, key, onChange) {
    const el = $(id);
    el.checked = !!store.settings[key];
    el.addEventListener('change', () => { store.settings[key] = el.checked; persist(); if (onChange) onChange(); });
  }
  const applyLefty = () => document.body.classList.toggle('lefty', !!store.settings.lefty);
  bindToggle('setInvert', 'invertY');
  bindToggle('setCb', 'cbMode');
  bindToggle('setLefty', 'lefty', applyLefty);
  bindToggle('setQuickChat', 'quickChat');
  bindToggle('setInvites', 'allowInvites', () => { if (BA.net) BA.net.send({ t: 'profile', allowInvites: store.settings.allowInvites }); });
  applyLefty();

  // --- Loadout screen ---
  let activeSlot = 0;
  function statBars(w) {
    const dmg = clamp((w.damage * w.pellets) / 100, 0.05, 1);
    const range = clamp((w.type === 'hitscan' ? w.falloffStart * 0.7 + w.range * 0.3 : w.range * 0.6) / 90, 0.05, 1);
    const rate = clamp(1 / (w.fireInterval + (w.chargeTime || 0)) / 8, 0.05, 1);
    const bar = (label, v) => `<div class="bar"><span>${label}</span><i><em style="transform:scaleX(${v.toFixed(2)})"></em></i></div>`;
    return bar('Damage', dmg) + bar('Range', range) + bar('Fire rate', rate);
  }
  function renderLoadout() {
    const lo = store.settings.loadout;
    $('slotTabs').querySelectorAll('button').forEach((b, i) => {
      b.setAttribute('aria-pressed', String(i === activeSlot));
      b.querySelector('small').textContent = C.WEAPONS[lo[i]].name;
    });
    $('weaponGrid').innerHTML = C.WEAPON_ORDER.map((id) => {
      const w = C.WEAPONS[id], slot = lo.indexOf(id);
      return `<button class="wcard${slot >= 0 ? ' equipped' : ''}" data-id="${id}" style="--wc:${hex(w.color)}">
        <span class="wtop"><b>${w.name}</b>${slot >= 0 ? `<em>${slot + 1}</em>` : ''}</span>
        <small>${w.role} · ${w.mag ? w.mag + ' shots' : 'unlimited'}</small>${statBars(w)}</button>`;
    }).join('');
  }
  $('slotTabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; activeSlot = Number(b.dataset.slot); renderLoadout(); Sfx.click(); });
  $('weaponGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.wcard'); if (!b) return;
    const lo = store.settings.loadout, id = b.dataset.id, other = 1 - activeSlot;
    if (lo[other] === id) lo[other] = lo[activeSlot];
    lo[activeSlot] = id;
    activeSlot = other;
    persist(); renderLoadout(); renderStats(); Sfx.click();
  });

  // --- Locker (character editor) ---
  function rebuildLockerChar() {
    if (lockerChar) lockerScene.remove(lockerChar.group);
    lockerChar = BA.buildCharacter(store.settings.outfit, { weapon: store.settings.loadout[0] });
    lockerChar.marker.visible = false;
    lockerScene.add(lockerChar.group);
    renderLocker();
  }
  function renderLocker() {
    const o = store.settings.outfit, O = BA.OUTFIT;
    const swatches = (key, list) => list.map((c, i) => `<button class="sw" data-k="${key}" data-v="${i}" style="background:${hex(c)}" aria-label="${key} ${i + 1}" aria-pressed="${o[key] === i}"></button>`).join('');
    const chips = (key, list) => list.map((x) => `<button class="chip-btn" data-k="${key}" data-v="${x.id}" aria-pressed="${o[key] === x.id}">${x.name}</button>`).join('');
    $('lockSkin').innerHTML = swatches('skin', O.skins);
    $('lockHair').innerHTML = chips('hair', O.hairs);
    $('lockHairColor').innerHTML = swatches('hairColor', O.hairColors);
    $('lockShirt').innerHTML = swatches('shirt', O.shirts);
    $('lockPants').innerHTML = swatches('pants', O.pants);
    $('lockAcc').innerHTML = chips('acc', O.accessories);
    $('lockSlots').innerHTML = store.settings.outfits.map((s, i) => `<div class="oslot">
      <span class="oswatch" style="background:${s ? hex(O.shirts[s.shirt]) : 'transparent'}"></span><b>Outfit ${i + 1}</b>
      <button class="mini-btn" data-save="${i}">Save</button><button class="mini-btn" data-wear="${i}" ${s ? '' : 'disabled'}>Wear</button></div>`).join('');
  }
  $('locker').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const o = store.settings.outfit;
    if (b.dataset.k) {
      const k = b.dataset.k;
      o[k] = k === 'hair' || k === 'acc' ? b.dataset.v : Number(b.dataset.v);
    } else if (b.dataset.save != null) {
      store.settings.outfits[Number(b.dataset.save)] = Object.assign({}, o);
      b.textContent = 'Saved';
    } else if (b.dataset.wear != null) {
      const s = store.settings.outfits[Number(b.dataset.wear)];
      if (s) store.settings.outfit = BA.cleanOutfit(s);
    } else if (b.id === 'lockRandom') store.settings.outfit = BA.randomOutfit();
    else if (b.id === 'lockWave') { lockerWave = 1.8; return; }
    else return;
    persist(); Sfx.click();
    if (b.dataset.save == null) rebuildLockerChar(); else setTimeout(renderLocker, 600);
  });
  {
    let dragId = null, lastX = 0;
    const stage = $('lockerDrag');
    stage.addEventListener('pointerdown', (e) => { dragId = e.pointerId; lastX = e.clientX; });
    window.addEventListener('pointermove', (e) => { if (e.pointerId === dragId) { lockerYaw += (e.clientX - lastX) * 0.012; lastX = e.clientX; } });
    window.addEventListener('pointerup', (e) => { if (e.pointerId === dragId) dragId = null; });
  }

  $('playBtn').addEventListener('click', () => startMatch(store.settings.mode));
  $('settingsBtn').addEventListener('click', () => { settingsReturn = 'menu'; showScreen('settings'); });
  $('loadoutBtn').addEventListener('click', () => { activeSlot = 0; renderLoadout(); showScreen('loadout'); });
  $('lockerBtn').addEventListener('click', () => showScreen('locker'));
  $('loadoutDone').addEventListener('click', () => showScreen('menu'));
  $('lockerDone').addEventListener('click', () => showScreen('menu'));
  $('pauseSettings').addEventListener('click', () => { settingsReturn = 'pause'; showScreen('settings'); });
  $('settingsDone').addEventListener('click', () => showScreen(settingsReturn));
  $('resumeBtn').addEventListener('click', resumeGame);
  $('quitBtn').addEventListener('click', quitToMenu);
  $('rematchBtn').addEventListener('click', () => {
    if (state.online) { if (!state.voted) { state.voted = true; net.send({ t: 'vote', yes: true }); $('rematchBtn').textContent = 'Waiting\u2026'; } return; }
    startMatch(match ? match.mode.id : store.settings.mode);
  });
  $('menuBtn').addEventListener('click', () => { if (state.online) onlineHooks.resultsBack(); else quitToMenu(); });
  $('pauseBtn').addEventListener('click', (e) => { e.stopPropagation(); togglePause(); });
  $('resetStats').addEventListener('click', () => {
    const btn = $('resetStats');
    if (btn.dataset.armed !== '1') { btn.dataset.armed = '1'; btn.textContent = 'Tap again to erase'; setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Reset stats'; }, 2500); return; }
    store.stats = JSON.parse(JSON.stringify(DEFAULTS.stats)); persist(); renderStats();
    btn.dataset.armed = ''; btn.textContent = 'Stats cleared';
  });
  $('controlsHint').textContent = isTouch
    ? 'Left thumb moves. Drag the right side to look. Push the stick all the way to sprint. Tap SLIDE while sprinting. Hold FIRE to charge the bow.'
    : 'WASD move · Mouse look · Click fire (hold to charge the bow) · Right-click aim/scope · Shift sprint · Space jump (twice to double jump) · C slide · Q dash · R reload · 1–8 or wheel swap · P pause. Controllers work too.';
  renderStats();

  // ======================================================================
  // Online play (driven by online.js, which owns the connection and lobby screens)
  // ======================================================================
  const onlineHooks = { leaveMatch() {}, resultsBack() {} };
  const byId = (id) => fighters.find((f) => f.id === id);
  const v3 = (a) => new V3(a[0], a[1], a[2]);
  const r3 = (v) => Math.round(v * 1000) / 1000;
  let chatOpen = false;

  function addRemote(p) {
    const f = makeFighter({ id: p.id, name: p.name, team: p.team, outfit: p.outfit, weaponIds: p.loadout.slice() });
    f.remote = true; f.buf = []; f.height = 1.7;
    fighters.push(f);
    return f;
  }
  function applyScores(sc) {
    if (!sc || !match) return;
    if (sc.sc) for (const id in sc.sc) if (match.scores[id]) { match.scores[id].kills = sc.sc[id][0]; match.scores[id].deaths = sc.sc[id][1]; }
    if (sc.ts && match.teamScores) Object.assign(match.teamScores, sc.ts);
  }
  function resetPlayerAt(pos, yaw) {
    const p = player;
    p.pos.set(pos[0], pos[1], pos[2]); p.vel.set(0, 0, 0); p.yaw = yaw || 0; p.pitch = 0;
    p.alive = true; p.health = C.MAX_HEALTH; p.shieldT = 1.2; p.reloadT = 0; p.charge = 0; p.crouching = false; p.height = 1.7;
    p.weaponIds.forEach((id) => { p.ammo[id] = C.WEAPONS[id].mag; });
    p.spawnedAt = state.time;
    $('deathOverlay').hidden = true;
    buildViewmodel(p.weaponIds[p.wIndex]);
  }

  function startOnlineMatch(info) {
    Sfx.unlock();
    clearMatchObjects();
    state.online = true; state.clockOff = null; state.sendT = 0; state.voted = false;
    state.matchShots = 0; state.matchHits = 0; state.endT = null;
    loadMap(info.map);
    const teamOf = {};
    info.players.forEach((p) => { teamOf[p.id] = p.team; });
    const me = info.players.find((p) => p.id === info.you);
    player = makeFighter({ id: info.you, name: me.name, isPlayer: true, team: me.team, weaponIds: me.loadout.slice() });
    fighters.push(player);
    for (const p of info.players) if (p.id !== info.you) addRemote(p);
    match = C.createMatch(info.mode, info.players.map((p) => p.id), C.MODES[info.mode].teams ? teamOf : null);
    match.time = match.mode.timeLimit - info.timeLeft;
    applyScores(info.scores);
    resetPlayerAt(info.spawn, info.yaw);
    if (info.alive === false) { player.alive = false; $('deathOverlay').hidden = false; $('deathBy').textContent = 'Rejoining\u2026'; }
    state.phase = info.countdown > 0.05 ? 'countdown' : 'play';
    state.countdown = info.countdown; state.lastBeep = 4;
    showScreen(null);
    $('hud').hidden = false; $('touch').hidden = !isTouch;
    $('chatBtn').hidden = !store.settings.quickChat;
    touch.aimOn = false; touch.crouchOn = false;
    $('tAim').classList.remove('on'); $('tCrouch').classList.remove('on');
    $('rematchBtn').textContent = 'Rematch';
    tryLock();
    hudCache = {};
  }

  function leaveOnlineMatch() {
    releaseLock();
    clearMatchObjects();
    state.online = false; state.phase = 'menu';
    $('hud').hidden = true; $('touch').hidden = true; $('deathOverlay').hidden = true; $('scope').hidden = true; $('chatPanel').hidden = true;
    loadMap(store.settings.mode === 'practice' ? 'yard' : store.settings.map);
  }

  function applySnapshot(msg) {
    if (!state.online || !match || !player) return;
    const off = msg.ts - performance.now();
    state.clockOff = state.clockOff == null ? off : Math.max(off, state.clockOff - 2);
    match.time = match.mode.timeLimit - msg.tl;
    applyScores(msg);
    if (msg.st === 'play' && state.phase === 'countdown' && state.countdown > 0.3) state.countdown = 0.01;
    if (msg.ev) for (const e of msg.ev) handleEvent(e);
    for (const row of msg.s) {
      const [id, x, y, z, yaw, pitch, hp, flags, w] = row;
      const f = byId(id);
      if (!f) continue;
      if (f.isPlayer) {
        f.health = hp;
        f.shieldT = flags & 4 ? Math.max(f.shieldT, 0.15) : 0;
        if (!(flags & 1) && f.alive && state.time - (f.spawnedAt || 0) > 0.6) { f.alive = false; $('deathOverlay').hidden = false; }
        continue;
      }
      const alive = !!(flags & 1) && !(flags & 16);
      if (alive && !f.alive) { f.buf = []; f.pos.set(x, y, z); }
      f.alive = alive; f.health = hp;
      if (w !== f.wIndex && f.weaponIds[w]) { f.wIndex = w; f.mesh.setWeapon(f.weaponIds[w]); }
      f.buf.push({ t: msg.ts, x, y, z, yaw, pitch, flags });
      if (f.buf.length > 30) f.buf.shift();
    }
  }

  function interpolateRemotes(dt) {
    const rt = performance.now() + (state.clockOff || 0) - 100;
    for (const f of fighters) {
      if (!f.remote || !f.buf.length) continue;
      const b = f.buf;
      let a = b[b.length - 1], c = a;
      if (rt <= b[0].t) { a = c = b[0]; }
      else if (rt < b[b.length - 1].t) {
        for (let i = b.length - 1; i > 0; i--) if (b[i - 1].t <= rt) { a = b[i - 1]; c = b[i]; break; }
      }
      const k = c.t > a.t ? clamp((rt - a.t) / (c.t - a.t), 0, 1) : 0;
      const nx = a.x + (c.x - a.x) * k, ny = a.y + (c.y - a.y) * k, nz = a.z + (c.z - a.z) * k;
      if (dt > 0) { f.vel.x += ((nx - f.pos.x) / dt - f.vel.x) * 0.3; f.vel.z += ((nz - f.pos.z) / dt - f.vel.z) * 0.3; }
      f.pos.set(nx, ny, nz);
      f.yaw = a.yaw + angleDiff(a.yaw, c.yaw) * k;
      f.pitch = a.pitch + (c.pitch - a.pitch) * k;
      const fl = c.flags;
      f.crouching = !!(fl & 2); f.height = f.crouching ? 1.05 : 1.7;
      f.shieldT = fl & 4 ? 0.2 : 0;
      f.ai.charge = fl & 8 ? 0 : -1;
      f.walkPhase += dt * Math.hypot(f.vel.x, f.vel.z) * 2.2;
    }
  }

  function handleEvent(e) {
    switch (e.k) {
      case 'shot': {
        const f = byId(e.id), w = C.WEAPONS[e.w];
        if (!f || !w) return;
        const from = f.mesh ? muzzleWorld(f, new V3()) : v3(e.o);
        for (const end of e.e) {
          const to = v3(end);
          spawnTracer(from, to, w.color, w.id === 'precision' ? 0.05 : w.id === 'laser' ? 0.035 : w.id === 'rapid' ? 0.018 : 0.022, w.id === 'precision' ? 0.22 : 0.09);
          burst(to, [w.color, 0xffffff], 2, 2.5, 0.07, 0.3, 4);
        }
        Sfx.shot(w.id, volumeAt(from) * 0.6);
        return;
      }
      case 'proj': {
        const f = byId(e.id), w = C.WEAPONS[e.w];
        if (!f || !w) return;
        spawnProjectile(f, { x: e.o[0], y: e.o[1], z: e.o[2] }, { x: 0, y: 0, z: -1 }, { weapon: w, vel: { x: e.v[0], y: e.v[1], z: e.v[2] }, color: e.c, pid: e.pid });
        Sfx.shot(w.id, volumeAt(v3(e.o)) * 0.6);
        return;
      }
      case 'impact': case 'boom': {
        if (player && e.id === player.id) return; // our own shot was already shown when we fired
        const pr = projectiles.find((p) => p.active && p.pid === e.pid);
        if (pr) deactivate(pr);
        const pt = v3(e.p);
        if (e.k === 'boom') explode(pt, byId(e.id) || player, C.WEAPONS[e.w], null, e.c, e.n ? { x: e.n[0], y: e.n[1], z: e.n[2] } : null, true);
        else burst(pt, [0xffffff, 0x22d3ff], 4, 2, 0.06, 0.3, 4);
        return;
      }
      case 'hit':
        showHitmarker(!!e.h, e.a === 0);
        if (e.a > 0) { Sfx.hit(!!e.h); floatNumber(v3(e.at), e.a, !!e.h); state.matchHits++; }
        return;
      case 'dmg': {
        const v = byId(e.v), from = byId(e.f);
        if (!v) return;
        if (v.isPlayer) { Sfx.hurt(); if (from && from !== v) hurtFlash(from); v.lastHurt = state.time; }
        else { v.hitFlash = 0.12; burst(new V3(v.pos.x, v.pos.y + 1, v.pos.z), [0xffffff, v.team ? TEAM_COLOR[v.team] : 0xffd60a], 5, 3, 0.07, 0.35, 5); }
        return;
      }
      case 'elim': {
        const v = byId(e.v), k = e.by ? byId(e.by) : null;
        if (!v) return;
        if (!v.alive && !v.isPlayer) { addKillfeed(k, v); return; }
        v.alive = false; v.health = 0;
        burst(new V3(v.pos.x, Math.max(v.pos.y, -10) + 1, v.pos.z), SPARKS.concat([v.color]), 36, 7, 0.12, 1.4, 12);
        if (v.mesh) v.mesh.group.visible = false;
        addKillfeed(k, v);
        if (k && k.isPlayer) { Sfx.elim(); banner(`Blasted ${v.name}!`); }
        if (v.isPlayer) {
          Sfx.pop();
          $('deathBy').textContent = k ? `Blasted by ${k.name}` : 'You took a tumble!';
          $('deathOverlay').hidden = false; $('hurt').style.opacity = 0; $('scope').hidden = true;
          player.respawnT = match.mode.respawn;
        }
        return;
      }
      case 'spawn': {
        const f = byId(e.id);
        if (!f) return;
        if (f.isPlayer) resetPlayerAt(e.p, e.yaw);
        else { f.buf = []; f.pos.set(e.p[0], e.p[1], e.p[2]); f.yaw = e.yaw; f.alive = true; f.shieldT = 1.2; if (f.mesh) f.mesh.group.visible = true; }
        return;
      }
      case 'push':
        player.vel.x += e.v[0]; player.vel.y += e.v[1]; player.vel.z += e.v[2];
        player.grounded = false; player.airCap = Math.max(player.airCap, Math.hypot(player.vel.x, player.vel.z));
        return;
      case 'correct':
        player.pos.set(e.p[0], e.p[1], e.p[2]); player.vel.set(0, 0, 0);
        return;
      case 'ammo': {
        const id = player.weaponIds[e.w];
        if (id == null) return;
        player.ammo[id] = e.n;
        if (e.r && player.reloadT <= 0 && player.wIndex === e.w) player.reloadT = C.WEAPONS[id].reload * 0.9;
        return;
      }
      case 'left': {
        const f = byId(e.id);
        if (!f || f.isPlayer) return;
        if (f.mesh) scene.remove(f.mesh.group);
        fighters = fighters.filter((x) => x !== f);
        toast(`${f.name} left the match`);
        return;
      }
    }
  }

  function updateOnline(dt) {
    const inp = readInput(dt);
    if (state.phase === 'countdown') {
      state.countdown -= dt;
      const n = Math.ceil(state.countdown);
      if (n !== state.lastBeep) { state.lastBeep = n; if (n > 0) { Sfx.beep(false); hud.count.textContent = n; hud.count.className = 'countdown pop'; } }
      if (state.countdown <= 0) {
        state.phase = 'play'; Sfx.beep(true);
        hud.count.textContent = 'GO!'; hud.count.className = 'countdown pop go';
        setTimeout(() => { hud.count.className = 'countdown'; }, 700);
      }
    }
    const frozen = state.phase === 'countdown' || !!state.screen || chatOpen;
    if (frozen) { inp.fire = false; }
    updatePlayer(dt, inp, frozen);
    if (!player.alive) player.respawnT = Math.max(0, (player.respawnT || 0) - dt);
    state.sendT -= dt;
    if (state.sendT <= 0) {
      state.sendT = 1 / 30;
      const p = player;
      net.send({ t: 'input', p: [r3(p.pos.x), r3(p.pos.y), r3(p.pos.z)], yaw: r3(p.yaw), pitch: r3(p.pitch), cr: p.crouching ? 1 : 0, ch: p.charge > 0 ? 1 : 0, w: p.wIndex });
    }
    interpolateRemotes(dt);
    updateProjectiles(dt);
    for (const f of fighters) if (!f.isPlayer) syncBotMesh(f, dt);
    updateEffects(dt); updateHud(dt);
  }

  function endOnlineMatch(msg) {
    const res = msg.results;
    state.phase = 'results';
    state.voted = false;
    releaseLock();
    const me = player ? player.id : null;
    const mine = res.rows.find((r) => r.id === me);
    const won = res.winnerTeam ? !!mine && mine.team === res.winnerTeam : res.winnerId === me;
    const draw = !res.winnerTeam && !res.winnerId;
    const title = won ? 'Victory!' : draw ? 'Draw!' : 'Defeat';
    if (won) { Sfx.win(); celebrate(); } else Sfx.lose();
    const st = store.stats;
    st.matches++; if (won) st.wins++;
    if (mine) { st.kills += mine.kills; st.deaths += mine.deaths; }
    st.shots += state.matchShots; st.hits += state.matchHits;
    persist();
    let sub = res.teamScores ? `Blue ${res.teamScores.blue} \u2013 ${res.teamScores.orange} Orange` : res.reason === 'time' ? 'Time ran out' : '';
    if (res.reason === 'forfeit') sub = 'The other side left the match';
    if (mine) sub += (sub ? ' \u00b7 ' : '') + `${mine.kills} blasts`;
    if (res.ranked) sub += ` \u00b7 Rating ${msg.ratingChange >= 0 ? '+' : ''}${msg.ratingChange} (${msg.rating})`;
    $('resultTitle').textContent = title;
    $('resultTitle').className = 'result-title ' + (title === 'Defeat' ? 'lose' : 'win');
    $('resultSub').textContent = sub;
    const rows = $('resultRows');
    rows.innerHTML = '';
    res.rows.forEach((r, i) => {
      const tr = document.createElement('tr');
      tr.dataset.id = r.id; tr.dataset.name = r.name;
      if (r.id === me) tr.className = 'me';
      const td = (t) => { const c = document.createElement('td'); c.textContent = t; return c; };
      tr.appendChild(td(String(i + 1)));
      const nameTd = document.createElement('td');
      const dot = document.createElement('span'); dot.className = 'dot';
      dot.style.background = hex(r.team ? TEAM_COLOR[r.team] : r.id === me ? 0xffd60a : 0x8a97a8);
      nameTd.append(dot, (r.id === me ? 'You' : r.name) + (r.team ? ` (${TEAM_NAME[r.team]})` : ''));
      tr.appendChild(nameTd); tr.appendChild(td(String(r.kills))); tr.appendChild(td(String(r.deaths)));
      rows.appendChild(tr);
    });
    $('resultTable').hidden = false;
    $('deathOverlay').hidden = true; $('hud').hidden = true; $('touch').hidden = true; $('scope').hidden = true; $('chatPanel').hidden = true;
    $('rematchBtn').textContent = 'Rematch';
    showScreen('results');
    renderStats();
  }

  // Toasts and quick chat
  function toast(text, actions) {
    const box = $('toasts');
    const el = document.createElement('div');
    el.className = 'toast';
    const span = document.createElement('span'); span.textContent = text; el.appendChild(span);
    (actions || []).forEach((a) => { const b = document.createElement('button'); b.className = 'mini-btn'; b.textContent = a.label; b.addEventListener('click', () => { el.remove(); a.run(); }); el.appendChild(b); });
    box.appendChild(el);
    setTimeout(() => el.remove(), actions && actions.length ? 15000 : 4000);
  }
  function showChat(name, text) {
    if (!store.settings.quickChat) return;
    const el = document.createElement('div');
    el.className = 'kf chat';
    const b = document.createElement('b'); b.textContent = name + ': ';
    el.append(b, text);
    const feed = $('killfeed');
    feed.prepend(el);
    while (feed.children.length > 5) feed.lastChild.remove();
    setTimeout(() => el.remove(), 5000);
  }
  function toggleChat(open) {
    chatOpen = open == null ? !chatOpen : open;
    $('chatPanel').hidden = !chatOpen;
    if (chatOpen) releaseLock();
  }
  $('chatBtn').addEventListener('click', (e) => { e.stopPropagation(); toggleChat(); });
  $('chatPanel').addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.i != null) net.send({ t: 'chat', i: Number(b.dataset.i) });
    toggleChat(false);
  });
  window.addEventListener('keydown', (e) => { if (e.code === 'KeyV' && state.online && state.phase !== 'results' && store.settings.quickChat) toggleChat(); });

  // ======================================================================
  // Main loop
  // ======================================================================
  function update(dt) {
    state.time += dt;
    state.shake = Math.max(0, state.shake - dt * 2);
    if (state.phase === 'paused') return;
    if (state.phase === 'menu' || !player) {
      state.menuAngle += dt * 0.08;
      camera.position.set(Math.cos(state.menuAngle) * 40, 20, Math.sin(state.menuAngle) * 40);
      camera.lookAt(0, 1, 0);
      if (camera.fov !== store.settings.fov) { camera.fov = store.settings.fov; camera.updateProjectionMatrix(); }
      updateEffects(dt);
      if (lockerChar && state.screen === 'locker') animateLocker(dt);
      return;
    }
    if (state.phase === 'results') { updateEffects(dt); updateProjectiles(dt); return; }
    if (state.online) { updateOnline(dt); return; }

    const inp = readInput(dt);
    if (state.phase === 'countdown') {
      state.countdown -= dt;
      const n = Math.ceil(state.countdown);
      if (n !== state.lastBeep) {
        state.lastBeep = n;
        if (n > 0) { Sfx.beep(false); hud.count.textContent = n; hud.count.className = 'countdown pop'; }
      }
      if (state.countdown <= 0) {
        state.phase = 'play'; Sfx.beep(true);
        hud.count.textContent = 'GO!'; hud.count.className = 'countdown pop go';
        setTimeout(() => { hud.count.className = 'countdown'; }, 700);
      }
      updatePlayer(dt, inp, true);
      for (const f of fighters) if (!f.isPlayer) syncBotMesh(f, dt);
      updateTargets(dt); updateEffects(dt); updateHud(dt);
      return;
    }

    C.tickMatch(match, dt);
    updatePlayer(dt, inp, false);
    for (const f of fighters) {
      if (!f.alive) {
        if (match.mode.respawn > 0) { f.respawnT -= dt; if (f.respawnT <= 0 && !match.over) respawn(f); }
        continue;
      }
      if (!f.isPlayer) updateBot(f, dt);
      if (f.alive && f.health < C.MAX_HEALTH && state.time - f.lastHurt > 3.5) f.health = Math.min(C.MAX_HEALTH, f.health + 20 * dt);
    }
    updateProjectiles(dt);
    for (const f of fighters) if (!f.isPlayer) syncBotMesh(f, dt);
    updateTargets(dt); updateEffects(dt); updateHud(dt);
    if (match.over) {
      if (state.endT == null) state.endT = match.reason === 'time' ? 0 : 0.9;
      state.endT -= dt;
      if (state.endT <= 0) { state.endT = null; endMatch(); }
    }
  }

  function animateLocker(dt) {
    lockerYaw += dt * 0.25;
    lockerChar.group.rotation.y = lockerYaw;
    lockerChar.group.position.y = Math.abs(Math.sin(state.time * 2)) * 0.03;
    const hand = lockerChar.hands[0];
    if (lockerWave > 0) {
      lockerWave -= dt;
      hand.position.set(-0.55 + Math.sin(state.time * 14) * 0.08, 1.55, -0.1);
    } else hand.position.set(-0.5, 0.82, -0.18);
  }

  function render() {
    renderer.clear();
    if (state.screen === 'locker' && lockerChar) { renderer.render(lockerScene, lockerCam); return; }
    renderer.render(scene, camera);
    if (player && player.alive && (state.phase === 'play' || state.phase === 'countdown' || state.phase === 'paused')) {
      const p = player, w = weaponOf(p);
      if (p.ads && w.zoom) return; // scope overlay replaces the held blaster
      vmKick = Math.max(0, vmKick - 0.016 * 9);
      vmSwap = Math.max(0, vmSwap - 0.016 * 4);
      const reloadDip = p.reloadT > 0 && w.reload ? Math.sin(Math.min(1, 1 - p.reloadT / w.reload) * Math.PI) * 0.18 : 0;
      const adsX = p.ads ? -0.28 : 0, adsY = p.ads ? 0.1 : 0;
      vm.position.set(VM_BASE.x + adsX + Math.sin(vmBob) * 0.012, VM_BASE.y + adsY - vmSwap * 0.3 - reloadDip + Math.abs(Math.cos(vmBob)) * 0.01, VM_BASE.z + vmKick * 0.07);
      vm.rotation.set(vmKick * 0.12 + reloadDip * 1.5, 0, p.slideT > 0 ? 0.25 : 0);
      if (vmBow) {
        const pull = p.charge * 0.16;
        vmBow.string.position.z = pull; vmBow.arrow.position.z = pull - 0.3; vmBow.arrow.visible = p.cool <= 0.05;
      }
      vmCamera.fov = p.ads ? 50 : 60; vmCamera.updateProjectionMatrix();
      renderer.clearDepth();
      renderer.render(vmScene, vmCamera);
    }
  }

  let last = performance.now();
  function frame(now) {
    if (crashed) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    try { update(dt); render(); }
    catch (e) { console.error(e); showFatal('Something went wrong: ' + e.message); }
  }
  loadMap(store.settings.mode === 'practice' ? 'yard' : store.settings.map);
  syncMapVisibility();
  showScreen('menu');
  $('loading').hidden = true;
  requestAnimationFrame(frame);

  // Hand the online layer what it needs (online.js owns the socket and lobby screens).
  BA.game = {
    store, persist, Sfx, isTouch, showScreen, renderStats, releaseLock, toast, showChat,
    startOnlineMatch, applySnapshot, endOnlineMatch, leaveOnlineMatch,
    setNet(n) { net = n; }, hooks: onlineHooks, get state() { return state; },
    setChatPhrases(list) { $('chatPanel').innerHTML = list.map((t, i) => `<button class="chip-btn" data-i="${i}">${t.replace(/[<&>]/g, '')}</button>`).join(''); }
  };
  if (BA.initOnline) BA.initOnline(BA.game);

  // Debug/test hook (used by the automated tests)
  window.__blast = { state, world, get fighters() { return fighters; }, get match() { return match; }, get player() { return player; }, startMatch, loadMap, C, store };
})();
