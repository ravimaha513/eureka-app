/**
 * WebGL product shot for the sign-in hero (three.js, loaded lazily by HeroScene).
 * A procedurally modelled aluminium laptop under studio lighting: it starts closed
 * showing the Eureka mark, the camera sweeps round as the lid opens, the screen
 * boots to the logo and then to a live pipeline board where candidates move
 * between stages. Idles with a slow float and pointer parallax.
 */
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

type Opts = { reduced: boolean; onReady?: () => void };

const W = 3.0, D = 2.1, BASE_H = 0.075, LID_T = 0.042, LID_D = D - 0.02, OPEN = -1.9;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const ease = (x: number) => { x = clamp01(x); return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2; };
const span = (t: number, a: number, b: number) => ease((t - a) / (b - a));

function slab(w: number, d: number, h: number, r: number): THREE.BufferGeometry {
  const b = Math.min(0.012, h / 3);
  const x = -w / 2 + b, y = -d / 2 + b, iw = w - 2 * b, id = d - 2 * b, rr = r - b;
  const s = new THREE.Shape();
  s.moveTo(x + rr, y); s.lineTo(x + iw - rr, y); s.quadraticCurveTo(x + iw, y, x + iw, y + rr);
  s.lineTo(x + iw, y + id - rr); s.quadraticCurveTo(x + iw, y + id, x + iw - rr, y + id);
  s.lineTo(x + rr, y + id); s.quadraticCurveTo(x, y + id, x, y + id - rr);
  s.lineTo(x, y + rr); s.quadraticCurveTo(x, y, x + rr, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: h - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 5, curveSegments: 14 });
  g.rotateX(-Math.PI / 2); g.translate(0, b, 0);
  return g;
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  c.beginPath(); c.roundRect(x, y, w, h, r);
}

function drawMark(c: CanvasRenderingContext2D, cx: number, cy: number, size: number, tile = "#e0443e") {
  c.fillStyle = tile; roundRect(c, cx - size / 2, cy - size / 2, size, size, size * 0.22); c.fill();
  c.fillStyle = "#fff";
  const u = size / 14, x0 = cx - size / 2;
  for (const [y, w] of [[2.6, 8.4], [5.8, 6.3], [9.0, 8.4]] as const) { roundRect(c, x0 + 2.8 * u, cy - size / 2 + y * u, w * u, 2.2 * u, 0.5 * u); c.fill(); }
}

/* ---------- screen content ---------- */
type Card = { name: string; role: string; tag: string; hue: number };
const POOL: Card[] = [
  ["Priya Natarajan", "Java Developer", "Spring"], ["Marcus Bell", "Data Engineer", "Spark"], ["Elena Sokolova", "QA Lead", "Cypress"],
  ["Daniel Okafor", "DevOps Engineer", "AWS"], ["Aisha Rahman", "React Developer", "React"], ["Tom Becker", "Business Analyst", "SQL"],
  ["Sofia Marino", "Scrum Master", "Agile"], ["Kenji Watanabe", "Salesforce Dev", "Apex"], ["Grace Liu", ".NET Developer", "C#"],
  ["Omar Haddad", "Cloud Architect", "Azure"], ["Hannah Weiss", "Python Developer", "Django"], ["Ravi Kumar", "SRE", "K8s"],
  ["Lucia Gomez", "UX Designer", "Figma"], ["Ben Carter", "Android Dev", "Kotlin"],
].map(([name = "", role = "", tag = ""], i) => ({ name, role, tag, hue: (i * 47) % 360 }));
const COLS = ["Sourced", "Screening", "Submitted", "Interview", "Placed"];
const NAV = ["Hot List", "Pipeline", "Submissions", "Interviews", "Paperwork", "Employees", "Payments"];

