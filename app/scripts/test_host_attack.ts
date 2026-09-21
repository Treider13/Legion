// ============================================================================
// LEGION — тесты хост-Атаки. Не трогают FPGA / ESP32 / detectFromBins.
// Запуск: npx tsx scripts/test_host_attack.ts
// ============================================================================
import { caCfar1d, detectAttackHits, ATTACK_MIN_BW_MHZ } from "../src/sense/attackDetect";
import { AttackTracker, ATTACK_MIN_HITS } from "../src/sense/attackTracks";
import { classifyAttackFamily, bandBucket } from "../src/sense/attackAtlas";
import {
  ATTACK_COOLDOWN_MS,
  ATTACK_HOLD_MIN_MS,
  ATTACK_TX_MAX_MHZ,
  attackWaveParams,
  clampAttackHoldMs,
  clipPaintToAllowlist,
  clampPaintToCaps,
  paintCenterMhz,
  paintRefuseReason,
  paintSpanMhz,
  paintTxFsHz,
  paintWaveHint,
  waveOccupiesPaintMhz,
} from "../src/sense/attackPaint";
import { detectFromBins, estimateNoiseFloor, hostPaintSpanMhz } from "../src/sdr/backend";
import { pickArmedAutoTarget, RESENSE_MS } from "../src/sense/hold";
import { useLegion } from "../src/state/store";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures += 1;
  }
}

function toneBins(center: number, span: number, n: number, toneAt: number, toneDbm: number): { freqMhz: number; powerDbm: number }[] {
  const out = [];
  for (let i = 0; i < n; i++) {
    const f = center - span / 2 + (span * i) / (n - 1);
    const df = Math.abs(f - toneAt);
    out.push({ freqMhz: f, powerDbm: df < span / n ? toneDbm : -92 });
  }
  return out;
}

async function waitFor(name: string, pred: () => boolean, ms = 3000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  console.log(`  (timeout waiting: ${name})`);
  return false;
}

