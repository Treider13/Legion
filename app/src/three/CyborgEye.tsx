// ============================================================================
// LEGION — CyborgEye (hero): механический глаз-объектив, порт standalone-версии
// (cyber-eye.html) в R3F. Тёмный металл со светящимися дорожками-схемами,
// 7-лепестковая диафрагма-зрачок, HUD-радужка (кольца/деления/дуги),
// гиро-кольца, частицы, глитчи, скан-кольцо.
// Покой: медленное вращение, дрейф взгляда, автофокус, моргание диафрагмой.
// Бой (rfVisual.corridorActive): резкие саккады, прищур диафрагмы, форсаж
// свечения и глитчей — до «СТОП».
// ============================================================================
import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { rfVisual } from "./rfVisual";
import { makeCircuitTexture, makeDotSprite, makeMetalRoughness } from "./textures";

interface Props {
  tier: "low" | "high";
}

const RED = new THREE.Color("#ff2d18");
const ORANGE = new THREE.Color("#ff7a2a");
const SCALE = 0.78; // вписываем глаз с гиро-кольцами в кадр hero-камеры

/* ---------------- HUD-радужка: шейдер ---------------- */

const irisVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }`;

const irisFrag = /* glsl */ `
  uniform float uTime, uPulse, uGlitch, uBlink;
  varying vec2 vUv;

  float hash(float n) { return fract(sin(n) * 43758.5453); }

  void main() {
    vec2 p = vUv * 2.0 - 1.0;

    // глитч: построчный сдвиг
    if (uGlitch > 0.01) {
      float row = floor(vUv.y * 26.0);
      float n = hash(row * 91.7 + floor(uTime * 28.0) * 7.13);
      if (n > 0.72) p.x += (n - 0.86) * 0.9 * uGlitch;
    }

    float r = length(p);
    if (r > 1.0) discard;
    float ang = atan(p.y, p.x);
    const float TAU = 6.28318530718;

    vec3 red    = vec3(2.3, 0.32, 0.16);
    vec3 orange = vec3(2.1, 0.92, 0.24);
    vec3 col    = vec3(0.012, 0.012, 0.015);

    // тонкие концентрические кольца
    col += vec3(0.05, 0.012, 0.008) * (smoothstep(0.35, 1.0, sin(r * 110.0) * 0.5 + 0.5));

    // внешний светящийся обод
    col += red * smoothstep(0.90, 0.985, r) * (1.0 - smoothstep(0.985, 1.0, r)) * (1.4 + 0.9 * uPulse);

    // шкала делений (60 штрихов)
    float tick = step(0.86, fract(ang / TAU * 60.0));
    col += red * tick * smoothstep(0.795, 0.81, r) * (1.0 - smoothstep(0.875, 0.89, r)) * 1.15;

    // вращающиеся дуги (в разные стороны)
    float a1 = fract((ang + uTime * 0.55) / TAU * 3.0);
    float arc1 = step(0.18, a1) * step(a1, 0.5);
    col += red * arc1 * smoothstep(0.66, 0.675, r) * (1.0 - smoothstep(0.73, 0.745, r)) * (0.9 + 0.6 * uPulse);

    float a2 = fract((ang - uTime * 0.34) / TAU * 5.0);
    float arc2 = step(0.32, a2) * step(a2, 0.78);
    col += orange * arc2 * smoothstep(0.545, 0.56, r) * (1.0 - smoothstep(0.605, 0.62, r)) * 0.75;

    // пунктирное кольцо
    float dots = step(0.5, fract(ang / TAU * 24.0 + uTime * 0.12));
    col += red * dots * smoothstep(0.44, 0.455, r) * (1.0 - smoothstep(0.485, 0.50, r)) * 0.9;

    // тёплое свечение из глубины зрачка
    col += orange * smoothstep(0.34, 0.0, r) * (0.7 + 0.7 * uPulse);
    col += vec3(2.8, 0.65, 0.28) * smoothstep(0.10, 0.0, r) * (1.0 + 0.8 * uPulse);

    // редкие искры по кольцам
    float spark = step(0.995, hash(floor(ang / TAU * 90.0) + floor(uTime * 3.0) * 13.7));
    col += red * spark * smoothstep(0.55, 0.9, r) * 2.0;

    col *= (1.0 - 0.9 * uBlink);
    col *= 0.75 + 0.25 * uPulse;
    gl_FragColor = vec4(col, 1.0);
  }`;

/* ---------------- Искры-частицы: шейдер ---------------- */

const sparkVert = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  varying float vTwinkle;
  varying float vHue;
  void main() {
    vHue = fract(aSeed * 0.37);
    vTwinkle = 0.35 + 0.65 * (0.5 + 0.5 * sin(uTime * (1.2 + fract(aSeed) * 2.2) + aSeed));
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = (20.0 + 17.0 * fract(aSeed * 7.7)) * vTwinkle / -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;

const sparkFrag = /* glsl */ `
  uniform float uPulse;
  varying float vTwinkle;
  varying float vHue;
  void main() {
    vec2 d = gl_PointCoord - 0.5;
    float r = length(d) * 2.0;
    if (r > 1.0) discard;
    float core = smoothstep(1.0, 0.15, r);
    vec3 col = vHue > 0.75 ? vec3(2.2, 1.0, 0.35) : vec3(2.6, 0.5, 0.25);
    col *= (0.8 + 0.7 * uPulse) * vTwinkle;
    gl_FragColor = vec4(col, core * vTwinkle);
  }`;

/* ---------------- Сборка глаза (императивно, 1:1 со standalone) ------------ */

interface EyeParts {
  root: THREE.Group;
  eyeGroup: THREE.Group;
  spin: THREE.Group;
  iris: THREE.Mesh;
  irisUniforms: {
    uTime: { value: number };
    uPulse: { value: number };
    uGlitch: { value: number };
    uBlink: { value: number };
  };
  sparkUniforms: { uTime: { value: number }; uPulse: { value: number } };
  blades: THREE.Group[];
  sensor: THREE.Mesh;
  shellMat: THREE.MeshStandardMaterial;
  circuitTex: THREE.CanvasTexture;
  ringMats: THREE.MeshStandardMaterial[]; // [outer, mid, inner]
  scanRing: THREE.Mesh;
  scanMat: THREE.MeshBasicMaterial;
  gyro1: THREE.Group;
  gyro2: THREE.Group;
  dust: THREE.Points | null;
  sparks: THREE.Points;
  irisLight: THREE.PointLight;
}

function makeShellPoints(count: number, rMin: number, rMax: number): THREE.BufferGeometry {
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  const v = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    v.randomDirection().multiplyScalar(rMin + Math.random() * (rMax - rMin));
    pos[i * 3] = v.x;
    pos[i * 3 + 1] = v.y;
    pos[i * 3 + 2] = v.z;
    seed[i] = Math.random() * 100;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seed, 1));
  return geo;
}

function buildEye(tier: "low" | "high"): EyeParts {
  const low = tier === "low";
  const root = new THREE.Group();
  root.scale.setScalar(SCALE);

  const eyeGroup = new THREE.Group(); // yaw/pitch — «взгляд»
  root.add(eyeGroup);
  const spin = new THREE.Group(); // вращение вокруг зрительной оси
  eyeGroup.add(spin);

  const circuitTex = makeCircuitTexture();
  const roughTex = makeMetalRoughness();

  // корпус с вырезом спереди под оптику
  const shellMat = new THREE.MeshStandardMaterial({
    color: 0x181b20,
    metalness: 0.92,
    roughness: 0.42,
    roughnessMap: roughTex,
    emissive: RED.clone(),
    emissiveMap: circuitTex,
    emissiveIntensity: 0.7,
    bumpMap: circuitTex,
    bumpScale: -0.6,
    side: THREE.DoubleSide,
  });
  const OPEN_ANGLE = 0.62;
  const shell = new THREE.Mesh(
    new THREE.SphereGeometry(1, low ? 96 : 160, low ? 72 : 120, 0, Math.PI * 2, OPEN_ANGLE, Math.PI - OPEN_ANGLE),
    shellMat,
  );
  shell.rotation.x = Math.PI / 2;
  spin.add(shell);

  // экваториальный шов + затылочный порт
  const seamMat = new THREE.MeshStandardMaterial({ color: 0x0c0e11, metalness: 0.9, roughness: 0.5 });
  const seam = new THREE.Mesh(new THREE.TorusGeometry(1.0, 0.012, 12, low ? 120 : 200), seamMat);
  seam.rotation.x = Math.PI / 2;
  spin.add(seam);

  const portMat = new THREE.MeshStandardMaterial({ color: 0x24282f, metalness: 0.95, roughness: 0.3 });
  const p1 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.18, 32), portMat);
  p1.rotation.x = Math.PI / 2;
  p1.position.z = -1.0;
  const p2 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.3, 24), portMat);
  p2.rotation.x = Math.PI / 2;
  p2.position.z = -1.1;
  const tip = new THREE.Mesh(
    new THREE.SphereGeometry(0.045, 16, 16),
    new THREE.MeshStandardMaterial({ color: 0x000000, emissive: ORANGE, emissiveIntensity: 2.2 }),
  );
  tip.position.z = -1.26;
  spin.add(p1, p2, tip);

  // передняя оптика
  const optics = new THREE.Group();
  spin.add(optics);

  const gunmetal = new THREE.MeshStandardMaterial({ color: 0x2b3038, metalness: 0.95, roughness: 0.28 });
  const darkMetal = new THREE.MeshStandardMaterial({
    color: 0x101317,
    metalness: 0.9,
    roughness: 0.45,
    side: THREE.DoubleSide,
  });

  const bezel = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.075, 24, 96), gunmetal);
  bezel.position.z = 0.792;
  optics.add(bezel);

  const boltGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.03, 6);
  const boltMat = new THREE.MeshStandardMaterial({ color: 0x454b55, metalness: 0.95, roughness: 0.25 });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const b = new THREE.Mesh(boltGeo, boltMat);
    b.position.set(Math.cos(a) * 0.62, Math.sin(a) * 0.62, 0.862);
    b.rotation.x = Math.PI / 2;
    optics.add(b);
  }

  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.585, 0.42, 0.14, 96, 1, true), darkMetal);
  barrel.rotation.x = Math.PI / 2;
  barrel.position.z = 0.735;
  optics.add(barrel);

  const step = new THREE.Mesh(new THREE.TorusGeometry(0.46, 0.02, 12, 96), gunmetal);
  step.position.z = 0.705;
  optics.add(step);

  const backplate = new THREE.Mesh(new THREE.CircleGeometry(0.46, 96), darkMetal);
  backplate.position.z = 0.66;
  optics.add(backplate);

  // светящиеся кольца вокруг зрачка
  const ringMats: THREE.MeshStandardMaterial[] = [];
  const glowRing = (radius: number, tube: number, color: THREE.Color, z: number) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, roughness: 1 });
    ringMats.push(mat);
    const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 16, 96), mat);
    m.position.z = z;
    optics.add(m);
  };
  glowRing(0.515, 0.014, RED, 0.76);
  glowRing(0.41, 0.01, ORANGE, 0.72);
  glowRing(0.295, 0.009, RED, 0.775);

  // HUD-радужка
  const irisUniforms = {
    uTime: { value: 0 },
    uPulse: { value: 0 },
    uGlitch: { value: 0 },
    uBlink: { value: 0 },
  };
  const irisMat = new THREE.ShaderMaterial({
    uniforms: irisUniforms,
    vertexShader: irisVert,
    fragmentShader: irisFrag,
  });
  const iris = new THREE.Mesh(new THREE.CircleGeometry(0.4, 96), irisMat);
  iris.position.z = 0.695;
  optics.add(iris);

  // «сенсор» в центре зрачка
  const sensor = new THREE.Mesh(
    new THREE.SphereGeometry(0.035, 24, 24),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(3.0, 0.55, 0.28), toneMapped: false }),
  );
  sensor.position.z = 0.72;
  optics.add(sensor);

  // 7-лепестковая диафрагма
  const bladeGroup = new THREE.Group();
  bladeGroup.position.z = 0.745;
  optics.add(bladeGroup);

  const bladeMat = new THREE.MeshStandardMaterial({
    color: 0x22262d,
    metalness: 0.95,
    roughness: 0.32,
    side: THREE.DoubleSide,
  });
  const rivetMat = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: RED, emissiveIntensity: 1.4 });

  const bladeShape = new THREE.Shape();
  bladeShape.moveTo(0, 0.045);
  bladeShape.quadraticCurveTo(0.27, 0.125, 0.5, 0.02);
  bladeShape.quadraticCurveTo(0.3, -0.12, 0.02, -0.07);
  bladeShape.quadraticCurveTo(-0.05, -0.02, 0, 0.045);
  const bladeGeo = new THREE.ExtrudeGeometry(bladeShape, {
    depth: 0.014,
    bevelEnabled: true,
    bevelThickness: 0.004,
    bevelSize: 0.004,
    bevelSegments: 2,
    curveSegments: 24,
  });
  const rivetGeo = new THREE.CylinderGeometry(0.018, 0.018, 0.03, 12);

  const blades: THREE.Group[] = [];
  const N_BLADES = 7;
  const PIVOT_R = 0.34;
  for (let i = 0; i < N_BLADES; i++) {
    const pivotAngle = (i / N_BLADES) * Math.PI * 2;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(pivotAngle) * PIVOT_R, Math.sin(pivotAngle) * PIVOT_R, (i % 2) * 0.006);
    const blade = new THREE.Mesh(bladeGeo, bladeMat);
    const rivet = new THREE.Mesh(rivetGeo, rivetMat);
    rivet.rotation.x = Math.PI / 2;
    pivot.add(blade, rivet);
    pivot.userData.baseAngle = pivotAngle;
    bladeGroup.add(pivot);
    blades.push(pivot);
  }

  // стеклянный купол-«роговица»
  const glass = new THREE.Mesh(
    new THREE.SphereGeometry(1.005, low ? 64 : 96, low ? 32 : 48, 0, Math.PI * 2, 0, 0.69),
    new THREE.MeshPhysicalMaterial({
      color: 0x0a0c10,
      metalness: 0,
      roughness: 0.03,
      transparent: true,
      opacity: 0.16,
      envMapIntensity: 1.1,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      depthWrite: false,
    }),
  );
  glass.rotation.x = Math.PI / 2;
  spin.add(glass);

  // гиро-кольца
  const gyro1 = new THREE.Group();
  const gyro2 = new THREE.Group();
  eyeGroup.add(gyro1, gyro2);
  const gyroMat = new THREE.MeshStandardMaterial({ color: 0x30353d, metalness: 0.95, roughness: 0.3 });
  gyro1.add(new THREE.Mesh(new THREE.TorusGeometry(1.38, 0.02, 12, low ? 100 : 160), gyroMat));
  gyro2.add(new THREE.Mesh(new THREE.TorusGeometry(1.58, 0.013, 10, low ? 110 : 180), gyroMat));
  const beadGeo = new THREE.SphereGeometry(0.032, 12, 12);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const bead = new THREE.Mesh(
      beadGeo,
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: i % 2 ? ORANGE : RED, emissiveIntensity: 2.8 }),
    );
    bead.position.set(Math.cos(a) * 1.38, Math.sin(a) * 1.38, 0);
    gyro1.add(bead);
  }
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const bead = new THREE.Mesh(
      beadGeo,
      new THREE.MeshStandardMaterial({ color: 0x000000, emissive: RED, emissiveIntensity: 2.5 }),
    );
    bead.position.set(Math.cos(a) * 1.58, Math.sin(a) * 1.58, 0);
    gyro2.add(bead);
  }
  gyro1.rotation.x = 1.15;
  gyro2.rotation.set(0.4, 0.9, 0.3);

  // скан-кольцо
  const scanMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(3, 0.4, 0.2),
    transparent: true,
    opacity: 0,
    toneMapped: false,
    depthWrite: false,
  });
  const scanRing = new THREE.Mesh(new THREE.TorusGeometry(1, 0.006, 8, 128), scanMat);
  scanRing.rotation.x = Math.PI / 2;
  eyeGroup.add(scanRing);

  // частицы
  let dust: THREE.Points | null = null;
  if (!low) {
    dust = new THREE.Points(
      makeShellPoints(220, 1.7, 3.2),
      new THREE.PointsMaterial({
        color: 0x8a919c,
        size: 0.03,
        sizeAttenuation: true,
        map: makeDotSprite(),
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
        alphaTest: 0.05,
      }),
    );
    root.add(dust);
  }

  const sparkUniforms = { uTime: { value: 0 }, uPulse: { value: 0 } };
  const sparkMat = new THREE.ShaderMaterial({
    uniforms: sparkUniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: sparkVert,
    fragmentShader: sparkFrag,
  });
  const sparks = new THREE.Points(makeShellPoints(low ? 60 : 120, 1.55, 2.9), sparkMat);
  root.add(sparks);

  // красная подсветка пространства перед глазом
  const irisLight = new THREE.PointLight(RED, 2, 7, 2);
  irisLight.position.set(0, 0, 1.6);
  root.add(irisLight);

  return {
    root,
    eyeGroup,
    spin,
    iris,
    irisUniforms,
    sparkUniforms,
    blades,
    sensor,
    shellMat,
    circuitTex,
    ringMats,
    scanRing,
    scanMat,
    gyro1,
    gyro2,
    dust,
    sparks,
    irisLight,
  };
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
    else mat?.dispose();
  });
}

/* ---------------- Компонент ---------------- */

export function CyborgEye({ tier }: Props) {
  const parts = useMemo(() => buildEye(tier), [tier]);
  useEffect(() => () => disposeTree(parts.root), [parts]);

  const st = useRef({
    gaze: { yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, next: 1.5 },
    ap: { value: 0.75, target: 0.75, nextAdjust: 3, blinkT: -1, nextBlink: 4 },
    glitch: { level: 0, next: 2.5, until: 0 },
    scan: { t: -1, next: 3.5 },
  });

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const dt = Math.min(delta, 0.05);
    const k = (rate: number) => 1 - Math.exp(-dt * rate);
    const alert = rfVisual.corridorActive;
    const s = st.current;
    const P = parts;

    // пульс: в бою — учащённый «сердечный ритм»
    const pulse = 0.5 + 0.5 * Math.sin(t * (alert ? 5.2 : 2.1)) * (0.7 + 0.3 * Math.sin(t * 0.37));

    // вращение вокруг зрительной оси + саккады (в бою — резче и шире)
    P.spin.rotation.z = t * (alert ? 0.35 : 0.12);
    if (t > s.gaze.next) {
      const range = alert ? 0.42 : 0.3;
      s.gaze.tYaw = (Math.random() * 2 - 1) * range;
      s.gaze.tPitch = (Math.random() * 2 - 1) * range * 0.6;
      s.gaze.next = t + (alert ? 0.22 + Math.random() * 0.35 : 1.8 + Math.random() * 2.6);
    }
    const gk = k(alert ? 26 : 3.2);
    s.gaze.yaw += (s.gaze.tYaw - s.gaze.yaw) * gk;
    s.gaze.pitch += (s.gaze.tPitch - s.gaze.pitch) * gk;
    const tremor = alert ? 0.02 : 0.01;
    P.eyeGroup.rotation.y = s.gaze.yaw + Math.sin(t * (alert ? 30 : 1.3)) * tremor;
    P.eyeGroup.rotation.x = -s.gaze.pitch + Math.cos(t * (alert ? 26 : 1.7)) * tremor * 0.7;

    // радужка вращается в противоход
    P.iris.rotation.z = -t * (alert ? 0.8 : 0.3);

    // диафрагма: автофокус (в бою — прищур) + медленное моргание
    if (t > s.ap.nextAdjust && s.ap.blinkT < 0) {
      s.ap.target = alert ? 0.18 + Math.random() * 0.17 : 0.45 + Math.random() * 0.5;
      s.ap.nextAdjust = t + (alert ? 0.5 + Math.random() * 1 : 1.5 + Math.random() * 3.5);
    }
    if (t > s.ap.nextBlink && s.ap.blinkT < 0) {
      s.ap.blinkT = 0;
      s.ap.nextBlink = t + (alert ? 6 + Math.random() * 4 : 4 + Math.random() * 4);
    }
    let blinkClose = 0;
    if (s.ap.blinkT >= 0) {
      s.ap.blinkT += dt / 0.9;
      if (s.ap.blinkT >= 1) s.ap.blinkT = -1;
      else {
        const ph = s.ap.blinkT;
        blinkClose =
          ph < 0.38 ? THREE.MathUtils.smoothstep(ph, 0, 0.38) : ph < 0.55 ? 1 : 1 - THREE.MathUtils.smoothstep(ph, 0.55, 1);
      }
    }
    s.ap.value += (s.ap.target - s.ap.value) * k(alert ? 10 : 6);
    const open = s.ap.value * (1 - blinkClose);
    const closedRot = Math.PI + 0.5;
    const openRot = Math.PI + 1.3;
    const rot = closedRot + (openRot - closedRot) * open;
    for (const p of P.blades) p.rotation.z = (p.userData.baseAngle as number) + rot;
    P.irisUniforms.uBlink.value = blinkClose;
    P.sensor.visible = blinkClose < 0.85;

    // глитчи (в бою — чаще)
    if (t > s.glitch.next) {
      s.glitch.until = t + 0.12 + Math.random() * 0.3;
      s.glitch.next = t + (alert ? 0.8 + Math.random() * 1.4 : 2.2 + Math.random() * 4.5);
    }
    const gActive = t < s.glitch.until;
    s.glitch.level += ((gActive ? 1 : 0) - s.glitch.level) * k(gActive ? 30 : 12);
    P.irisUniforms.uGlitch.value = s.glitch.level;
    if (gActive && Math.random() < 0.35) {
      P.circuitTex.offset.x = Math.random();
      P.circuitTex.offset.y = Math.random() * 0.3;
    }

    // скан-кольцо
    if (t > s.scan.next && s.scan.t < 0) {
      s.scan.t = 0;
      s.scan.next = t + (alert ? 2.5 + Math.random() * 2 : 5 + Math.random() * 5);
    }
    if (s.scan.t >= 0) {
      s.scan.t += dt / 1.6;
      if (s.scan.t >= 1) {
        s.scan.t = -1;
        P.scanMat.opacity = 0;
      } else {
        const y = 1.04 - s.scan.t * 2.08;
        P.scanRing.position.y = y;
        P.scanRing.scale.setScalar(Math.sqrt(Math.max(0.0001, 1.045 - y * y)));
        P.scanMat.opacity = 0.75 * Math.sin(s.scan.t * Math.PI);
      }
    }

    // пульсация свечения (форсаж в бою)
    const boost = alert ? 1.35 : 1;
    const glowK = (0.55 + 0.45 * pulse + s.glitch.level * 1.2) * boost;
    P.shellMat.emissiveIntensity = 0.45 * glowK + s.glitch.level * 2.2;
    P.ringMats[0].emissiveIntensity = 2.0 * glowK;
    P.ringMats[1].emissiveIntensity = 1.7 * glowK;
    P.ringMats[2].emissiveIntensity = 2.3 * glowK;
    P.irisUniforms.uPulse.value = pulse;
    P.irisUniforms.uTime.value = t;
    P.sparkUniforms.uTime.value = t;
    P.sparkUniforms.uPulse.value = pulse;
    P.irisLight.intensity = (1.2 + 1.6 * pulse) * boost * (1 - blinkClose * 0.9);
    P.sensor.scale.setScalar(0.85 + 0.45 * pulse);

    // гиро-кольца и частицы
    P.gyro1.rotation.z += dt * (alert ? 0.9 : 0.25);
    P.gyro1.rotation.x = 1.15 + Math.sin(t * 0.4) * 0.12;
    P.gyro2.rotation.z -= dt * (alert ? 0.6 : 0.18);
    P.gyro2.rotation.y += dt * 0.1;
    if (P.dust) P.dust.rotation.y += dt * 0.03;
    P.sparks.rotation.y -= dt * 0.05;
    P.sparks.rotation.x = Math.sin(t * 0.1) * 0.1;
  });

  return <primitive object={parts.root} />;
}
