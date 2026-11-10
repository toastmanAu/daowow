// The ball machine.
//
// A glass drum of numbered ticket balls, a chute, and a winners' rail. One
// ball leaves the drum for each prize place, in the order and at the times
// the draw script gives. The script already holds the real result; nothing
// here chooses, reorders or randomises a winner.
//
// The tumbling is make-believe physics, and its random-looking numbers come
// from a generator seeded with the draw's own seed, stepped at a fixed rate.
// So a replay moves exactly as the first showing did.

import * as THREE from "../../../vendor/three.module.min.js";

const DRUM = { x: 0, y: 1.25, z: 0, radius: 1.55 };
const BALL_RADIUS = 0.23;
const RAIL_Y = -2.1;
const STEP = 1 / 60;
const MAX_STEPS_PER_FRAME = 4;
const EXIT_MS = 1700;
const IDLE_AFTER_MS = 2600;
const VIEW = { centreY: 0.25, halfHeight: 2.85 };

const COLOURS = {
  paper: "#f7f4ea",
  ink: "#16244f",
  amber: "#fbbf4b",
  good: "#6fd6a4",
  glass: 0xbcd0ff,
  metal: 0xfbbf4b,
  base: 0x1b2f6b,
};

// A ball's skin: its number, twice, on opposite sides, so it reads while the
// ball tumbles. The viewer's own tickets carry a green band.
function ballTexture(label, mine) {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const g = canvas.getContext("2d");
  g.fillStyle = COLOURS.paper;
  g.fillRect(0, 0, 256, 128);
  if (mine) {
    g.fillStyle = COLOURS.good;
    g.fillRect(0, 22, 256, 12);
    g.fillRect(0, 94, 256, 12);
  }
  g.fillStyle = COLOURS.ink;
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.font = `700 ${label.length > 2 ? 40 : 52}px "Avenir Next", Avenir, "Segoe UI", sans-serif`;
  // u = 0.25 faces the camera when the ball is at rest; u = 0.75 is its back.
  g.fillText(label, 64, 66);
  g.fillText(label, 192, 66);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
const easeOutBounce = (t) => {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) { const u = t - 1.5 / d; return n * u * u + 0.75; }
  if (t < 2.5 / d) { const u = t - 2.25 / d; return n * u * u + 0.9375; }
  const u = t - 2.625 / d;
  return n * u * u + 0.984375;
};
const lerp = (a, b, t) => a + (b - a) * t;

