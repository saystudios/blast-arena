/*
 * Builds map collision (boxes + spawns) on the server from the same src/maps.js the client uses.
 * Decorations are skipped. The composite helpers below must match the collision part of game.js's ctx;
 * tests/smoke.js compares both box lists to guarantee they agree.
 */
'use strict';
const path = require('path');
const C = require('../src/core.js');

global.window = global.window || {};
require(path.join(__dirname, '..', 'src', 'maps.js'));
const BA = global.window.BA;

const cache = {};

function headlessCtx(boxes) {
  const none = () => null;
  const ctx = {
    tex: { checker: none, grid: none, stripes: none, choc: none, windows: none },
    mat: none, deco: none, scroll: none, glowBar: none, cloud: none, fan: none, tank: none, sign: none,
    skyscraper: none, moon: none, mixer: none, gumdrop: none, lollipop: none, pipe: none, farIsland: none,
    box(cx, y0, cz, w, h, d, color, opt) {
      opt = opt || {};
      const b = { min: { x: cx - w / 2, y: y0, z: cz - d / 2 }, max: { x: cx + w / 2, y: y0 + h, z: cz + d / 2 } };
      if (opt.belt) b.belt = opt.belt;
      if (opt.pad) b.pad = opt.pad;
      if (opt.noNav) b.noNav = true;
      boxes.push(b);
      return null;
    },
    stairs(x0, z0, dx, dz, steps, stepH, stepD, width) {
      for (let i = 0; i < steps; i++) {
        const off = (i + 0.5) * stepD, h = (steps - i) * stepH;
        ctx.box(x0 + dx * off, 0, z0 + dz * off, dx ? stepD : width, h, dx ? width : stepD);
      }
    },
    island(x, z, w, d, topY) { topY = topY || 0; ctx.box(x, topY - 3, z, w, 3, d); },
    bridge(x, z, w, d) { ctx.box(x, -0.35, z, w, 0.35, d); },
    pad(x, z, vec) { ctx.box(x, 0, z, 1.6, 0.2, 1.6, null, { pad: vec }); }
  };
  return ctx;
}

/** Returns { id, name, boxes, spawns, voidY, bounds } for a map id. */
function getMap(id) {
  if (cache[id]) return cache[id];
  const m = BA.MAPS[id];
  if (!m) throw new Error('Unknown map ' + id);
  const boxes = [];
  const spawns = m.build(headlessCtx(boxes)).map((s) => {
    const g = C.groundAt(boxes, s.x, s.z, 30);
    return { x: s.x, z: s.z, y: g ? g.y : 0, team: s.team || null };
  });
  cache[id] = { id, name: m.name, boxes, spawns, voidY: m.voidY == null ? null : m.voidY, bounds: m.bounds };
  return cache[id];
}

module.exports = { getMap, MAP_IDS: BA.MAP_ORDER.slice(), ONLINE_MAPS: BA.MAP_ORDER.filter((id) => id !== 'yard') };