class Board {
  cols: Card[][] = [[], [], [], [], []];
  next = 0;
  take(): Card { return POOL[this.next++ % POOL.length] as Card; }
  constructor() { const per = [3, 3, 3, 2, 2]; per.forEach((n, c) => { for (let i = 0; i < n; i++) this.cols[c]?.push(this.take()); }); }
  /** column whose top card moves on step k (3 → 2 → 1 → 0 → 3 …) */
  src(k: number) { return 3 - (k % 4); }
  commit(k: number) {
    const s = this.src(k), from = this.cols[s], to = this.cols[s + 1], card = from?.shift(); if (!from || !to || !card) return;
    to.unshift(card); if (to.length > 4 && s + 1 === 4) to.pop();
    if ((this.cols[0]?.length ?? 0) < 2) this.cols[0]?.push(this.take());
    if (from.length === 0) from.push(this.take());
  }
}

const SW = 1600, SH = 1000;
function drawCard(c: CanvasRenderingContext2D, card: Card, x: number, y: number, w: number, lifted: number, placed: boolean) {
  c.save();
  c.shadowColor = `rgba(0,0,0,${0.25 + lifted * 0.35})`; c.shadowBlur = 10 + lifted * 30; c.shadowOffsetY = 3 + lifted * 12;
  c.fillStyle = "#1d2138"; roundRect(c, x, y, w, 108, 14); c.fill(); c.restore();
  c.fillStyle = `hsl(${card.hue} 40% 27%)`; c.beginPath(); c.arc(x + 36, y + 38, 20, 0, Math.PI * 2); c.fill();
  c.fillStyle = `hsl(${card.hue} 75% 80%)`; c.font = "600 17px 'Archivo Variable', system-ui, sans-serif"; c.textAlign = "center";
  c.fillText(card.name.split(" ").map((p) => p[0]).join(""), x + 36, y + 44); c.textAlign = "left";
  c.fillStyle = "#e9eaf2"; c.font = "600 19px 'Archivo Variable', system-ui, sans-serif"; c.fillText(card.name, x + 66, y + 34, w - 78);
  c.fillStyle = "#969cb2"; c.font = "16px 'Archivo Variable', system-ui, sans-serif"; c.fillText(card.role, x + 66, y + 56, w - 78);
  const tag = placed ? "Placed" : card.tag;
  c.font = "600 14px 'Archivo Variable', system-ui, sans-serif";
  const tw = c.measureText(tag).width + 20;
  c.fillStyle = placed ? "rgba(34,197,94,.2)" : "#2a2f4b"; roundRect(c, x + 16, y + 72, tw, 24, 12); c.fill();
  c.fillStyle = placed ? "#5fdc8c" : "#b4bbf0"; c.fillText(tag, x + 26, y + 89);
}

