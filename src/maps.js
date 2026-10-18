/*
 * Blast Arena — maps. Each map is data plus a build(ctx) function that places boxes.
 * Collision is boxes only (fast, predictable, server-friendly). Decorations have no collision.
 * To add a map: add an entry to BA.MAPS with the same shape, and put its id in BA.MAP_ORDER.
 * Spawns: { x, z, team } where team is 'blue', 'orange' or omitted (free-for-all only).
 */
(function () {
  'use strict';
  const BA = (window.BA = window.BA || {});
  const C = {
    navy: 0x1b2a44, steel: 0x8a97a8, blue: 0x2f7bff, cyan: 0x22d3ff, lime: 0x9dff2e, green: 0x3fbf3f,
    orange: 0xff7a1a, red: 0xe63a2e, yellow: 0xffd60a, white: 0xf4f8ff, choc: 0x6b3e26, dark: 0x252f45
  };

  function teamSpawns(list, team) { return list.map(([x, z]) => ({ x, z, team })); }
  function mirror(list) { return list.map(([x, z]) => [x, -z]); }

  // ------------------------------------------------------------------ Training Yard
  const yard = {
    id: 'yard', name: 'Training Yard', blurb: 'Blocks, ramps and towers. Practice range.',
    sky: 0x86ccff, fog: [70, 160], hemi: [0xffffff, 0x7f9bb8, 0.95], sun: [0xfff1d6, 0.85],
    bounds: { minX: -32, maxX: 32, minZ: -32, maxZ: 32 },
    build(ctx) {
      ctx.box(0, -1, 0, 66, 1, 66, null, { material: ctx.mat(0xffffff, { map: ctx.tex.checker('#5b6b86', '#53627c', 16) }), edges: false, cast: false });
      const WH = 7;
      ctx.box(0, 0, -32.5, 66, WH, 1, C.navy); ctx.box(0, 0, 32.5, 66, WH, 1, C.navy);
      ctx.box(-32.5, 0, 0, 1, WH, 64, C.navy); ctx.box(32.5, 0, 0, 1, WH, 64, C.navy);
      ctx.box(0, 0, 0, 8, 3, 8, C.orange);
      ctx.stairs(0, 4, 0, 1, 8, 0.375, 0.9, 3, C.yellow);
      ctx.stairs(0, -4, 0, -1, 8, 0.375, 0.9, 3, C.yellow);
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        ctx.box(22 * sx, 0, 22 * sz, 8, 2.25, 8, C.green);
        ctx.stairs(18 * sx, 22 * sz, -sx, 0, 6, 0.375, 0.9, 3, C.steel);
      }
      ctx.box(0, 0, 12.5, 7, 1.3, 1, C.blue); ctx.box(0, 0, -12.5, 7, 1.3, 1, C.blue);
      ctx.box(12.5, 0, 0, 1, 1.3, 7, C.blue); ctx.box(-12.5, 0, 0, 1, 1.3, 7, C.blue);
      for (const [x, z] of [[8, 18], [-8, -18], [18, -8], [-18, 8], [6, -21], [-6, 21], [24, 6], [-24, -6]]) ctx.box(x, 0, z, 1.8, 1.8, 1.8, C.yellow);
      ctx.box(8, 1.8, 18, 1.8, 1.8, 1.8, C.red); ctx.box(-8, 1.8, -18, 1.8, 1.8, 1.8, C.red);
      for (const [x, z] of [[10, -10], [-10, 10], [14, 14], [-14, -14]]) ctx.box(x, 0, z, 2, 5, 2, C.dark);
      for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2; ctx.cloud(Math.cos(a) * 95, 30 + (i % 3) * 6, Math.sin(a) * 95, 3); }
      const blue = [[0, 27], [12, 27], [-12, 27], [27, 8], [-27, 8]];
      return teamSpawns(blue, 'blue').concat(teamSpawns(mirror(blue), 'orange'));
    }
  };

  // ------------------------------------------------------------------ Neon City
  const neon = {
    id: 'neon', name: 'Neon City', blurb: 'Night rooftops, bridges and glowing signs.',
    sky: 0x0a1028, fog: [45, 130], hemi: [0x6f8fff, 0x1a1636, 0.6], sun: [0x9fb8ff, 0.5],
    bounds: { minX: -32, maxX: 32, minZ: -32, maxZ: 32 },
    build(ctx) {
      ctx.box(0, -1, 0, 66, 1, 66, null, { material: ctx.mat(0xffffff, { map: ctx.tex.grid('#161d2e', '#22d3ff', 22) }), edges: false, cast: false });
      // Parapet + invisible tall walls
      for (const [x, z, w, d] of [[0, -32.6, 66, 0.8], [0, 32.6, 66, 0.8], [-32.6, 0, 0.8, 66], [32.6, 0, 0.8, 66]]) {
        ctx.box(x, 0, z, w, 1.2, d, 0x2a3550);
        ctx.deco(ctx.glowBar(x, 1.25, z, w, 0.08, d, C.cyan));
        ctx.box(x * 1.02, 1.2, z * 1.02, w, 12, d, null, { invisible: true });
      }
      const neonEdge = (x, y, z, w, d, color) => ctx.deco(ctx.glowBar(x, y, z, w, 0.12, d, color));
      // North and south buildings with stairs and a bridge between them
      for (const s of [-1, 1]) {
        ctx.box(0, 0, 20 * s, 24, 3, 8, 0x334066);
        neonEdge(0, 3.02, 16 * s, 24, 0.12, s < 0 ? C.orange : C.cyan);
        for (const x of [-8, 8]) ctx.stairs(x, 16 * s, 0, -s, 8, 0.375, 0.9, 3, 0x46557a);
      }
      ctx.box(0, 2.6, 0, 3, 0.4, 32, 0x3b4a6e);
      for (const x of [-1.6, 1.6]) neonEdge(x, 3.05, 0, 0.1, 32, C.lime);
      // Side towers with long stairs
      for (const s of [-1, 1]) {
        ctx.box(24 * s, 0, 0, 8, 4.5, 12, 0x2c3858);
        neonEdge(20 * s, 4.52, 0, 0.12, 12, C.orange);
        ctx.stairs(20 * s, 0, -s, 0, 12, 0.375, 0.9, 3, 0x46557a);
      }
      // Rooftop clutter: AC units, tanks, signs
      for (const [x, z] of [[12, 4], [-12, -4], [12, -4], [-12, 4]]) {
        ctx.box(x, 0, z, 2.2, 1.4, 2.2, 0x9aa6b8);
        ctx.deco(ctx.fan(x, 1.42, z));
      }
      for (const [x, z] of [[5, 0], [-5, 0]]) ctx.box(x, 0, z, 2, 1.2, 2.2, 0x9aa6b8);
      for (const [x, z] of [[20, 14], [-20, -14], [20, -14], [-20, 14]]) {
        ctx.box(x, 0, z, 3, 3, 3, null, { invisible: true });
        ctx.deco(ctx.tank(x, z));
      }
      const signs = [[6, 6, C.cyan], [-6, -6, C.orange], [-6, 6, C.lime], [6, -6, C.red]];
      for (const [x, z, col] of signs) {
        ctx.box(x, 0, z, 3, 2.5, 0.4, 0x141b2b);
        ctx.deco(ctx.sign(x, 1.35, z + (z > 0 ? -0.21 : 0.21), col, z > 0 ? Math.PI : 0));
      }
      // Skyline
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * Math.PI * 2 + Math.random() * 0.1, r = 52 + Math.random() * 40;
        ctx.deco(ctx.skyscraper(Math.cos(a) * r, Math.sin(a) * r, 6 + Math.random() * 8, 10 + Math.random() * 40));
      }
      ctx.deco(ctx.moon(-60, 70, -110));
      const blue = [[0, 28], [6, 28], [-6, 28], [16, 28], [-16, 28]];
      return teamSpawns(blue, 'blue').concat(teamSpawns(mirror(blue), 'orange'), [{ x: 28, z: 12 }, { x: -28, z: -12 }]);
    }
  };

  // ------------------------------------------------------------------ Candy Factory
  const candy = {
    id: 'candy', name: 'Candy Factory', blurb: 'Conveyor belts, catwalks and giant sweets.',
    sky: 0x8fd3ff, fog: [70, 170], hemi: [0xffffff, 0x8aa4c0, 1.0], sun: [0xfff4e0, 0.75],
    bounds: { minX: -32, maxX: 32, minZ: -32, maxZ: 32 },
    build(ctx) {
      ctx.box(0, -1, 0, 66, 1, 66, null, { material: ctx.mat(0xffffff, { map: ctx.tex.checker('#cfd9e6', '#bfcbdb', 18) }), edges: false, cast: false });
      // Factory walls with stripes
      const wallMat = ctx.mat(0xffffff, { map: ctx.tex.stripes('#2f7bff', '#1f5ed6', 10, 1, false) });
      ctx.box(0, 0, -32.5, 66, 9, 1, null, { material: wallMat }); ctx.box(0, 0, 32.5, 66, 9, 1, null, { material: wallMat });
      ctx.box(-32.5, 0, 0, 1, 9, 64, null, { material: wallMat }); ctx.box(32.5, 0, 0, 1, 9, 64, null, { material: wallMat });
      // Conveyor belts (they carry you)
      for (const [z, dir] of [[10, 1], [-10, -1]]) {
        const tex = ctx.tex.stripes('#2b2f3a', '#ffd60a', 14, 1, true);
        ctx.box(0, 0, z, 28, 0.3, 4, null, { material: ctx.mat(0xffffff, { map: tex }), belt: { x: 4 * dir, z: 0 }, edges: false });
        ctx.scroll(tex, -0.28 * dir, 0);
        for (const zz of [z - 2.15, z + 2.15]) ctx.deco(ctx.glowBar(0, 0.32, zz, 28, 0.06, 0.25, C.orange));
      }
      // Candy mixer tower in the middle
      ctx.box(0, 0, 0, 8, 3.75, 8, C.orange);
      ctx.stairs(4, 0, 1, 0, 10, 0.375, 0.9, 3, C.yellow);
      ctx.stairs(-4, 0, -1, 0, 10, 0.375, 0.9, 3, C.yellow);
      ctx.box(0, 3.75, 0, 2, 1.5, 2, null, { invisible: true });
      ctx.deco(ctx.mixer(0, 3.75, 0));
      // Gumdrops
      const gumColors = [C.lime, C.red, C.blue, C.yellow];
      [[8, 5], [-8, -5], [8, -5], [-8, 5]].forEach(([x, z], i) => {
        ctx.box(x, 0, z, 2.4, 2, 2.4, null, { invisible: true });
        ctx.deco(ctx.gumdrop(x, z, gumColors[i]));
      });
      // Lollipop trees and candy-cane pillars
      for (const s of [-1, 1]) {
        ctx.box(20 * s, 0, 0, 0.5, 4.2, 0.5, 0xf4f8ff);
        ctx.deco(ctx.lollipop(20 * s, 4.6, 0, s > 0 ? C.orange : C.lime));
      }
      for (const [x, z] of [[14, 16], [-14, 16], [14, -16], [-14, -16]]) {
        ctx.box(x, 0, z, 1, 6, 1, null, { material: ctx.mat(0xffffff, { map: ctx.tex.stripes('#e63a2e', '#f4f8ff', 1, 6, true) }) });
      }
      // Chocolate crates
      for (const [x, z] of [[4, 18], [-4, -18], [20, 6], [-20, -6], [20, -6], [-20, 6]]) {
        ctx.box(x, 0, z, 2.2, 1.5, 1.6, null, { material: ctx.mat(0xffffff, { map: ctx.tex.choc() }) });
      }
      // Catwalks along both side walls
      for (const s of [-1, 1]) {
        ctx.box(26 * s, 2.6, 0, 6, 0.4, 32, 0x4a5568);
        ctx.deco(ctx.glowBar(23 * s, 3.05, 0, 0.1, 32, 0.1, C.lime));
        for (const z of [-15, -5, 5, 15]) ctx.box(23.4 * s, 0, z, 0.4, 2.6, 0.4, 0x4a5568);
        ctx.stairs(26 * s, 16, 0, 1, 8, 0.375, 0.9, 3, 0x6b7891);
        ctx.stairs(26 * s, -16, 0, -1, 8, 0.375, 0.9, 3, 0x6b7891);
      }
      // Pipes overhead (decoration)
      for (const z of [-22, 22]) ctx.deco(ctx.pipe(0, 7.5, z, 64, z > 0 ? C.lime : C.orange));
      const blue = [[0, 27], [10, 27], [-10, 27], [18, 27], [-18, 27]];
      return teamSpawns(blue, 'blue').concat(teamSpawns(mirror(blue), 'orange'), [{ x: 29, z: 27 }, { x: -29, z: -27 }]);
    }
  };

  // ------------------------------------------------------------------ Sky Islands
  const sky = {
    id: 'sky', name: 'Sky Islands', blurb: 'Floating islands and bridges. Don’t fall!',
    sky: 0x7cc8ff, fog: [80, 190], hemi: [0xffffff, 0x6aa0c8, 1.0], sun: [0xfff4e0, 0.85],
    bounds: { minX: -32, maxX: 32, minZ: -32, maxZ: 32 }, voidY: -14,
    build(ctx) {
      ctx.island(0, 0, 14, 14);
      for (const sx of [-1, 1]) ctx.box(3 * sx, 0, 0, 1.2, 3, 1.2, 0xb8c2cf);
      ctx.box(0, 3, 0, 7.2, 0.6, 1.2, 0xb8c2cf);
      ctx.box(0, 0, 4.5, 1.6, 1.1, 1.6, 0x8a8f99); ctx.box(0, 0, -4.5, 1.6, 1.1, 1.6, 0x8a8f99);
      const outer = [[0, 24], [0, -24], [24, 0], [-24, 0]];
      for (const [x, z] of outer) ctx.island(x, z, 12, 12);
      // Bridges
      ctx.bridge(0, 12.5, 2.4, 11, true); ctx.bridge(0, -12.5, 2.4, 11, true);
      ctx.bridge(12.5, 0, 11, 2.4, false); ctx.bridge(-12.5, 0, 11, 2.4, false);
      // Cover on outer islands
      for (const s of [-1, 1]) {
        ctx.box(4.5, 0, 19.5 * s, 1.6, 1.4, 1.6, 0x8a8f99); ctx.box(-4.5, 0, 19.5 * s, 1.6, 1.4, 1.6, 0x8a8f99);
        ctx.box(27 * s, 0, 0, 2.5, 2.4, 4, C.orange);   // huts
        ctx.box(20 * s, 0, 3.5, 1.4, 1.2, 1.4, C.blue); ctx.box(20 * s, 0, -3.5, 1.4, 1.2, 1.4, C.blue);
      }
      // Corner sky platforms reached by jump pads
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        ctx.island(17 * sx, 17 * sz, 6, 6, 2.5);
        ctx.box(17 * sx, 2.5, 17 * sz, 1.4, 1.2, 1.4, C.yellow);
      }
      // Each pad launches toward the next corner platform (clockwise)
      ctx.pad(22, 4.5, { x: -6.2, y: 12, z: 15.5 });
      ctx.pad(-22, -4.5, { x: 6.2, y: 12, z: -15.5 });
      ctx.pad(4.5, -22, { x: 15.5, y: 12, z: 6.2 });
      ctx.pad(-4.5, 22, { x: -15.5, y: 12, z: -6.2 });
      // Invisible far walls so rocket jumps can't leave the map
      for (const [x, z, w, d] of [[0, -42, 90, 1], [0, 42, 90, 1], [-42, 0, 1, 90], [42, 0, 1, 90]]) ctx.box(x, -20, z, w, 60, d, null, { invisible: true, noNav: true });
      for (let i = 0; i < 26; i++) ctx.cloud((Math.random() - 0.5) * 160, -16 - Math.random() * 10, (Math.random() - 0.5) * 160, 4 + Math.random() * 3);
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; ctx.deco(ctx.farIsland(Math.cos(a) * 85, -4 + Math.random() * 12, Math.sin(a) * 85)); }
      const blue = [[0, 21], [3, 23], [-2, 26], [3, 27.5], [-4.5, 27.5]];
      const orange = blue.map(([x, z]) => [-x, -z]); // point mirror keeps spawns off the jump pads
      return teamSpawns(blue, 'blue').concat(teamSpawns(orange, 'orange'), [{ x: 24, z: -3 }, { x: -24, z: 3 }, { x: 25, z: 3 }, { x: -25, z: -3 }]);
    }
  };

  BA.MAPS = { neon, candy, sky, yard };
  BA.MAP_ORDER = ['neon', 'candy', 'sky', 'yard'];
})();