async function main(): Promise<void> {
  check("старый пол 60% не тронут", estimateNoiseFloor([
    { freqMhz: 1, powerDbm: -90 },
    { freqMhz: 2, powerDbm: -88 },
    { freqMhz: 3, powerDbm: -86 },
    { freqMhz: 4, powerDbm: -84 },
    { freqMhz: 5, powerDbm: -10 },
  ]) === -88);
  check("crop/paint хоста 20 МГц как был", hostPaintSpanMhz(56) === 20);
  check("RESENSE_MS 1 с как был", RESENSE_MS === 1000);
  check(
    "pickArmed архив по-прежнему пуст",
    pickArmedAutoTarget({
      liveWindow: [],
      archive: [{ freqMhz: 2410, powerDbm: -5, noiseDbm: -90, snrDb: 85, ts: 1, forwarded: false }],
      heldMhz: null,
      heldPowerDbm: null,
      skipMhz: null,
      dispatch: "turn",
    }) === null,
  );

  const lin = new Array(80).fill(1);
  lin[40] = 40;
  const { det } = caCfar1d(lin);
  check("CFAR ловит пик в центре", det[40] === true);
  check("CFAR край не считает", det[0] === false && det[79] === false);

  const bins = toneBins(2442, 20, 256, 2442, -30);
  const hits = detectAttackHits(bins, 12);
  check("атака ловит несущую", hits.some((h) => Math.abs(h.freqMhz - 2442) < 0.5));
  check("мин. ширина не нулевая", hits.length > 0 && hits.every((h) => h.widthMhz >= ATTACK_MIN_BW_MHZ - 1e-9));

  const two = [
    ...toneBins(2440, 10, 128, 2437, -28),
    ...toneBins(2450, 10, 128, 2453, -28),
  ].sort((a, b) => a.freqMhz - b.freqMhz);
  const twoHits = detectAttackHits(two, 10);
  check("две палки не слиплись в одну", twoHits.length >= 2);

  const tr = new AttackTracker();
  const one = hits[0];
  tr.update(one ? [one] : [], 1);
  check("один кадр — ещё не confirmed", tr.confirmed().length === 0);
  tr.update(one ? [one] : [], 2);
  check(`после ${ATTACK_MIN_HITS} кадров — confirmed`, tr.confirmed().length >= 1);
  tr.update([], 3);
  tr.update([], 4);
  tr.update([], 5);
  check("три промаха остужают", tr.confirmed().length === 0);

  check("2.4 12 МГц sticky — цифровой класс", classifyAttackFamily({
    freqMhz: 2442, widthMhz: 12, duty: 0.85, streak: 8,
  }).id === "digital-video");
  check("5.8 8 МГц sticky — аналог", classifyAttackFamily({
    freqMhz: 5800, widthMhz: 8, duty: 0.9, streak: 10,
  }).id === "analog-video");
  check("915 узкий — 900-класс", classifyAttackFamily({
    freqMhz: 915, widthMhz: 0.5, duty: 0.2, streak: 1,
  }).id === "rc-900");
  check("корзина 5.8", bandBucket(5805) === "c58");

  const fat = clampPaintToCaps({ f1Mhz: 2400, f2Mhz: 2500 });
  check("рамка шире 40 обрезана", paintSpanMhz(fat) <= ATTACK_TX_MAX_MHZ + 1e-9);
  const bands = [{ f1Mhz: 2400, f2Mhz: 2500 }];
  const clipped = clipPaintToAllowlist({ f1Mhz: 2430, f2Mhz: 2440 }, bands);
  check("рамка в allowlist", clipped != null && paintCenterMhz(clipped!) > 2430);
  check("рамка вне полосы отказ", clipPaintToAllowlist({ f1Mhz: 900, f2Mhz: 910 }, bands) === null);
  check("без рамки ПЕРЕДАТЬ отказ", paintRefuseReason(null, bands, true)?.includes("мышкой") === true);
  check("без 50 Ом отказ", paintRefuseReason({ f1Mhz: 2430, f2Mhz: 2440 }, bands, false)?.includes("50") === true);
  check("выдержка режется", clampAttackHoldMs(10) === 200 && clampAttackHoldMs(999999) === 120000);
  const p = { f1Mhz: 2430, f2Mhz: 2450 };
  check("синус не заливает 20 МГц", waveOccupiesPaintMhz("sine", p, {}) < 1);
  check("шум заливает рамку", Math.abs(waveOccupiesPaintMhz("awgn", p, {}) - 20) < 1e-9);
  const chirp = attackWaveParams("chirp", p, {});
  check("чирп размах = рамка, не 1 МГц", (chirp.spanKhz ?? 0) >= 10000);
  check("fs рамки в потолке USB", paintTxFsHz(p) <= 40e6 && paintTxFsHz(p) >= 20e6 * 0.99);
  check("подсказка волны честная", paintWaveHint("sine", p, {}).includes("не всю"));

  const old = detectFromBins(bins, 12);
  check("detectFromBins по-прежнему жив", old.some((d) => Math.abs(d.freqMhz - 2442) < 0.5));

  const L = () => useLegion.getState();
  L().setSdrId("bladerf-micro-xa4");
  L().setSdrAllowField("sdrF1", "2400");
  L().setSdrAllowField("sdrF2", "2500");
  L().addSdrBand();
  L().setSdrLoad(true);
  L().setScanPattern("auto");
  L().setAttackHoldMs(ATTACK_HOLD_MIN_MS);
  L().armTxWave("awgn");
  L().setAttackPaint({ f1Mhz: 2430, f2Mhz: 2450 });
  check("рамка легла в стор", L().attackPaint != null && Math.abs(paintCenterMhz(L().attackPaint!) - 2440) < 0.05);

  L().setScanPattern("fpga");
  check("уход с Атаки чистит рамку", L().attackPaint == null && L().attackTracks.length === 0);
  L().setAttackPaint({ f1Mhz: 2430, f2Mhz: 2450 });
  check("рамка на FPGA не пишется", L().attackPaint == null);
  L().setScanPattern("auto");
  L().setAttackHoldMs(ATTACK_HOLD_MIN_MS);
  L().armTxWave("awgn");
  L().setAttackPaint({ f1Mhz: 2430, f2Mhz: 2450 });

  L().startScan();
  check("скан Атаки пошёл", await waitFor("scan", () => L().scanRunning));
  L().injectDemoTone();
  await L().startTransmit();
  check("рамка TX на центр, не на демо", L().transmitArmed && L().lastForwardMhz != null && Math.abs(L().lastForwardMhz! - 2440) < 0.15);
  check("выдержка рамки заведена", L().attackTxUntil != null && L().attackTxUntil! > Date.now());
  check("таймер рамки гасит TX", await waitFor("hold end", () => L().lastForwardMhz == null && !L().transmitArmed, 1500));

  await new Promise((r) => setTimeout(r, ATTACK_COOLDOWN_MS + 30));
  L().stopScan();
  L().clearAttackPaint();
  L().disarmTxWave();
  L().startScan();
  check("скан без рамки", await waitFor("scan2", () => L().scanRunning));
  L().injectDemoTone();
  await L().startTransmit();
  check(
    "без рамки авто-handoff как в тесте гонок",
    await waitFor("no-paint handoff", () => L().lastForwardMhz != null),
  );
  await L().stopTransmit();
  L().stopScan();

  console.log(failures === 0 ? "\nHOST ATTACK: ALL PASS" : `\nHOST ATTACK: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