function drawBoard(c: CanvasRenderingContext2D, b: Board, step: number, m: number) {
  c.fillStyle = "#0e1020"; c.fillRect(0, 0, SW, SH);
  // sidebar
  c.fillStyle = "#12152b"; c.fillRect(0, 0, 290, SH);
  drawMark(c, 56, 56, 48);
  c.fillStyle = "#fff"; c.font = "700 28px 'Archivo Variable', system-ui, sans-serif"; c.fillText("Eureka", 92, 66);
  NAV.forEach((n, i) => {
    const y = 140 + i * 58, on = n === "Pipeline";
    if (on) { c.fillStyle = "#2b3060"; roundRect(c, 16, y - 8, 258, 48, 10); c.fill(); }
    c.fillStyle = on ? "#ff6a61" : "#5b5f86"; roundRect(c, 34, y + 6, 20, 20, 5); c.fill();
    c.fillStyle = on ? "#fff" : "#c9cbdc"; c.font = `${on ? 600 : 500} 21px 'Archivo Variable', system-ui, sans-serif`; c.fillText(n, 70, y + 24);
  });
  // top bar
  c.fillStyle = "#15182a"; c.fillRect(290, 0, SW - 290, 84); c.fillStyle = "#262a42"; c.fillRect(290, 84, SW - 290, 2);
  c.fillStyle = "#1f2339"; roundRect(c, 322, 20, 520, 44, 22); c.fill();
  c.fillStyle = "#6b7192"; c.font = "19px 'Archivo Variable', system-ui, sans-serif"; c.fillText("Search candidates, jobs, people…", 352, 49);
  c.fillStyle = "#3b4166"; c.beginPath(); c.arc(SW - 52, 42, 22, 0, Math.PI * 2); c.fill();
  c.fillStyle = "#e9eaf2"; c.font = "700 40px 'Archivo Variable', system-ui, sans-serif"; c.fillText("Pipeline", 322, 146);
  c.fillStyle = "#969cb2"; c.font = "19px 'Archivo Variable', system-ui, sans-serif"; c.fillText("All open jobs · this week", 322, 178);
  // columns
  const x0 = 322, cw = 240, gap = 16, top = 210, pitch = 124, s = b.src(step), mm = ease(m);
  COLS.forEach((name, ci) => {
    const x = x0 + ci * (cw + gap);
    c.fillStyle = "#15182a"; roundRect(c, x, top, cw, SH - top - 26, 16); c.fill();
    c.fillStyle = "#c6c9d8"; c.font = "600 19px 'Archivo Variable', system-ui, sans-serif"; c.fillText(name, x + 18, top + 36);
    c.fillStyle = ci === 4 ? "#5fdc8c" : "#969cb2"; c.font = "600 16px 'Archivo Variable', system-ui, sans-serif";
    const col = b.cols[ci] ?? [];
    c.fillText(String(col.length + (ci === s + 1 ? Math.round(mm) : 0) - (ci === s ? Math.round(mm) : 0)), x + cw - 34, top + 36);
    c.save(); c.beginPath(); c.rect(x, top + 50, cw, SH - top - 80); c.clip();
    col.forEach((card, i) => {
      if (m > 0 && ci === s && i === 0) return; // drawn as the moving card
      let yy = i;
      if (m > 0 && ci === s) yy = i - mm;
      if (m > 0 && ci === s + 1) yy = i + mm;
      drawCard(c, card, x + 12, top + 58 + yy * pitch, cw - 24, 0, ci === 4 && i === 0 && m === 0 && step > 0);
    });
    c.restore();
  });
  if (m > 0) {
    const card = b.cols[s]?.[0];
    if (card) {
      const xa = x0 + s * (cw + gap) + 12, xb = xa + cw + gap, y = top + 58 - Math.sin(mm * Math.PI) * 26;
      drawCard(c, card, xa + (xb - xa) * mm, y, cw - 24, Math.sin(mm * Math.PI), s + 1 === 4 && mm > 0.85);
    }
  }
}

function drawBoot(c: CanvasRenderingContext2D, a: number) {
  c.fillStyle = "#05060c"; c.fillRect(0, 0, SW, SH);
  if (a <= 0) return;
  c.save(); c.globalAlpha = a;
  const g = c.createRadialGradient(SW / 2, SH / 2 - 30, 0, SW / 2, SH / 2 - 30, 380);
  g.addColorStop(0, "rgba(255,106,97,.22)"); g.addColorStop(1, "rgba(255,106,97,0)"); c.fillStyle = g; c.fillRect(0, 0, SW, SH);
  drawMark(c, SW / 2, SH / 2 - 50, 150);
  c.fillStyle = "#fff"; c.font = "700 64px 'Archivo Variable', system-ui, sans-serif"; c.textAlign = "center";
  c.fillText("Eureka", SW / 2, SH / 2 + 110); c.textAlign = "left"; c.restore();
}

