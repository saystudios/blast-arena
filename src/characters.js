/*
 * Blast Arena — original cartoon character builder and outfit options.
 * Used for bots, the player's own character in the Locker preview, and (Phase 3) other online players.
 */
(function () {
  'use strict';
  const BA = (window.BA = window.BA || {});

  const OUTFIT = {
    skins: [0xffe0c2, 0xf3c69c, 0xd9a273, 0xb4794c, 0x8a5a36, 0x5c3a22],
    hairColors: [0x1b1b1f, 0x5a3a1e, 0xd9a441, 0xb5532a, 0x2f6bff, 0xe8e8ec],
    shirts: [0x2f7bff, 0xe63a2e, 0x3fbf3f, 0xff7a1a, 0x23262e, 0x5b6b3a, 0x8a97a8, 0x14b8d6, 0xffc21a],
    pants: [0x1f2a44, 0x2b2b30, 0x4a5568, 0x3d5a2a, 0x6b4a2b, 0x2f6bff],
    hairs: [
      { id: 'spiky', name: 'Spiky' }, { id: 'buzz', name: 'Buzz' }, { id: 'mohawk', name: 'Mohawk' },
      { id: 'cap', name: 'Cap' }, { id: 'helmet', name: 'Helmet' }, { id: 'beanie', name: 'Beanie' }
    ],
    accessories: [
      { id: 'none', name: 'None' }, { id: 'goggles', name: 'Goggles' }, { id: 'headphones', name: 'Headphones' },
      { id: 'jetpack', name: 'Jetpack' }, { id: 'bandana', name: 'Bandana' }
    ]
  };
  const DEFAULT_OUTFIT = { skin: 1, hair: 'spiky', hairColor: 0, shirt: 0, pants: 0, acc: 'none' };

  function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function randomOutfit() {
    return {
      skin: Math.floor(Math.random() * OUTFIT.skins.length),
      hair: pick(OUTFIT.hairs).id,
      hairColor: Math.floor(Math.random() * OUTFIT.hairColors.length),
      shirt: Math.floor(Math.random() * OUTFIT.shirts.length),
      pants: Math.floor(Math.random() * OUTFIT.pants.length),
      acc: Math.random() < 0.35 ? 'none' : pick(OUTFIT.accessories).id
    };
  }
  function cleanOutfit(o) {
    const d = Object.assign({}, DEFAULT_OUTFIT, o || {});
    const idx = (v, n) => (Number.isInteger(v) && v >= 0 && v < n ? v : 0);
    d.skin = idx(d.skin, OUTFIT.skins.length); d.hairColor = idx(d.hairColor, OUTFIT.hairColors.length);
    d.shirt = idx(d.shirt, OUTFIT.shirts.length); d.pants = idx(d.pants, OUTFIT.pants.length);
    if (!OUTFIT.hairs.some((h) => h.id === d.hair)) d.hair = 'spiky';
    if (!OUTFIT.accessories.some((a) => a.id === d.acc)) d.acc = 'none';
    return d;
  }

  const shared = {};
  function std(color, extra) {
    const key = color + JSON.stringify(extra || {});
    if (!shared[key]) shared[key] = new THREE.MeshStandardMaterial(Object.assign({ color, roughness: 0.6 }, extra || {}));
    return shared[key];
  }
  const G = {}; // shared geometries
  function geo(name, make) { return G[name] || (G[name] = make()); }

  /** Small held blaster that matches the weapon's color. */
  function buildGun(weaponId) {
    const w = BlastCore.WEAPONS[weaponId] || BlastCore.WEAPONS.laser;
    const g = new THREE.Group();
    const long = weaponId === 'precision' || weaponId === 'rocket';
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.17, long ? 0.75 : 0.5), std(weaponId === 'rocket' ? 0x4b5d3a : 0x2a3346));
    body.position.z = long ? -0.12 : 0; g.add(body);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.22), std(w.color, { emissive: w.color, emissiveIntensity: 0.35 }));
    barrel.position.z = long ? -0.58 : -0.34; g.add(barrel);
    const tip = new THREE.Object3D(); tip.position.z = long ? -0.72 : -0.48; g.add(tip);
    g.userData.tip = tip;
    return g;
  }

  /**
   * Builds a character. opts: { team: 'blue'|'orange'|null, weapon }
   * Returns handles the game animates: group, shirtMat, feet, hands, marker, outline, teamBand, tip.
   */
  function buildCharacter(outfit, opts) {
    opts = opts || {};
    const o = cleanOutfit(outfit);
    const skin = OUTFIT.skins[o.skin], hairC = OUTFIT.hairColors[o.hairColor];
    const shirtC = OUTFIT.shirts[o.shirt], pantsC = OUTFIT.pants[o.pants];
    const g = new THREE.Group();
    const add = (mesh, x, y, z) => { mesh.position.set(x, y, z); mesh.castShadow = true; g.add(mesh); return mesh; };

    const shirtMat = new THREE.MeshStandardMaterial({ color: shirtC, roughness: 0.6, emissive: 0xffffff, emissiveIntensity: 0 });
    const pants = add(new THREE.Mesh(geo('pants', () => new THREE.CylinderGeometry(0.43, 0.46, 0.36, 18)), std(pantsC)), 0, 0.36, 0);
    const shirtGeo = geo('shirt', () => new THREE.CylinderGeometry(0.39, 0.43, 0.52, 18));
    const shirt = add(new THREE.Mesh(shirtGeo, shirtMat), 0, 0.8, 0);
    const outline = new THREE.Mesh(geo('outline', () => new THREE.CylinderGeometry(0.47, 0.52, 1.0, 18)), std(0xffd60a, { side: THREE.BackSide, emissive: 0xffd60a, emissiveIntensity: 0.6 }));
    outline.position.y = 0.6; outline.visible = false; g.add(outline);
    const teamBand = new THREE.Mesh(geo('band', () => new THREE.TorusGeometry(0.42, 0.06, 8, 24)), std(0xffffff));
    teamBand.rotation.x = Math.PI / 2; teamBand.position.y = 1.0; teamBand.visible = false; g.add(teamBand);
    // stripe across the chest
    add(new THREE.Mesh(geo('stripe', () => new THREE.BoxGeometry(0.5, 0.08, 0.06)), std(0xffffff, { roughness: 0.4 })), 0, 0.85, -0.4);

    const headMat = std(skin, { roughness: 0.7 });
    add(new THREE.Mesh(geo('head', () => new THREE.SphereGeometry(0.42, 22, 16)), headMat), 0, 1.38, 0);
    const white = std(0xffffff, { roughness: 0.3 }), ink = std(0x0b1426, { roughness: 0.4 });
    for (const sx of [-1, 1]) {
      const eye = add(new THREE.Mesh(geo('eye', () => new THREE.SphereGeometry(0.095, 12, 10)), white), sx * 0.15, 1.39, -0.35);
      eye.scale.set(1, 0.85, 0.6);
      add(new THREE.Mesh(geo('pupil', () => new THREE.SphereGeometry(0.052, 10, 8)), ink), sx * 0.15, 1.38, -0.42);
      const brow = add(new THREE.Mesh(geo('brow', () => new THREE.BoxGeometry(0.15, 0.035, 0.04)), std(hairC)), sx * 0.15, 1.5, -0.38);
      brow.rotation.z = sx * -0.25; // determined look
    }
    const grin = new THREE.Mesh(geo('grin', () => new THREE.TorusGeometry(0.075, 0.016, 6, 12, Math.PI)), ink);
    grin.position.set(0, 1.25, -0.39); grin.rotation.z = Math.PI; g.add(grin);

    // Hair / headwear
    const hairMat = std(hairC, { roughness: 0.8 });
    const capMat = std(shirtC, { roughness: 0.55 });
    if (o.hair === 'spiky') {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const spike = add(new THREE.Mesh(geo('spike', () => new THREE.ConeGeometry(0.11, 0.32, 6)), hairMat), Math.cos(a) * 0.2, 1.7, Math.sin(a) * 0.2 + 0.04);
        spike.rotation.set(Math.sin(a) * 0.7, 0, -Math.cos(a) * 0.7);
      }
      add(new THREE.Mesh(geo('buzz', () => new THREE.SphereGeometry(0.435, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2.4)), hairMat), 0, 1.4, 0.02);
    } else if (o.hair === 'buzz') {
      add(new THREE.Mesh(geo('buzz', () => new THREE.SphereGeometry(0.435, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2.4)), hairMat), 0, 1.4, 0.02);
    } else if (o.hair === 'mohawk') {
      for (let i = 0; i < 5; i++) {
        const z = -0.28 + i * 0.15;
        add(new THREE.Mesh(geo('mohawk', () => new THREE.BoxGeometry(0.1, 0.26, 0.13)), hairMat), 0, 1.78 - Math.abs(z) * 0.35, z);
      }
    } else if (o.hair === 'cap') {
      add(new THREE.Mesh(geo('dome', () => new THREE.SphereGeometry(0.45, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2.2)), capMat), 0, 1.42, 0);
      add(new THREE.Mesh(geo('brim', () => new THREE.BoxGeometry(0.5, 0.04, 0.32)), capMat), 0, 1.55, -0.45);
    } else if (o.hair === 'helmet') {
      add(new THREE.Mesh(geo('helm', () => new THREE.SphereGeometry(0.49, 22, 14, 0, Math.PI * 2, 0, Math.PI / 1.95)), std(0x8a97a8, { roughness: 0.35, metalness: 0.3 })), 0, 1.38, 0);
      add(new THREE.Mesh(geo('visor', () => new THREE.BoxGeometry(0.6, 0.08, 0.1)), std(shirtC, { emissive: shirtC, emissiveIntensity: 0.4 })), 0, 1.66, -0.38);
    } else if (o.hair === 'beanie') {
      add(new THREE.Mesh(geo('beanieTop', () => new THREE.SphereGeometry(0.455, 22, 12, 0, Math.PI * 2, 0, Math.PI / 2.1)), capMat), 0, 1.42, 0);
      const rim = add(new THREE.Mesh(geo('rim', () => new THREE.TorusGeometry(0.44, 0.06, 8, 24)), std(0xffffff)), 0, 1.47, 0);
      rim.rotation.x = Math.PI / 2;
      add(new THREE.Mesh(geo('pom', () => new THREE.SphereGeometry(0.1, 10, 8)), std(0xffffff)), 0, 1.9, 0);
    }

    // Accessory
    if (o.acc === 'goggles') {
      const band = add(new THREE.Mesh(geo('gband', () => new THREE.TorusGeometry(0.43, 0.035, 8, 24)), ink), 0, 1.55, 0);
      band.rotation.x = Math.PI / 2;
      for (const sx of [-1, 1]) {
        const lens = add(new THREE.Mesh(geo('lens', () => new THREE.CylinderGeometry(0.1, 0.1, 0.06, 14)), std(0x22d3ff, { emissive: 0x22d3ff, emissiveIntensity: 0.5, roughness: 0.2 })), sx * 0.15, 1.56, -0.4);
        lens.rotation.x = Math.PI / 2;
      }
    } else if (o.acc === 'headphones') {
      const arc = new THREE.Mesh(geo('hp', () => new THREE.TorusGeometry(0.46, 0.04, 8, 20, Math.PI)), ink);
      arc.position.set(0, 1.4, 0); arc.rotation.y = Math.PI / 2; g.add(arc);
      for (const sx of [-1, 1]) {
        const cup = add(new THREE.Mesh(geo('cup', () => new THREE.CylinderGeometry(0.13, 0.13, 0.09, 14)), std(shirtC === 0x23262e ? 0xff7a1a : shirtC)), sx * 0.45, 1.38, 0);
        cup.rotation.z = Math.PI / 2;
      }
    } else if (o.acc === 'jetpack') {
      for (const sx of [-1, 1]) {
        add(new THREE.Mesh(geo('tank', () => new THREE.CylinderGeometry(0.12, 0.12, 0.55, 12)), std(0x8a97a8, { metalness: 0.4, roughness: 0.35 })), sx * 0.16, 0.85, 0.44);
        add(new THREE.Mesh(geo('nozzle', () => new THREE.ConeGeometry(0.09, 0.14, 10)), std(0xff7a1a, { emissive: 0xff7a1a, emissiveIntensity: 0.6 })), sx * 0.16, 0.52, 0.44);
      }
    } else if (o.acc === 'bandana') {
      const scarf = add(new THREE.Mesh(geo('scarf', () => new THREE.TorusGeometry(0.33, 0.07, 8, 20)), std(0xe63a2e)), 0, 1.07, 0);
      scarf.rotation.x = Math.PI / 2;
      add(new THREE.Mesh(geo('knot', () => new THREE.BoxGeometry(0.14, 0.14, 0.1)), std(0xe63a2e)), 0, 1.02, 0.34);
    }

    // Hands and feet
    const hands = [];
    for (const sx of [-1, 1]) hands.push(add(new THREE.Mesh(geo('hand', () => new THREE.SphereGeometry(0.1, 10, 8)), headMat), sx * 0.5, 0.82, -0.18));
    const feet = [];
    for (const sx of [-1, 1]) {
      const f = add(new THREE.Mesh(geo('shoe', () => new THREE.BoxGeometry(0.24, 0.16, 0.38)), std(0x0b1426)), sx * 0.2, 0.09, -0.04);
      const sole = new THREE.Mesh(geo('sole', () => new THREE.BoxGeometry(0.26, 0.05, 0.4)), std(0xffffff));
      sole.position.y = -0.08; f.add(sole);
      feet.push(f);
    }

    // Blaster
    const gun = buildGun(opts.weapon || 'laser');
    gun.position.set(0.42, 0.88, -0.32); g.add(gun);

    // Floating marker (enemy / teammate indicator)
    const marker = new THREE.Mesh(geo('marker', () => new THREE.OctahedronGeometry(0.15)), new THREE.MeshBasicMaterial({ color: 0xff3b1f }));
    marker.position.y = 2.2; marker.scale.y = 1.4; g.add(marker);

    const handles = { group: g, shirtMat, feet, hands, marker, outline, teamBand, gun, tip: gun.userData.tip, outfit: o };
    handles.setWeapon = (id) => {
      const old = handles.gun;
      const next = buildGun(id);
      next.position.copy(old.position); g.remove(old); g.add(next);
      handles.gun = next; handles.tip = next.userData.tip;
    };
    return handles;
  }

  BA.OUTFIT = OUTFIT;
  BA.DEFAULT_OUTFIT = DEFAULT_OUTFIT;
  BA.randomOutfit = randomOutfit;
  BA.cleanOutfit = cleanOutfit;
  BA.buildCharacter = buildCharacter;
})();