export function createStage(canvas, script, { onReveal = () => {}, onDone = () => {} } = {}) {
  // Throws here when WebGL is unavailable; the caller shows the list instead.
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);

  // The rail is as wide as the picture allows: narrow on a phone held
  // upright, wide on a desktop. Fixed for the life of the stage.
  const box = canvas.parentElement || canvas;
  const shape = Math.max(box.clientWidth, 1) / Math.max(box.clientHeight, 1);
  const RAIL_WIDTH = Math.min(Math.max(2 * VIEW.halfHeight * shape - 1.2, 3.0), 5.2);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 60);
  const disposables = [];
  const keep = (thing) => { disposables.push(thing); return thing; };

  // Studio light: one warm key from above the camera's left, cool fill from
  // the sky, and a low amber glow from inside the machine.
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x0d1840, 1.15));
  const key = new THREE.DirectionalLight(0xfff1d6, 2.2);
  key.position.set(-3.5, 6, 5);
  scene.add(key);
  const glow = new THREE.PointLight(COLOURS.metal, 6, 6, 2);
  glow.position.set(0, DRUM.y - 1.1, 0.6);
  scene.add(glow);

  // --- the machine ---------------------------------------------------------
  const machine = new THREE.Group();
  scene.add(machine);
  const glassGeometry = keep(new THREE.SphereGeometry(DRUM.radius, 48, 32));
  const glassBack = keep(new THREE.MeshStandardMaterial({
    color: COLOURS.glass, transparent: true, opacity: 0.1, roughness: 0.1, metalness: 0.1,
    side: THREE.BackSide, depthWrite: false,
  }));
  const glassFront = keep(new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 0.06, roughness: 0.02, metalness: 0,
    clearcoat: 1, clearcoatRoughness: 0.05, side: THREE.FrontSide, depthWrite: false,
  }));
  for (const material of [glassBack, glassFront]) {
    const shell = new THREE.Mesh(glassGeometry, material);
    shell.position.set(DRUM.x, DRUM.y, DRUM.z);
    shell.renderOrder = material === glassFront ? 3 : 0;
    machine.add(shell);
  }
  const metal = keep(new THREE.MeshStandardMaterial({ color: COLOURS.metal, roughness: 0.3, metalness: 0.85 }));
  const base = keep(new THREE.MeshStandardMaterial({ color: COLOURS.base, roughness: 0.6, metalness: 0.2 }));
  const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(DRUM.radius + 0.015, 0.022, 12, 96)), metal);
  ring.position.set(DRUM.x, DRUM.y, DRUM.z);
  ring.rotation.x = Math.PI / 2;
  machine.add(ring);
  const collar = new THREE.Mesh(keep(new THREE.CylinderGeometry(0.34, 0.42, 0.16, 32)), metal);
  collar.position.set(0, DRUM.y - DRUM.radius - 0.04, 0);
  machine.add(collar);
  const chuteTop = DRUM.y - DRUM.radius - 0.12;
  const chuteBottom = RAIL_Y + 0.55;
  const chute = new THREE.Mesh(
    keep(new THREE.CylinderGeometry(0.27, 0.27, chuteTop - chuteBottom, 24, 1, true)),
    keep(new THREE.MeshStandardMaterial({
      color: COLOURS.glass, transparent: true, opacity: 0.16, roughness: 0.1, side: THREE.DoubleSide,
      depthWrite: false,
    })));
  chute.position.set(0, (chuteTop + chuteBottom) / 2, 0);
  machine.add(chute);
  // The rail: two bright runners over a dark bed.
  const bed = new THREE.Mesh(keep(new THREE.BoxGeometry(RAIL_WIDTH + 0.5, 0.1, 0.62)), base);
  bed.position.set(0, RAIL_Y - BALL_RADIUS - 0.07, 0);
  machine.add(bed);
  const runnerGeometry = keep(new THREE.CylinderGeometry(0.025, 0.025, RAIL_WIDTH + 0.5, 12));
  for (const z of [-0.14, 0.14]) {
    const runner = new THREE.Mesh(runnerGeometry, metal);
    runner.rotation.z = Math.PI / 2;
    runner.position.set(0, RAIL_Y - BALL_RADIUS + 0.01, z);
    machine.add(runner);
  }

  // --- the balls -----------------------------------------------------------
  const ballGeometry = keep(new THREE.SphereGeometry(BALL_RADIUS, 28, 20));
  const places = Math.max(script.reveals.length, 1);
  const slotGap = Math.min(BALL_RADIUS * 2 + 0.06, RAIL_WIDTH / places);
  const railScale = Math.min(1, slotGap / (BALL_RADIUS * 2 + 0.06));
  const slotX = (i) => (i - (places - 1) / 2) * slotGap;
  const railY = RAIL_Y - BALL_RADIUS * (1 - railScale);

  const balls = script.balls.map((info) => {
    const material = keep(new THREE.MeshStandardMaterial({
      map: keep(ballTexture(info.label, info.mine)), roughness: 0.32, metalness: 0.05,
    }));
    const mesh = new THREE.Mesh(ballGeometry, material);
    mesh.renderOrder = 1;
    scene.add(mesh);
    return {
      info, mesh, material,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(),
      state: "drum", exit: null,
    };
  });
  const ballOf = new Map(balls.map((b) => [String(b.info.id), b]));

  let random = null;
  let simMs = 0;
  let nextReveal = 0;
  let fired = 0;
  let doneAt = null;
  let doneCalled = false;

  function reset() {
    random = window.DaowowDrawScript.seededRandom(script.seed);
    simMs = 0;
    nextReveal = 0;
    fired = 0;
    doneAt = null;
    doneCalled = false;
    balls.forEach((ball, i) => {
      // A loose pile in the lower half of the drum.
      const angle = random() * Math.PI * 2;
      const reach = Math.sqrt(random()) * (DRUM.radius - BALL_RADIUS * 2);
      ball.pos.set(
        DRUM.x + Math.cos(angle) * reach * 0.8,
        DRUM.y - DRUM.radius * 0.55 + (i % 5) * 0.12,
        DRUM.z + Math.sin(angle) * reach * 0.8);
      ball.vel.set((random() - 0.5) * 2, random() * 2, (random() - 0.5) * 2);
      ball.state = "drum";
      ball.exit = null;
      ball.mesh.scale.setScalar(1);
      ball.mesh.rotation.set(random() * 6, random() * 6, random() * 6);
      ball.material.color.set(0xffffff);
      ball.material.emissive.set(0x000000);
    });
  }

  function land(ball, reveal, slot) {
    ball.state = "rail";
    ball.pos.set(slotX(slot), railY, 0);
    ball.mesh.scale.setScalar(railScale);
    ball.mesh.rotation.set(0, 0, 0); // number to the camera
    ball.material.color.set(COLOURS.amber);
    ball.material.emissive.set(0x3a2500);
    fired += 1;
    onReveal(reveal);
    if (fired === script.reveals.length) doneAt = simMs;
  }

  function startExit(ball, reveal, slot) {
    ball.state = "exit";
    ball.exit = { from: ball.pos.clone(), startMs: simMs, reveal, slot };
  }

  // Up out of the pile to the port, down the chute, then along the rail.
  function moveExit(ball) {
    const { from, startMs, reveal, slot } = ball.exit;
    const t = Math.min((simMs - startMs) / EXIT_MS, 1);
    const port = DRUM.y - DRUM.radius + BALL_RADIUS;
    if (t < 0.3) {
      const k = easeInOut(t / 0.3);
      ball.pos.set(lerp(from.x, 0, k), lerp(from.y, port, k), lerp(from.z, 0, k));
    } else if (t < 0.6) {
      const k = (t - 0.3) / 0.3;
      ball.pos.set(0, lerp(port, railY, easeOutBounce(k)), 0);
    } else {
      const k = easeInOut((t - 0.6) / 0.4);
      ball.pos.set(lerp(0, slotX(slot), k), railY, 0);
      ball.mesh.scale.setScalar(lerp(1, railScale, k));
      ball.mesh.rotation.z -= 0.25 * Math.sign(slotX(slot) || 1);
    }
    if (t >= 1) land(ball, reveal, slot);
  }

  const centre = new THREE.Vector3(DRUM.x, DRUM.y, DRUM.z);
  const offset = new THREE.Vector3();
  const limit = DRUM.radius - BALL_RADIUS;

  function step() {
    simMs += STEP * 1000;
    while (nextReveal < script.reveals.length && simMs >= script.reveals[nextReveal].atMs) {
      const reveal = script.reveals[nextReveal];
      const ball = ballOf.get(String(reveal.ticket));
      if (ball && ball.state === "drum") startExit(ball, reveal, nextReveal);
      nextReveal += 1;
    }
    const inDrum = [];
    for (const ball of balls) {
      if (ball.state === "exit") { moveExit(ball); continue; }
      if (ball.state === "drum") inDrum.push(ball);
    }
    for (const ball of inDrum) {
      // Gravity, an air jet from below, and a slow swirl that keeps the pile
      // turning over.
      ball.vel.y -= 9 * STEP;
      offset.subVectors(ball.pos, centre);
      // The jet stops once the last winner is out, and the pile settles.
      // Kicks, not a steady push: a steady jet holds the balls in a flat
      // layer, and a lottery drum is a boil.
      if (doneAt === null && offset.y < -DRUM.radius * 0.35 && random() < 0.12) {
        ball.vel.y += 3.5 + random() * 4.5;
        ball.vel.x += (random() - 0.5) * 5;
        ball.vel.z += (random() - 0.5) * 5;
      }
      if (doneAt === null) {
        ball.vel.x += -offset.y * 0.5 * STEP;
        ball.vel.y += offset.x * 0.5 * STEP;
      }
      ball.vel.multiplyScalar(0.995);
      ball.pos.addScaledVector(ball.vel, STEP);
      // The glass.
      offset.subVectors(ball.pos, centre);
      const distance = offset.length();
      if (distance > limit) {
        offset.multiplyScalar(1 / distance);
        ball.pos.copy(centre).addScaledVector(offset, limit);
        const outward = ball.vel.dot(offset);
        if (outward > 0) ball.vel.addScaledVector(offset, -1.75 * outward);
      }
      ball.mesh.rotation.x += ball.vel.y * STEP * 3;
      ball.mesh.rotation.z -= ball.vel.x * STEP * 3;
    }
    // Ball against ball.
    const reach = BALL_RADIUS * 2;
    for (let i = 0; i < inDrum.length; i++) {
      for (let j = i + 1; j < inDrum.length; j++) {
        const a = inDrum[i], b = inDrum[j];
        offset.subVectors(b.pos, a.pos);
        const gap = offset.lengthSq();
        if (gap >= reach * reach || gap === 0) continue;
        const distance = Math.sqrt(gap);
        offset.multiplyScalar(1 / distance);
        const push = (reach - distance) / 2;
        a.pos.addScaledVector(offset, -push);
        b.pos.addScaledVector(offset, push);
        const closing = b.vel.dot(offset) - a.vel.dot(offset);
        if (closing < 0) {
          a.vel.addScaledVector(offset, closing * 0.9);
          b.vel.addScaledVector(offset, -closing * 0.9);
        }
      }
    }
  }

  function draw() {
    for (const ball of balls) ball.mesh.position.copy(ball.pos);
    renderer.render(scene, camera);
  }

  // --- sizing --------------------------------------------------------------
  function resize() {
    const width = Math.max(box.clientWidth, 1);
    const height = Math.max(box.clientHeight, 1);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    // Far enough back that the whole machine fits, whichever way the box runs.
    const halfWidth = Math.max(RAIL_WIDTH / 2 + 0.3, DRUM.radius + 0.2);
    const tan = Math.tan((camera.fov * Math.PI) / 360);
    camera.position.set(0, VIEW.centreY,
      Math.max(VIEW.halfHeight / tan, halfWidth / (tan * camera.aspect)));
    camera.lookAt(0, VIEW.centreY, 0);
    camera.updateProjectionMatrix();
    draw();
  }
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
  if (observer) observer.observe(canvas.parentElement || canvas);

  // --- the loop ------------------------------------------------------------
  let frame = null;
  let last = null;
  let owed = 0;
  let disposed = false;

  function tick(now) {
    frame = null;
    if (disposed) return;
    if (document.hidden) { last = null; schedule(); return; }
    if (last === null) last = now;
    owed += Math.min((now - last) / 1000, STEP * MAX_STEPS_PER_FRAME);
    last = now;
    while (owed >= STEP) { step(); owed -= STEP; }
    draw();
    if (doneAt !== null && !doneCalled) { doneCalled = true; onDone(); }
    // Once the last ball has settled the machine stops, so an open tab does
    // not keep a phone's graphics chip busy.
    if (doneAt !== null && simMs - doneAt > IDLE_AFTER_MS) return;
    schedule();
  }
  function schedule() {
    if (frame === null && !disposed) frame = window.requestAnimationFrame(tick);
  }

  function play() {
    last = null;
    schedule();
  }

  /** Straight to the result: every remaining winner lands at once, in order. */
  function skip() {
    script.reveals.forEach((reveal, slot) => {
      const ball = ballOf.get(String(reveal.ticket));
      if (ball && ball.state !== "rail") land(ball, reveal, slot);
    });
    nextReveal = script.reveals.length;
    draw();
    if (!doneCalled) { doneCalled = true; onDone(); }
    schedule();
  }

  function replay() {
    reset();
    owed = 0;
    last = null;
    draw();
    schedule();
  }

  function dispose() {
    disposed = true;
    if (frame !== null) window.cancelAnimationFrame(frame);
    frame = null;
    if (observer) observer.disconnect();
    for (const thing of disposables) thing.dispose();
    renderer.dispose();
    // Hand the graphics context back now rather than at garbage collection:
    // browsers allow only a handful per page.
    renderer.forceContextLoss();
  }

  reset();
  resize();
  return { play, skip, replay, dispose };
}