/* ---------- scene ---------- */
export function mountHero(host: HTMLElement, { reduced, onReady }: Opts): () => void {
  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" }); } catch { return () => {}; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const env = pmrem.fromScene(room, 0.035).texture; scene.environment = env;
  scene.environmentIntensity = 1.0;
  const key = new THREE.DirectionalLight(0xffffff, 1.6); key.position.set(-4, 6, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x7f9bff, 2.2); rim.position.set(3, 2.5, -6); scene.add(rim);

  const camera = new THREE.PerspectiveCamera(28, 1, 0.1, 100);
  const model = new THREE.Group(); scene.add(model);

  const alu = new THREE.MeshPhysicalMaterial({ color: 0xdfe2e8, metalness: 1, roughness: 0.22, clearcoat: 0.25, clearcoatRoughness: 0.35 });
  const aluDark = new THREE.MeshPhysicalMaterial({ color: 0xd2d6de, metalness: 0.9, roughness: 0.42 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0b0c12, roughness: 0.55, metalness: 0.1 });
  const keyMat = new THREE.MeshStandardMaterial({ color: 0x111218, roughness: 0.62, metalness: 0.05 });

  // base
  model.add(new THREE.Mesh(slab(W, D, BASE_H, 0.15), alu));
  const basePlate = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.3, D - 0.3), alu);
  basePlate.rotation.x = -Math.PI / 2; basePlate.position.y = BASE_H - 0.004; model.add(basePlate);
  const well = new THREE.Mesh(new THREE.PlaneGeometry(2.62, 1.06), black);
  well.rotation.x = -Math.PI / 2; well.position.set(0, BASE_H + 0.0006, -D / 2 + 0.2 + 0.53); model.add(well);
  // keys
  const keyGeo = new RoundedBoxGeometry(1, 0.016, 1, 2, 0.006);
  const keys: [number, number, number, number][] = []; // x, z, w, d
  const pitch = 0.183, k = 0.158, kx0 = -1.3 + pitch / 2, kz0 = -D / 2 + 0.25;
  for (let i = 0; i < 14; i++) keys.push([kx0 + i * pitch, kz0, k, 0.08]);
  for (let r = 1; r < 5; r++) for (let i = 0; i < 14; i++) keys.push([kx0 + i * pitch, kz0 + 0.06 + r * pitch - 0.05, k, k]);
  const zr = kz0 + 0.06 + 5 * pitch - 0.05;
  for (let i = 0; i < 4; i++) keys.push([kx0 + i * pitch, zr, k, k]);
  keys.push([kx0 + 4 * pitch + 2.5 * pitch, zr, 6 * pitch - (pitch - k), k]);
  for (let i = 10; i < 14; i++) keys.push([kx0 + i * pitch, zr, k, i >= 11 && i <= 13 && i !== 12 ? k / 2 : k]);
  const keyMesh = new THREE.InstancedMesh(keyGeo, keyMat, keys.length);
  const mtx = new THREE.Matrix4();
  keys.forEach(([x, z, w, d], i) => { mtx.compose(new THREE.Vector3(x, BASE_H + 0.009, z), new THREE.Quaternion(), new THREE.Vector3(w, 1, d)); keyMesh.setMatrixAt(i, mtx); });
  model.add(keyMesh);
  const pad = new THREE.Mesh(slab(1.34, 0.84, 0.003, 0.07), aluDark); pad.position.set(0, BASE_H - 0.001, D / 2 - 0.12 - 0.42); model.add(pad);
  const hinge = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, W - 0.6, 24), black);
  hinge.rotation.z = Math.PI / 2; hinge.position.set(0, BASE_H + 0.02, -D / 2 + 0.02); model.add(hinge);

  // contact shadow
  const sc = document.createElement("canvas"); sc.width = sc.height = 256;
  const sx = sc.getContext("2d")!; const sg = sx.createRadialGradient(128, 128, 0, 128, 128, 128);
  sg.addColorStop(0, "rgba(0,0,0,.75)"); sg.addColorStop(0.55, "rgba(0,0,0,.35)"); sg.addColorStop(1, "rgba(0,0,0,0)");
  sx.fillStyle = sg; sx.fillRect(0, 0, 256, 256);
  const shadowTex = new THREE.CanvasTexture(sc);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(W * 1.55, D * 1.7), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, toneMapped: false }));
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = -0.002; scene.add(shadow);

  // lid
  const lid = new THREE.Group(); lid.position.set(0, BASE_H + 0.022, -D / 2 + 0.01); model.add(lid);
  const shellGeo = slab(W, LID_D, LID_T, 0.15); shellGeo.translate(0, 0, LID_D / 2);
  lid.add(new THREE.Mesh(shellGeo, alu));
  // backing plates hide sub-pixel cracks in the extruded caps' triangulation
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.3, LID_D - 0.3), alu);
  plate.rotation.x = -Math.PI / 2; plate.position.set(0, LID_T - 0.004, LID_D / 2); lid.add(plate);
  const bezel = new THREE.Mesh(slab(W - 0.05, LID_D - 0.05, 0.002, 0.13), black);
  bezel.rotation.x = Math.PI; bezel.position.set(0, -0.0002, LID_D / 2); lid.add(bezel);
  const scr = document.createElement("canvas"); scr.width = SW; scr.height = SH;
  const sctx = scr.getContext("2d")!;
  const screenTex = new THREE.CanvasTexture(scr); screenTex.colorSpace = THREE.SRGBColorSpace; screenTex.anisotropy = 8;
  const screenMat = new THREE.MeshBasicMaterial({ map: screenTex, toneMapped: false });
  const sw = W - 0.2, sh = sw * (SH / SW);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh), screenMat);
  screen.rotation.x = Math.PI / 2; screen.position.set(0, -0.0035, LID_D / 2 + 0.04); lid.add(screen);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(W - 0.08, LID_D - 0.08),
    new THREE.MeshPhysicalMaterial({ color: 0x000000, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.05, envMapIntensity: 1.2 }));
  glass.rotation.x = Math.PI / 2; glass.position.set(0, -0.005, LID_D / 2); lid.add(glass);
  // logo on the lid back
  const lc = document.createElement("canvas"); lc.width = lc.height = 512; const lx = lc.getContext("2d")!;
  drawMark(lx, 256, 256, 420, "#d23a35");
  const logoTex = new THREE.CanvasTexture(lc); logoTex.colorSpace = THREE.SRGBColorSpace;
  const logoMat = new THREE.MeshPhysicalMaterial({ map: logoTex, transparent: true, metalness: 0.4, roughness: 0.2, clearcoat: 1, emissive: 0xff4a40, emissiveMap: logoTex, emissiveIntensity: 0 });
  const logo = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.42), logoMat);
  logo.rotation.x = -Math.PI / 2; logo.position.set(0, LID_T + 0.0008, LID_D / 2); lid.add(logo);
  const spill = new THREE.PointLight(0x9db4ff, 0, 2.4, 2); spill.position.set(0, -0.9, LID_D / 2); lid.add(spill);

  // camera path
  const look = new THREE.Vector3(0.25, 0.66, 0.05);
  const camA = new THREE.Vector3(0, 6.6, 4.6), camB = new THREE.Vector3(4.4, 2.5, 6.0);
  const lookA = new THREE.Vector3(0, 0.1, 0.1);
  let fit = 1;
  const resize = () => {
    const w = host.clientWidth, h = host.clientHeight; if (!w || !h) return;
    renderer.setSize(w, h, false); camera.aspect = w / h; fit = Math.max(1, 1.35 / camera.aspect); camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize); ro.observe(host); resize();

  const board = new Board();
  let step = 0, stepStart = 0, boardDirty = true, lastScreen = "";
  const ptr = { x: 0, y: 0, sx: 0, sy: 0 };
  const onPtr = (e: PointerEvent) => {
    const r = host.getBoundingClientRect();
    ptr.x = clamp01((e.clientX - r.left) / r.width) * 2 - 1; ptr.y = clamp01((e.clientY - r.top) / r.height) * 2 - 1;
  };
  if (!reduced) window.addEventListener("pointermove", onPtr, { passive: true });

  const INTRO = 4.2, CYCLE = 3.4, MOVE = 0.9;
  let t0 = -1;
  let raf = 0, visible = true, ready = false;
  const io = new IntersectionObserver((es) => { visible = es[0]?.isIntersecting ?? true; }); io.observe(host);

  const frame = (now: number) => {
    raf = requestAnimationFrame(frame);
    if (!visible || document.hidden) return;
    if (t0 < 0) t0 = now - (reduced ? INTRO * 1000 + 1 : 0);
    const dbg = import.meta.env.DEV ? (window as { __heroT?: number }).__heroT : undefined; // preview capture hook
    const t = dbg ?? (now - t0) / 1000;
    const open = span(t, 0.7, 2.6), cam = span(t, 0.35, 3.0);
    lid.rotation.x = OPEN * open;
    logoMat.emissiveIntensity = 0.15 * Math.max(0, 1 - open * 2) * (0.6 + 0.4 * Math.sin(t * 3));
    const boot = span(t, 1.7, 2.3) * (1 - span(t, 3.1, 3.6)), ui = span(t, 3.1, 3.6);
    const light = Math.max(boot, ui);
    spill.intensity = 0.35 * light;

    // screen
    let m = 0;
    if (ui >= 1 && !reduced) {
      const ct = t - INTRO - stepStart;
      if (ct > CYCLE) { board.commit(step); step++; stepStart += CYCLE; boardDirty = true; }
      const mt = (t - INTRO - stepStart) - (CYCLE - MOVE);
      m = mt > 0 ? clamp01(mt / MOVE) : 0;
    }
    const sig = ui < 1 ? `i${boot.toFixed(3)}:${ui.toFixed(3)}` : `b${step}:${m.toFixed(3)}`;
    if (sig !== lastScreen || boardDirty) {
      lastScreen = sig; boardDirty = false;
      if (ui < 1) { drawBoot(sctx, boot); if (ui > 0) { sctx.save(); sctx.globalAlpha = ui; drawBoard(sctx, board, step, 0); sctx.restore(); } }
      else drawBoard(sctx, board, step, m);
      screenTex.needsUpdate = true;
    }

    // model + camera
    ptr.sx += (ptr.x - ptr.sx) * 0.05; ptr.sy += (ptr.y - ptr.sy) * 0.05;
    const settle = span(t, 2.6, 4.2);
    model.rotation.y = -0.18 * cam + ptr.sx * 0.22 * settle;
    model.rotation.x = ptr.sy * 0.06 * settle;
    model.position.y = reduced ? 0 : Math.sin(t * 0.9) * 0.035 * settle;
    shadow.scale.setScalar(1 - model.position.y * 1.5);
    (shadow.material as THREE.MeshBasicMaterial).opacity = 0.9 - model.position.y * 4;
    camera.position.lerpVectors(camA, camB, cam).multiplyScalar(fit);
    camera.lookAt(new THREE.Vector3().lerpVectors(lookA, look, cam));
    renderer.render(scene, camera);
    if (!ready) { ready = true; onReady?.(); }
  };
  const start = () => { raf = requestAnimationFrame(frame); };
  // wait for the UI font so the screen text renders in Archivo
  (document.fonts?.ready ?? Promise.resolve()).then(start, start);

  return () => {
    cancelAnimationFrame(raf); ro.disconnect(); io.disconnect(); window.removeEventListener("pointermove", onPtr);
    scene.traverse((o) => { const mesh = o as THREE.Mesh; if (mesh.isMesh) { mesh.geometry.dispose(); const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]; mats.forEach((mm) => mm.dispose()); } });
    [screenTex, logoTex, shadowTex, env].forEach((x) => x.dispose());
    keyGeo.dispose(); pmrem.dispose(); renderer.dispose(); renderer.domElement.remove();
  };
}
