// ============================================================================
// LEGION — GLSL «живого» биомеханического глаза (hero). Цель — фотореализм,
// близкий к концепту: радужка со светящимися схемо-дорожками (PCB), зрачок —
// механическая диафрагма, сосуды на белке, влажные роговичные блики.
// uAlert 0→1: покой (бирюза) → боевой (красный). uBlink — моргание.
// ============================================================================

export const EYE_IRIS = [0.1, 0.6, 0.56]; // бирюза (покой)
export const EYE_ALERT = [0.85, 0.1, 0.07]; // красный (боевой)
export const EYE_SCLERA = [0.72, 0.73, 0.76];

export const eyeVert = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vView;
  varying vec3 vNormalV;
  void main() {
    vLocal = normalize(position);
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vView = mv.xyz;
    vNormalV = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mv;
  }
`;

export const eyeFrag = /* glsl */ `
  precision highp float;
  #define PI 3.141592653589793
  uniform float uTime;
  uniform float uAlert;
  uniform float uBlink;
  uniform float uPupil;
  uniform vec3  uIris;
  uniform vec3  uAlertCol;
  uniform vec3  uSclera;
  uniform vec3  uEyeCenterView;
  varying vec3 vLocal;
  varying vec3 vView;
  varying vec3 vNormalV;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
               mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++){ v += a * vnoise(p); p *= 2.0; a *= 0.5; }
    return v;
  }
  // Сегментированное кольцо (пунктир) — элемент «печатной платы»
  float ringLine(float r, float R, float a01, float seg){
    float band = smoothstep(0.014, 0.0, abs(r - R));
    float dash = step(0.4, fract(a01 * seg));
    return band * dash;
  }

  void main(){
    vec3 N = normalize(vNormalV);
    vec3 V = normalize(-vView);
    float ndv = max(dot(N, V), 0.0);

    float polar = acos(clamp(vLocal.z, -1.0, 1.0));
    float ang = atan(vLocal.y, vLocal.x);
    float a01 = (ang + PI) / (2.0 * PI);
    float irisEdge = 0.62;
    float r = polar / irisEdge;

    vec3 accent = mix(uIris, uAlertCol, uAlert);
    vec3 circuitCol = mix(vec3(0.3, 1.0, 0.9), vec3(1.0, 0.25, 0.18), uAlert);

    // ---------------- СКЛЕРА (белок) + сосуды ----------------
    vec3 sclera = uSclera;
    float vein = smoothstep(0.58, 0.96, fbm(vec2(ang * 3.0, polar * 7.0) + 3.0));
    vein *= smoothstep(irisEdge * 1.03, 1.5, polar);
    sclera = mix(sclera, vec3(0.6, 0.12, 0.1), vein * (0.55 + 0.4 * uAlert));
    sclera *= 0.68 + 0.32 * ndv;
    // мягкое затемнение к краям белка (посадка в веки/оправу)
    sclera *= 1.0 - 0.5 * smoothstep(1.1, 1.7, polar);

    vec3 col;
    if (r >= 1.0) {
      col = sclera;
    } else {
      // базовая радужка: тёмный лимб → яркая середина, волокна
      float fib = fbm(vLocal.xy * 60.0);
      float fibStreak = 0.5 + 0.5 * sin(ang * 90.0 + fbm(vLocal.xy * 12.0) * 10.0);
      vec3 iris = mix(accent * 1.15, accent * 0.2, smoothstep(0.12, 1.0, r));
      iris *= mix(0.72, 1.2, fib) * mix(0.82, 1.06, fibStreak);
      // collarette (воротничок радужки)
      iris += accent * 0.4 * smoothstep(0.05, 0.0, abs(r - 0.42));
      // тёмное лимбальное кольцо
      iris = mix(iris, iris * 0.1, smoothstep(0.85, 1.0, r));

      // ---------- СХЕМО-ДОРОЖКИ (PCB) ----------
      float circuit = 0.0;
      circuit += ringLine(r, 0.30, a01, 24.0);
      circuit += ringLine(r, 0.50, a01, 40.0);
      circuit += ringLine(r, 0.66, a01, 52.0);
      circuit += ringLine(r, 0.80, a01, 64.0);
      // радиальные трассы в средней зоне
      float sect = abs(fract(a01 * 30.0) - 0.5);
      float radial = smoothstep(0.05, 0.0, sect) * step(0.28, r) * step(r, 0.84);
      circuit += radial * 0.9;
      // узлы (светящиеся точки на пересечениях)
      float nodeR = smoothstep(0.03, 0.0, abs(r - 0.50));
      float nodeA = step(0.9, fract(a01 * 20.0));
      circuit += nodeR * nodeA * 1.4;
      // «течение энергии» по дорожкам
      float flow = 0.55 + 0.45 * sin(uTime * 3.0 - r * 22.0 + ang * 2.0);
      iris += circuitCol * circuit * (0.7 + 0.5 * flow) * 1.5;

      // ---------- ЗРАЧОК-ДИАФРАГМА (механическая) ----------
      float hexR = uPupil * (0.9 + 0.1 * cos(6.0 * ang));
      float pupilMask = smoothstep(hexR, hexR - 0.02, r);       // 1 внутри
      float rimGlow = smoothstep(0.045, 0.0, abs(r - hexR));    // кольцо по краю
      float spokes = smoothstep(0.028, 0.0, abs(fract(ang / (PI / 3.0)) - 0.5))
                     * step(hexR, r) * step(r, hexR * 1.6);     // лепестки диафрагмы
      vec3 metal = vec3(0.32, 0.37, 0.4);
      col = mix(iris, vec3(0.01), pupilMask);
      col = mix(col, metal, clamp(rimGlow * 0.5 + spokes * 0.45, 0.0, 1.0));
      col += circuitCol * rimGlow * 0.7;

      col *= 0.8 + 0.2 * ndv;
      col = mix(col, sclera, smoothstep(0.98, 1.04, r)); // плавный лимб
    }

    // внешнее кибер-кольцо (металл оправы у лимба)
    float lring = smoothstep(0.02, 0.0, abs(r - 0.99)) * step(r, 1.06);
    col += circuitCol * lring * 0.5;

    // ---------------- РОГОВИЦА: влажные блики ----------------
    float corneaMask = smoothstep(1.05, 0.12, polar);
    vec3 Lk = normalize(vec3(0.45, 0.6, 0.85));
    float s1 = pow(max(dot(N, normalize(Lk + V)), 0.0), 220.0);
    col += vec3(1.0) * s1 * corneaMask * 1.3;                 // острый catchlight
    float s2 = pow(max(dot(N, normalize(Lk + V)), 0.0), 10.0);
    col += vec3(0.55, 0.72, 0.8) * s2 * corneaMask * 0.14;    // широкий влажный блеск
    vec3 Lk2 = normalize(vec3(-0.4, -0.2, 0.9));
    float s3 = pow(max(dot(N, normalize(Lk2 + V)), 0.0), 340.0);
    col += vec3(0.9, 1.0, 1.0) * s3 * corneaMask * 0.7;       // второй маленький блик

    // fresnel-обводка
    float fres = pow(1.0 - ndv, 3.0);
    col += accent * fres * (0.1 + 0.5 * uAlert);

    // «злой» пульс в боевом режиме
    col *= mix(1.0, 0.9 + 0.12 * sin(uTime * 11.0), uAlert);

    // моргание: веки в экранном пространстве
    float dy = abs(vView.y - uEyeCenterView.y);
    float open = mix(1.4, 0.0, uBlink);
    col = mix(col, vec3(0.02, 0.02, 0.025), smoothstep(open, open + 0.04, dy));

    gl_FragColor = vec4(col, 1.0);
  }
`;
