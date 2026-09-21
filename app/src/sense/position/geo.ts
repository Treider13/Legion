// Дальняя и азимут на эллипсоиде WGS84 (Vincenty).
// Градусы на входе и выходе те же, что на карте: широта и долгота WGS84.

const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);

function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

function wrapLon(deg: number): number {
  return (((deg + 540) % 360) - 180);
}

interface Inverse {
  distanceM: number;
  azimuthDeg: number;
}

function vincentyInverse(lat1: number, lon1: number, lat2: number, lon2: number): Inverse {
  if (lat1 === lat2 && lon1 === lon2) return { distanceM: 0, azimuthDeg: 0 };
  const U1 = Math.atan((1 - F) * Math.tan(rad(lat1)));
  const U2 = Math.atan((1 - F) * Math.tan(rad(lat2)));
  const L = rad(lon2 - lon1);
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  let sinSigma = 0;
  let cosSigma = 0;
  let sigma = 0;
  let cos2Alpha = 0;
  let cos2SigmaM = 0;
  for (let i = 0; i < 80; i++) {
    const sinL = Math.sin(lambda);
    const cosL = Math.cos(lambda);
    sinSigma = Math.hypot(cosU2 * sinL, cosU1 * sinU2 - sinU1 * cosU2 * cosL);
    if (sinSigma === 0) return { distanceM: 0, azimuthDeg: 0 };
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinL) / sinSigma;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigmaM = Math.abs(cos2Alpha) < 1e-12 ? 0 : cosSigma - (2 * sinU1 * sinU2) / cos2Alpha;
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    const next = L + (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(next - lambda) < 1e-12) {
      lambda = next;
      break;
    }
    lambda = next;
  }
  const u2 = cos2Alpha * ((A * A - B * B) / (B * B));
  const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const delta = bigB * sinSigma * (cos2SigmaM + (bigB / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) - (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  const azimuth = Math.atan2(cosU2 * Math.sin(lambda), cosU1 * sinU2 - sinU1 * cosU2 * Math.cos(lambda));
  return { distanceM: B * bigA * (sigma - delta), azimuthDeg: (azimuth * 180) / Math.PI };
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return vincentyInverse(lat1, lon1, lat2, lon2).distanceM / 1000;
}

/** Азимут в градусах от севера, по часовой, от −180 до 180. */
export function azimuthDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return vincentyInverse(lat1, lon1, lat2, lon2).azimuthDeg;
}

export function destination(lat: number, lon: number, bearingDeg: number, distKm: number): { lat: number; lon: number } {
  const alpha1 = rad(bearingDeg);
  const sinAlpha1 = Math.sin(alpha1);
  const cosAlpha1 = Math.cos(alpha1);
  const tanU1 = (1 - F) * Math.tan(rad(lat));
  const cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1);
  const sinU1 = tanU1 * cosU1;
  const sigma1 = Math.atan2(tanU1, cosAlpha1);
  const sinAlpha = cosU1 * sinAlpha1;
  const cos2Alpha = 1 - sinAlpha * sinAlpha;
  const u2 = cos2Alpha * ((A * A - B * B) / (B * B));
  const bigA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const bigB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const s = distKm * 1000;
  let sigma = s / (B * bigA);
  let cos2SigmaM = 0;
  let sinSigma = 0;
  let cosSigma = 0;
  for (let i = 0; i < 80; i++) {
    cos2SigmaM = Math.cos(2 * sigma1 + sigma);
    sinSigma = Math.sin(sigma);
    cosSigma = Math.cos(sigma);
    const delta = bigB * sinSigma * (cos2SigmaM + (bigB / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) - (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
    const next = s / (B * bigA) + delta;
    if (Math.abs(next - sigma) < 1e-12) {
      sigma = next;
      break;
    }
    sigma = next;
  }
  const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosAlpha1;
  const lat2 = Math.atan2(sinU1 * cosSigma + cosU1 * sinSigma * cosAlpha1, (1 - F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp));
  const lambda = Math.atan2(sinSigma * sinAlpha1, cosU1 * cosSigma - sinU1 * sinSigma * cosAlpha1);
  const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
  const L = lambda - (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
  return { lat: (lat2 * 180) / Math.PI, lon: wrapLon(lon + (L * 180) / Math.PI) };
}

/** Угол между двумя направлениями, градусы. */
export function angleOffDeg(fromAz: number, fromEl: number, toAz: number, toEl: number): number {
  const daz = rad(toAz - fromAz);
  const e1 = rad(fromEl);
  const e2 = rad(toEl);
  const cos = Math.sin(e1) * Math.sin(e2) + Math.cos(e1) * Math.cos(e2) * Math.cos(daz);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

/** Градусы как на карте: 6 знаков после точки, это около 0,1 м. */
export function formatDeg(deg: number): string {
  if (!Number.isFinite(deg)) return "";
  return `${deg.toFixed(6)}°`;
}

/** Прогиб радиолуча, k = 4/3. Метры. d1 и d2 — километры до концов. */
export function earthBulgeM(d1Km: number, d2Km: number): number {
  return (d1Km * d2Km) / 16.989;
}
