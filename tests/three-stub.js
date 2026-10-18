// Minimal stand-in for Three.js used only by tests/smoke.js (headless logic test, no rendering).
(function () {
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
    setScalar(s) { return this.set(s, s, s); }
    copy(v) { return this.set(v.x, v.y, v.z); }
    clone() { return new Vector3(this.x, this.y, this.z); }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; this.z += v.z * s; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    subVectors(a, b) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    divideScalar(s) { return this.multiplyScalar(1 / s); }
    length() { return Math.hypot(this.x, this.y, this.z); }
    normalize() { return this.divideScalar(this.length() || 1); }
    distanceTo(v) { return Math.hypot(this.x - v.x, this.y - v.y, this.z - v.z); }
    applyQuaternion() { return this; }
    project() { this.z = 0.5; return this; }
  }
  class Euler { constructor() { this.x = 0; this.y = 0; this.z = 0; this.order = 'XYZ'; } set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } }
  class Quaternion { setFromUnitVectors() { return this; } }
  class Object3D {
    constructor() { this.position = new Vector3(); this.rotation = new Euler(); this.scale = new Vector3(1, 1, 1); this.quaternion = new Quaternion(); this.children = []; this.visible = true; this.userData = {}; }
    add(c) { this.children.push(c); c.parent = this; return this; }
    remove(c) { this.children = this.children.filter((x) => x !== c); return this; }
    getWorldPosition(out) { let p = this, o = new Vector3(); while (p) { o.add(p.position); p = p.parent; } return out.copy(o); }
    getWorldDirection(out) { const y = this.rotation.y, x = this.rotation.x; return out.set(-Math.sin(y) * Math.cos(x), Math.sin(x), -Math.cos(y) * Math.cos(x)); }
    lookAt() {}
    updateProjectionMatrix() {}
    traverse(cb) { cb(this); for (const c of this.children) c.traverse(cb); }
  }
  class Mesh extends Object3D { constructor(g, m) { super(); this.geometry = g; this.material = m; } }
  class Light extends Object3D { constructor(c, g, i) { super(); this.color = new Color(c); this.groundColor = new Color(g); this.intensity = i; this.shadow = { mapSize: { set() {} }, camera: {}, bias: 0 }; } }
  class Geometry { translate() { return this; } dispose() {} }
  class Color { constructor(v) { this.v = v; } setHex(v) { this.v = v; return this; } }
  class Material { constructor(o) { Object.assign(this, o); this.color = new Color(o && o.color); } }
  const THREE = {
    Vector3, Quaternion, Object3D, Mesh, Group: Object3D, Scene: Object3D, LineSegments: Mesh,
    PerspectiveCamera: class extends Object3D { constructor(fov, aspect) { super(); this.fov = fov; this.aspect = aspect; } setViewOffset() {} clearViewOffset() {} },
    HemisphereLight: Light, DirectionalLight: Light, Color, Fog: class { constructor(c, n, f) { this.color = new Color(c); this.near = n; this.far = f; } },
    CanvasTexture: class { constructor() { this.repeat = { set() {} }; this.offset = { x: 0, y: 0 }; } },
    WebGLRenderer: class { constructor() { this.shadowMap = {}; } setPixelRatio() {} setSize() {} render() {} clear() {} clearDepth() {} },
    sRGBEncoding: 3001, RepeatWrapping: 1000, PCFSoftShadowMap: 2, BackSide: 1
  };
  for (const g of ['BoxGeometry', 'CylinderGeometry', 'SphereGeometry', 'EdgesGeometry', 'TorusGeometry', 'OctahedronGeometry', 'CircleGeometry', 'PlaneGeometry', 'ConeGeometry']) THREE[g] = Geometry;
  for (const m of ['MeshStandardMaterial', 'MeshBasicMaterial', 'LineBasicMaterial']) THREE[m] = Material;
  window.THREE = THREE;
})();
