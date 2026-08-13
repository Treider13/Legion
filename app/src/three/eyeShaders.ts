// ============================================================================
// LEGION — GLSL «живого» биомеханического глаза (hero, фаза «глаз киборга»).
// Сфера-глазное яблоко: склера с сосудами, радужка (крипты/волокна),
// зрачок, роговичный блик (влажность), лимбальное кибер-кольцо, веки (моргание).
// uAlert 0→1: покой (бирюза) → боевой (красный, злой). uBlink: моргание.
// ============================================================================

export const EYE_IRIS = [0.16, 0.72, 0.7]; // бирюза (покой)
export const EYE_ALERT = [0.95, 0.12, 0.08]; // красный (боевой)
export const EYE_SCLERA = [0.74, 0.75, 0.78]; // приглушённый белок (ниже порога Bloom)

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
    for (int i = 0; i < 4; i++){ v += a * vnoise(p); p *= 2.0; a *= 0.5; }
    return v;
  }

  void main(){
    vec3 N = normalize(vNormalV);
    vec3 V = normalize(-vView);
    float ndv = max(dot(N, V), 0.0);

    float polar = acos(clamp(vLocal.z, -1.0, 1.0)); // 0 в центре передней части
    float ang = atan(vLocal.y, vLocal.x);
    float irisEdge = 0.60;
    float r = polar / irisEdge; // 0..1 внутри радужки

    vec3 irisBase = mix(uIris, uAlertCol, uAlert);

    // --- склера + сосуды ---
    vec3 sclera = uSclera;
    float veinN = fbm(vec2(ang * 2.5, polar * 5.0) + 7.0);
    float veinMask = smoothstep(0.62, 0.95, veinN) * smoothstep(irisEdge * 1.02, 1.4, polar);
    sclera = mix(sclera, vec3(0.6, 0.11, 0.09), veinMask * (0.5 + 0.4 * uAlert));
    sclera *= 0.72 + 0.28 * ndv;

    vec3 col;
    if (r >= 1.0) {
      col = sclera;
    } else {
      // радужка: крипты + радиальные волокна
      float crypt = fbm(vLocal.xy * 40.0 + uTime * 0.02);
      float streak = 0.5 + 0.5 * sin(ang * 70.0 + fbm(vLocal.xy * 10.0) * 8.0);
      float tex = mix(0.72, 1.12, crypt) * mix(0.78, 1.08, streak);
      vec3 iris = irisBase * tex;
      iris *= mix(1.25, 0.42, smoothstep(0.15, 1.0, r));       // ярче в середине
      iris = mix(iris, iris * 0.14, smoothstep(0.86, 1.0, r)); // тёмное лимбальное кольцо
      float glow = smoothstep(uPupil + 0.12, uPupil, r);       // внутреннее свечение у зрачка
      iris += irisBase * glow * (0.4 + 1.3 * uAlert);
      float pin = smoothstep(uPupil, uPupil - 0.015, r);       // зрачок
      col = mix(iris, vec3(0.015), pin);
      col *= 0.75 + 0.25 * ndv;
      col = mix(col, sclera, smoothstep(0.97, 1.03, r));       // плавный лимб
    }

    // --- кибер-кольцо на лимбе + насечки ---
    float ring = smoothstep(0.03, 0.0, abs(r - 0.92)) * step(r, 1.06);
    float ticks = 0.55 + 0.45 * sin(ang * 48.0);
    col += irisBase * ring * (0.55 + 1.1 * uAlert) * (0.6 + 0.4 * ticks);

    // --- роговичный блик (влажность) ---
    float corneaMask = smoothstep(0.95, 0.15, polar);
    vec3 L = normalize(vec3(0.35, 0.55, 0.85));
    float spec = pow(max(dot(N, normalize(L + V)), 0.0), 90.0);
    col += vec3(1.0) * spec * corneaMask * 0.95;
    vec3 L2 = normalize(vec3(-0.3, -0.18, 0.9));
    float spec2 = pow(max(dot(N, normalize(L2 + V)), 0.0), 140.0);
    col += vec3(0.85, 0.95, 1.0) * spec2 * corneaMask * 0.5;

    // --- fresnel-обводка ---
    float fres = pow(1.0 - ndv, 3.0);
    col += irisBase * fres * (0.12 + 0.5 * uAlert);

    // --- «злой» пульс в боевом режиме ---
    col *= mix(1.0, 0.9 + 0.14 * sin(uTime * 12.0), uAlert);
    col = mix(col, col * vec3(1.15, 0.82, 0.82), uAlert * 0.3);

    // --- моргание: веки в экранном (view) пространстве ---
    float dy = abs(vView.y - uEyeCenterView.y);
    float open = mix(1.35, 0.0, uBlink);
    float covered = smoothstep(open, open + 0.04, dy);
    col = mix(col, vec3(0.02, 0.02, 0.025), covered);

    gl_FragColor = vec4(col, 1.0);
  }
`;
