// Удельное поглощение газа по приложению 2 ITU-R P.676 (упрощённый метод itu-rpy).
// Поверхность: 1013,25 гПа, 15 °C, 7,5 г/м³ — средний годовой воздух у земли.
// Ниже 10 ГГц сюда не зовём: на этих частотах вклад меньше погрешности рельефа.

const P_HPA = 1013.25;
const T_K = 288.15;
const RHO = 7.5;

function phi(rp: number, rt: number, a: number, b: number, c: number, d: number): number {
  return rp ** a * rt ** b * Math.exp(c * (1 - rp) + d * (1 - rt));
}

function gLine(f: number, fi: number): number {
  return 1 + ((f - fi) / (f + fi)) ** 2;
}

/** Водяной пар, дБ/км. Приложение 2 P.676. */
export function gammaWaterDbPerKm(fGHz: number, pressure = P_HPA, tempK = T_K, rho = RHO): number {
  const rp = pressure / 1013;
  const rt = 288 / tempK;
  const eta1 = 0.955 * rp * rt ** 0.68 + 0.006 * rho;
  const eta2 = 0.735 * rp * rt ** 0.5 + 0.0353 * rt ** 4 * rho;
  const f = fGHz;
  const sum =
    (3.98 * eta1 * Math.exp(2.23 * (1 - rt))) / ((f - 22.235) ** 2 + 9.42 * eta1 ** 2) * gLine(f, 22) +
    (11.96 * eta1 * Math.exp(0.7 * (1 - rt))) / ((f - 183.31) ** 2 + 11.14 * eta1 ** 2) +
    (0.081 * eta1 * Math.exp(6.44 * (1 - rt))) / ((f - 321.226) ** 2 + 6.29 * eta1 ** 2) +
    (3.66 * eta1 * Math.exp(1.6 * (1 - rt))) / ((f - 325.153) ** 2 + 9.22 * eta1 ** 2) +
    (25.37 * eta1 * Math.exp(1.09 * (1 - rt))) / (f - 380) ** 2 +
    (17.4 * eta1 * Math.exp(1.46 * (1 - rt))) / (f - 448) ** 2 +
    (844.6 * eta1 * Math.exp(0.17 * (1 - rt))) / (f - 557) ** 2 * gLine(f, 557) +
    (290 * eta1 * Math.exp(0.41 * (1 - rt))) / (f - 752) ** 2 * gLine(f, 752) +
    (8.3328e4 * eta2 * Math.exp(0.99 * (1 - rt))) / (f - 1780) ** 2 * gLine(f, 1780);
  return sum * f ** 2 * rt ** 2.5 * rho * 1e-4;
}

/** Сухой воздух, дБ/км. Приложение 2 P.676, те же ветви, что в itu-rpy. */
export function gammaDryDbPerKm(fGHz: number, pressure = P_HPA, tempK = T_K): number {
  const rp = pressure / 1013;
  const rt = 288 / tempK;
  const f = fGHz;
  const xi1 = phi(rp, rt, 0.0717, -1.8132, 0.0156, -1.6515);
  const xi2 = phi(rp, rt, 0.5146, -4.6368, -0.1921, -5.7416);
  const xi3 = phi(rp, rt, 0.3414, -6.5851, 0.213, -8.5854);
  const xi4 = phi(rp, rt, -0.0112, 0.0092, -0.1033, -0.0009);
  const xi5 = phi(rp, rt, 0.2705, -2.7192, -0.3016, -4.1033);
  const xi6 = phi(rp, rt, 0.2445, -5.9191, 0.0422, -8.0719);
  const xi7 = phi(rp, rt, -0.1833, 6.5589, -0.2402, 6.131);
  const gamma54 = 2.192 * phi(rp, rt, 1.8286, -1.9487, 0.4051, -2.8509);
  const gamma58 = 12.59 * phi(rp, rt, 1.0045, 3.561, 0.1588, 1.2834);
  const gamma60 = 15 * phi(rp, rt, 0.9003, 4.1335, 0.0427, 1.6088);
  const gamma62 = 14.28 * phi(rp, rt, 0.9886, 3.4176, 0.1827, 1.3429);
  const gamma64 = 6.819 * phi(rp, rt, 1.432, 0.6258, 0.3177, -0.5914);
  const gamma66 = 1.908 * phi(rp, rt, 2.0717, -4.1404, 0.491, -4.8718);
  const delta = -0.00306 * phi(rp, rt, 3.211, -14.94, 1.583, -16.37);
  if (f <= 54) {
    return ((7.2 * rt ** 2.8) / (f ** 2 + 0.34 * rp ** 2 * rt ** 1.6) + (0.62 * xi3) / ((54 - f) ** (1.16 * xi1) + 0.83 * xi2)) * f ** 2 * rp ** 2 * 1e-3;
  }
  if (f <= 60) {
    return Math.exp(
      (Math.log(gamma54) / 24) * (f - 58) * (f - 60) -
      (Math.log(gamma58) / 8) * (f - 54) * (f - 60) +
      (Math.log(gamma60) / 12) * (f - 54) * (f - 58),
    );
  }
  if (f <= 62) return gamma60 + ((gamma62 - gamma60) * (f - 60)) / 2;
  if (f <= 66) {
    return Math.exp(
      (Math.log(gamma62) / 8) * (f - 64) * (f - 66) -
      (Math.log(gamma64) / 4) * (f - 62) * (f - 66) +
      (Math.log(gamma66) / 8) * (f - 62) * (f - 64),
    );
  }
  if (f <= 120) {
    return (
      (3.02e-4 * rt ** 3.5 +
        (0.283 * rt ** 3.8) / ((f - 118.75) ** 2 + 2.91 * rp ** 2 * rt ** 1.6) +
        (0.502 * xi6 * (1 - 0.0163 * xi7 * (f - 66))) / ((f - 66) ** (1.4346 * xi4) + 1.15 * xi5)) *
      f ** 2 *
      rp ** 2 *
      1e-3
    );
  }
  return (
    ((3.02e-4) / (1 + 1.9e-5 * f ** 1.5) + (0.283 * rt ** 0.3) / ((f - 118.75) ** 2 + 2.91 * rp ** 2 * rt ** 1.6)) *
      f ** 2 *
      rp ** 2 *
      rt ** 3.5 *
      1e-3 +
    delta
  );
}

/** Сумма сухого воздуха и пара, дБ/км. Выше 350 ГГц метод приложения 2 уже не заявлен. */
export function gas676DbPerKm(freqMhz: number): number {
  const f = freqMhz / 1000;
  if (f < 10 || f > 350) return 0;
  const dry = gammaDryDbPerKm(f);
  const wet = gammaWaterDbPerKm(f);
  if (!Number.isFinite(dry) || !Number.isFinite(wet)) return 0;
  return Math.max(0, dry + wet);
}
