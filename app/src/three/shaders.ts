// ============================================================================
// LEGION — кастомные GLSL-шейдеры (фирменный вид, не шаблон).
// Сфера-точки с fresnel-обводкой, радарный луч с затухающим хвостом,
// спектральное кольцо с дугой коридора и маркером частоты.
// ============================================================================

export const ACCENT = [0.18, 0.83, 0.75];  // #2dd4bf — бирюза (акцент)
export const PHOSPHOR = [0.37, 0.95, 0.63]; // #5ef2a0 — мятный LOCK
export const OLIVE = [0.2, 0.35, 0.42];    // приглушённый сине-серый rim

// --- Точечная сфера: лёгкое «дыхание» + затухание к полюсам -----------------
export const pointsVert = /* glsl */ `
  uniform float uTime;
  attribute float aScale;
  varying float vFade;
  void main() {
    vec3 p = position;
    p += 0.012 * sin(uTime * 0.7 + position.y * 9.0 + position.x * 5.0)
         * normalize(position);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = aScale * 230.0 / -mv.z;
    vFade = 0.55 + 0.45 * smoothstep(-1.0, 1.0, normalize(position).y);
    gl_Position = projectionMatrix * mv;
  }
`;

export const pointsFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLock;      // 0/1 → сдвиг к фосфору
  uniform vec3 uLockColor;
  varying float vFade;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.08, d) * vFade * 0.24;
    vec3 c = mix(uColor, uLockColor, uLock * 0.55);
    gl_FragColor = vec4(c, a);
  }
`;

// --- Базовая сфера: fresnel-обводка (rim glow) -------------------------------
export const fresnelVert = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`;

export const fresnelFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uLock;
  uniform vec3 uLockColor;
  uniform float uTime;
  varying vec3 vNormal;
  varying vec3 vView;
  void main() {
    float f = pow(1.0 - abs(dot(normalize(vNormal), normalize(vView))), 2.6);
    float pulse = uLock * (0.55 + 0.45 * sin(uTime * 4.0));
    vec3 c = mix(uColor, uLockColor, pulse);
    gl_FragColor = vec4(c, f * (0.22 + 0.2 * uLock));
  }
`;

// --- Радарный луч: вращающийся сектор с экспоненциальным хвостом -------------
export const sweepVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

export const sweepFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uActive;   // 0 — медленный дежурный луч, 1 — быстрый (коридор)
  varying vec2 vUv;
  void main() {
    float r = length(vUv);
    if (r > 1.0) discard;
    float ang = atan(vUv.y, vUv.x);            // -PI..PI
    float speed = mix(0.35, 2.2, uActive);
    float beam = mod(uTime * speed, 6.2831853);
    float d = mod(beam - ang, 6.2831853);      // расстояние позади луча
    float trail = exp(-3.2 * d);               // экспоненциальный хвост
    float edge = smoothstep(1.0, 0.85, r);     // мягкий край диска
    float rings = 0.22 * (0.5 + 0.5 * sin(r * 40.0)); // концентрические круги
    float a = (trail * 0.9 + rings) * edge;
    gl_FragColor = vec4(uColor, a * 0.5);
  }
`;

// --- Спектральное кольцо: дуга коридора + маркер текущей частоты -------------
export const ringVert = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv * 2.0 - 1.0;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// Кольцо рисуем на плоскости: r в [rIn, rOut]; угол → частота.
// uCorrA/uCorrB — дуга коридора (0..1 по окружности), uFreq01 — маркер.
export const ringFrag = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColor;
  uniform vec3 uLockColor;
  uniform float uLock;
  uniform float uCorrA;
  uniform float uCorrB;
  uniform float uFreq01;
  uniform float uHasCorr;
  varying vec2 vUv;

  const float R_IN = 0.86;
  const float R_OUT = 1.0;

  void main() {
    float r = length(vUv);
    if (r < R_IN || r > R_OUT) discard;
    float ang = atan(vUv.y, vUv.x);              // -PI..PI
    float u = (ang + 3.14159265) / 6.2831853;    // 0..1 по окружности

    // базовая тонкая дуга
    float base = smoothstep(R_IN, R_IN + 0.02, r) * smoothstep(R_OUT, R_OUT - 0.02, r);
    float alpha = 0.22 * base;

    // тики каждые 1/24 окружности
    float tick = step(0.985, fract(u * 24.0));
    alpha += tick * 0.25 * base;

    // дуга коридора — янтарная заливка
    float inCorr = step(uCorrA, u) * step(u, uCorrB);
    alpha += inCorr * 0.38 * base * uHasCorr;

    // маркер частоты — узкий светящийся штрих
    float dm = abs(fract(u - uFreq01 + 0.5) - 0.5); // круговое расстояние
    float marker = smoothstep(0.004, 0.0, dm);
    float mpulse = 0.7 + 0.3 * sin(uTime * 6.0);
    vec3 c = uColor + inCorr * 0.2;
    c = mix(c, uLockColor, marker * mpulse * uLock);
    alpha += marker * (0.5 + 0.5 * uLock) * mpulse;

    gl_FragColor = vec4(c, alpha);
  }
`;
