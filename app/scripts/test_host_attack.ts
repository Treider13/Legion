// ============================================================================
// LEGION — тесты хост-Атаки. Не трогают FPGA / ESP32 / detectFromBins.
// Запуск: npx tsx scripts/test_host_attack.ts
// ============================================================================
import { caCfar1d, detectAttackHits, ATTACK_MIN_BW_MHZ, ATTACK_MAX_BW_MHZ } from "../src/sense/attackDetect";
import { AttackTracker, ATTACK_MIN_HITS, type AttackTrack } from "../src/sense/attackTracks";
import { atlasForTracks, classifyAttackFamily, bandBucket } from "../src/sense/attackAtlas";
import { stitchHopFamilies } from "../src/sense/attackFamily";
import { honestWidthMhz, measureHitWidths, occupied99Mhz, width26dbMhz, width3dbMhzAttack } from "../src/sense/attackMeasure";
import { buildAttackAdvice, waveClassOf, waveClassRu } from "../src/sense/attackAdvisor";
import { matchAttackLook } from "../src/sense/attackLook";
import { readAttackInfo, type AttackInfoSnap } from "../src/sense/attackInfo";
import { AttackSessionMemory } from "../src/sense/attackMemory";
import { buildAttackScene } from "../src/sense/attackScene";
import {
  ATTACK_FD_FS_HZ,
  ATTACK_FFT_N_FULL,
  ATTACK_LISTEN_ANALOG_MHZ,
  ATTACK_LISTEN_FS_HZ,
  attackCropFactor,
  attackListenPlan,
} from "../src/sense/attackListen";
import {
  ATTACK_COOLDOWN_MS,
  ATTACK_HOLD_MIN_MS,
  ATTACK_TX_MAX_MHZ,
  attackPaintOwnsTx,
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
import { cropPsdBins, detectFromBins, estimateNoiseFloor, hostPaintSpanMhz, hostScanSpanMhz, MockSdrBackend, SOAPY_CROP_FACTOR } from "../src/sdr/backend";
import { pickArmedAutoTarget, RESENSE_MS } from "../src/sense/hold";
import { useLegion } from "../src/state/store";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  check("хост FFT span чужих режимов 40", hostScanSpanMhz(56) === 40);
  check("soapy crop чужих режимов 0.5", SOAPY_CROP_FACTOR === 0.5);
  check("RESENSE_MS 1 с как был", RESENSE_MS === 1000);
  const storeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/state/store.ts"), "utf8");
  const resenseSrc = storeSrc.slice(storeSrc.indexOf("const resenseHeld"), storeSrc.indexOf("const armAttackHoldTimer"));
  check(
    "resense Атаки не зовёт DIO-40",
    resenseSrc.includes("hostAttackScan") && resenseSrc.includes("attackListenPlan"),
  );
  check(
    "тик скана сверяет gScanGen после await",
    storeSrc.includes("let gScanGen = 0") && storeSrc.includes("scanGen !== gScanGen"),
  );
  check(
    "слух Атаки — Thomson, чужой путь — Welch",
    storeSrc.includes("Thomson DPSS×3") && storeSrc.includes("Hann+Welch-8 overlap 0.5"),
  );
  check(
    "вычет после ПЕРЕДАТЬ не теряется если мозг занят",
    storeSrc.includes("gAttackThinkResidual") && storeSrc.includes("pend.centerMhz"),
  );
  check(
    "think после Старт сверяет поколение",
    storeSrc.includes("bumpAttackThinkGen") && storeSrc.includes("thinkGen !== gAttackThinkGen"),
  );
  const fireSrc = storeSrc.slice(storeSrc.indexOf("const fireAttackPaintTx"), storeSrc.indexOf("const startOpenLoopTx"));
  check(
    "рамка ПЕРЕДАТЬ всегда hostTxWave на часах рамки",
    fireSrc.includes("hostTxWave") &&
      fireSrc.includes('?? "sine"') &&
      !fireSrc.includes("hostTx(") &&
      !fireSrc.includes("txCue"),
  );
  check(
    "рамка ПЕРЕДАТЬ сначала слух на часах рамки (AD9361 один BBPLL)",
    fireSrc.includes("hostAttackScan") &&
      fireSrc.indexOf("hostAttackScan") < fireSrc.indexOf("hostTxWave") &&
      fireSrc.includes("paintOwnsTx: true"),
  );
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

  const walkedTr = new AttackTracker();
  const shelfHit = { freqMhz: 5800, fLowMhz: 5792, fHighMhz: 5808, widthMhz: 16, powerDbm: -30, noiseDbm: -90, snrDb: 60 };
  const lowHit = { freqMhz: 1280, fLowMhz: 1272, fHighMhz: 1288, widthMhz: 16, powerDbm: -20, noiseDbm: -90, snrDb: 70 };
  for (let i = 0; i < 4; i++) walkedTr.update([shelfHit], i + 1, { centerMhz: 5800, spanMhz: 56 });
  const shelfBorn = walkedTr.snapshot().find((t) => Math.abs(t.freqMhz - 5800) < 1)!;
  for (let i = 0; i < 12; i++) walkedTr.update([lowHit], 10 + i, { centerMhz: 1280, spanMhz: 56 });
  const shelfKept = walkedTr.snapshot().find((t) => t.id === shelfBorn.id);
  check(
    "уход окна не стирает полку и не сажает duty",
    shelfKept != null && shelfKept.state === "confirmed" && shelfKept.duty >= 0.7,
    shelfKept ? `state=${shelfKept.state} duty=${shelfKept.duty.toFixed(2)}` : "след пропал",
  );
  walkedTr.update([shelfHit], 30, { centerMhz: 5800, spanMhz: 56 });
  const shelfBack = walkedTr.snapshot().find((t) => Math.abs(t.freqMhz - 5800) < 1);
  check("возврат окна продолжает тот же след", shelfBack != null && shelfBack.id === shelfBorn.id && shelfBack.hits >= 5);
  for (let i = 0; i < 3; i++) walkedTr.update([], 40 + i, { centerMhz: 5800, spanMhz: 56 });
  check(
    "промах в том же окне по-прежнему остужает",
    walkedTr.snapshot().find((t) => t.id === shelfBorn.id)?.state === "cooled",
  );
  const ownTr = new AttackTracker();
  for (let i = 0; i < 4; i++) ownTr.update([shelfHit], i + 1, { centerMhz: 5800, spanMhz: 40 });
  const ownId = ownTr.snapshot()[0]!.id;
  for (let i = 0; i < 15; i++) {
    ownTr.update([], 10 + i, { centerMhz: 5800, spanMhz: 40, hidden: (mhz) => mhz >= 5790 && mhz <= 5810 });
  }
  const ownKept = ownTr.snapshot().find((t) => t.id === ownId);
  check(
    "свой TX не остужает след в рамке",
    ownKept != null && ownKept.state !== "cooled",
    ownKept ? ownKept.state : "след пропал",
  );
  const staleTr = new AttackTracker();
  staleTr.update([shelfHit], 1, { centerMhz: 5800, spanMhz: 56 });
  const quiet = { freqMhz: 915, fLowMhz: 914.7, fHighMhz: 915.3, widthMhz: 0.6, powerDbm: -50, noiseDbm: -90, snrDb: 40 };
  for (let i = 0; i < 6; i++) staleTr.update([quiet], 2 + i, { centerMhz: 915, spanMhz: 56 });
  const staleAdvice = buildAttackAdvice({
    tracks: staleTr.snapshot(),
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 800, f2Mhz: 1000 }, { f1Mhz: 5600, f2Mhz: 5900 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  const staleMid = staleAdvice.suggestPaint
    ? (staleAdvice.suggestPaint.f1Mhz + staleAdvice.suggestPaint.f2Mhz) / 2
    : Number.NaN;
  check(
    "старая вспышка не забирает рамку у сигнала в окне",
    Math.abs(staleMid - 915) < 2,
    `mid=${staleMid.toFixed(2)}`,
  );
  const flashGone = new AttackTracker();
  flashGone.update(
    [{ freqMhz: 2440, fLowMhz: 2439.7, fHighMhz: 2440.3, widthMhz: 0.6, powerDbm: -18, noiseDbm: -90, snrDb: 72 }],
    1,
    { centerMhz: 2440, spanMhz: 56 },
  );
  for (let i = 0; i < 12; i++) flashGone.update([], 2 + i, { centerMhz: 5800, spanMhz: 56 });
  const goneAdvice = buildAttackAdvice({
    tracks: flashGone.snapshot(),
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }, { f1Mhz: 5600, f2Mhz: 5900 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    sweep: flashGone.currentSweep(),
  });
  check(
    "пустые обходы гасят рамку одиночной вспышки",
    goneAdvice.suggestPaint == null,
    `mid=${goneAdvice.suggestPaint ? ((goneAdvice.suggestPaint.f1Mhz + goneAdvice.suggestPaint.f2Mhz) / 2).toFixed(2) : "нет"}`,
  );
  const flashSeen = new AttackTracker();
  const flash = { freqMhz: 2440, fLowMhz: 2439.7, fHighMhz: 2440.3, widthMhz: 0.6, powerDbm: -18, noiseDbm: -90, snrDb: 72 };
  flashSeen.update([flash], 1, { centerMhz: 2440, spanMhz: 56 });
  const fresh = buildAttackAdvice({
    tracks: flashSeen.snapshot(),
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    sweep: flashSeen.currentSweep(),
  });
  const freshMid = fresh.suggestPaint ? (fresh.suggestPaint.f1Mhz + fresh.suggestPaint.f2Mhz) / 2 : Number.NaN;
  check("вспышка этого обхода остаётся рамкой", Math.abs(freshMid - 2440) < 2, `mid=${freshMid.toFixed(2)}`);
  flashSeen.update([], 2, { centerMhz: 2440, spanMhz: 56 });
  flashSeen.update([], 3, { centerMhz: 2440, spanMhz: 56 });
  const flashMissedAdvice = buildAttackAdvice({
    tracks: flashSeen.snapshot(),
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    sweep: flashSeen.currentSweep(),
  });
  check("промах в том же окне не держит рамку вспышки", flashMissedAdvice.suggestPaint == null);

  check("2.4 12 МГц sticky — цифровой класс", classifyAttackFamily({
    freqMhz: 2442, widthMhz: 12, duty: 0.85, streak: 8,
  }).id === "digital-video");
  check("5.8 8 МГц sticky — аналог", classifyAttackFamily({
    freqMhz: 5800, widthMhz: 8, duty: 0.9, streak: 10,
  }).id === "analog-video");
  check("5.8 12 МГц sticky — цифра, не аналог", classifyAttackFamily({
    freqMhz: 5800, widthMhz: 12, duty: 0.9, streak: 10,
  }).id === "digital-video");
  check("5.8 30 МГц sticky — широко", classifyAttackFamily({
    freqMhz: 5800, widthMhz: 30, duty: 0.9, streak: 10,
  }).id === "digital-wide");
  check("5.8 40 МГц sticky — широко", classifyAttackFamily({
    freqMhz: 5794.5, widthMhz: 40, duty: 0.92, streak: 12,
  }).id === "digital-wide");
  check("5.1 20 МГц — цифра в c51", classifyAttackFamily({
    freqMhz: 5180, widthMhz: 20, duty: 0.88, streak: 9,
  }).id === "digital-video" && bandBucket(5180) === "c51");
  check("заполнил окно 56", classifyAttackFamily({
    freqMhz: 5800, widthMhz: 54, duty: 0.95, streak: 12,
  }, 56).id === "window-fill");
  check("915 узкий — 900-класс", classifyAttackFamily({
    freqMhz: 915, widthMhz: 0.5, duty: 0.2, streak: 1,
  }).id === "rc-900");
  check("корзина 5.8", bandBucket(5805) === "c58");
  check("корзина 169", bandBucket(169) === "vhf");
  check("корзина 470", bandBucket(470) === "uhf");
  check("2.4 hop ≤2 — rc-24", classifyAttackFamily({
    freqMhz: 2442, widthMhz: 0.8, duty: 0.2, streak: 1,
  }).id === "rc-24");
  check("5.8 hop 10 — вспышки, не липкое видео", classifyAttackFamily({
    freqMhz: 5800, widthMhz: 10, duty: 0.2, streak: 1,
  }).id === "digital-burst");
  const floors = atlasForTracks([
    {
      id: 1, freqMhz: 5800, fLowMhz: 5785, fHighMhz: 5815, widthMhz: 30,
      powerDbm: -20, noiseDbm: -90, snrDb: 70, hits: 8, streak: 8, maxStreak: 8,
      firstSweep: 1, lastSweep: 8, gap: 0, duty: 0.9, state: "confirmed", lastSeenTs: 1,
    },
    {
      id: 2, freqMhz: 5760, fLowMhz: 5759.6, fHighMhz: 5760.4, widthMhz: 0.8,
      powerDbm: -40, noiseDbm: -90, snrDb: 50, hits: 3, streak: 1, maxStreak: 2,
      firstSweep: 6, lastSweep: 8, gap: 0, duty: 0.2, state: "confirmed", lastSeenTs: 1,
    },
  ]);
  check("два этажа в одной корзине", floors.every((t) => t.atlas.id === "two-floor"));

  const listen = attackListenPlan({ analogMhz: 56, paintOwnsTx: false, paint: null });
  check("слух xA4 fs 61.44", listen.fsHz === ATTACK_LISTEN_FS_HZ);
  check("слух фильтр 56", listen.filterMhz === ATTACK_LISTEN_ANALOG_MHZ);
  check("слух окно 56", Math.abs(listen.spanMhz - 56) < 0.05);
  check("слух FFT 8192", listen.fftN === ATTACK_FFT_N_FULL);
  check(
    "crop 61.44/56 = неиспользуемый Nyquist",
    Math.abs(attackCropFactor(ATTACK_LISTEN_FS_HZ, 56) - (1 - 56 / 61.44)) < 1e-6,
  );
  const fd = attackListenPlan({
    analogMhz: 56,
    paintOwnsTx: true,
    paint: { f1Mhz: 2430, f2Mhz: 2450 },
  });
  check("ПЕРЕДАТЬ 20 МГц не раздувает USB до 61.44", fd.fsHz === 20e6 && fd.fsHz <= ATTACK_FD_FS_HZ);
  const x40 = attackListenPlan({ analogMhz: 28, paintOwnsTx: false, paint: null });
  check("x40 слух не 61.44", x40.fsHz === 28e6 && x40.filterMhz === 28);
  check("потолок хита не 22", ATTACK_MAX_BW_MHZ === 56);

  function brickBins(center: number, span: number, n: number, lo: number, hi: number, dbm: number) {
    const out = [];
    for (let i = 0; i < n; i++) {
      const f = center - span / 2 + (span * i) / (n - 1);
      out.push({ freqMhz: f, powerDbm: f >= lo && f <= hi ? dbm : -92 });
    }
    return out;
  }
  const brick20 = brickBins(2442, 40, 400, 2432, 2452, -20);
  check("−3 дБ на кирпиче ~20", Math.abs(width3dbMhzAttack(brick20, 2442) - 20) < 1.5);
  check("−26 дБ не уже −3", width26dbMhz(brick20, 2442) + 1e-9 >= width3dbMhzAttack(brick20, 2442) - 0.2);
  check("99% на кирпиче живая", occupied99Mhz(brick20, 2442) > 10);
  check(
    "99% на кирпиче ~20 по SM.443",
    occupied99Mhz(brick20, 2442) > 15 && occupied99Mhz(brick20, 2442) < 26,
    `occ=${occupied99Mhz(brick20, 2442).toFixed(2)}`,
  );
  const weakNarrow = brickBins(915, 56, 800, 914.75, 915.25, -70);
  const weakW = measureHitWidths(weakNarrow, 915);
  check(
    "−26 дБ в шуме не раздувает узкий сигнал до окна",
    weakW.width26Mhz < 0.15 && weakW.width3Mhz > 0.2 && weakW.width3Mhz < 2 && honestWidthMhz(weakW, 0.5) < 2,
    `w3=${weakW.width3Mhz.toFixed(2)} w26=${weakW.width26Mhz.toFixed(2)} occ=${weakW.occ99Mhz.toFixed(2)}`,
  );
  const clearNarrow = brickBins(915, 56, 800, 914.75, 915.25, -40);
  const clearW = measureHitWidths(clearNarrow, 915);
  check(
    "−26 дБ выше пола остаётся шириной сигнала",
    clearW.width26Mhz > 0.2 && clearW.width26Mhz < 2,
    `w26=${clearW.width26Mhz.toFixed(2)}`,
  );

  const hopTracks = [2440, 2441, 2442].map((mhz, i) => ({
    id: i + 1,
    freqMhz: mhz,
    fLowMhz: mhz - 0.4,
    fHighMhz: mhz + 0.4,
    widthMhz: 0.8,
    powerDbm: -35,
    noiseDbm: -90,
    snrDb: 55,
    hits: 3,
    streak: 1,
    maxStreak: 2,
    firstSweep: 1,
    lastSweep: 4,
    gap: 0,
    duty: 0.2,
    state: "confirmed" as const,
    lastSeenTs: 1,
  }));
  const fams = stitchHopFamilies(hopTracks, [2439, 2443]);
  check("семья hop склеивает сетку 1 МГц", fams.length >= 1 && Math.abs((fams[0]?.gridMhz ?? 0) - 1) < 0.3);
  check("семья шире одной вспышки", (fams[0]?.fHighMhz ?? 0) - (fams[0]?.fLowMhz ?? 0) > 2);
  const hopMem = new AttackSessionMemory();
  hopMem.noteHops(hopTracks, 1);
  hopMem.noteHops(hopTracks, 2);
  hopMem.noteHops(hopTracks, 3);
  check("память hop не дублирует каждый тик", hopMem.hops.length === hopTracks.length);
  hopMem.noteHops(
    [{ ...hopTracks[0]!, freqMhz: 2444, fLowMhz: 2443.6, fHighMhz: 2444.4 }],
    4,
  );
  check("память hop пишет новый канал того же следа", hopMem.hops.length === hopTracks.length + 1);
  const lookPeers = [
    { id: 1, freqMhz: 2440 },
    { id: 2, freqMhz: 2440.3 },
  ];
  check(
    "разбор IQ садится на свой след, не на соседний",
    matchAttackLook(lookPeers, 2440.3)?.id === 2 && matchAttackLook(lookPeers, 2440)?.id === 1,
  );
  check("разбор дальше ворот трекера никому не пишется", matchAttackLook(lookPeers, 2441) == null);
  hopMem.noteLook(1, {
    freqMhz: 2440,
    kind: "tone",
    label: "похоже на тон",
    conf: 0.8,
    flatness: 0.1,
    cepstrum: 0,
    famCoh: 0,
    famAlphaHz: 0,
    c20: 0,
    kurt: 0,
    clip: false,
    leftover: null,
    source: "iq",
  });
  hopMem.noteScene(1, hopTracks);
  hopMem.noteScene(2, hopTracks);
  check("карточка не пишет замер эфира", hopMem.powerSnaps().length === 0 && hopMem.scenes.length === 1);
  const atSweep = (sweep: number) => hopTracks.map((t) => ({ ...t, lastSweep: sweep }));
  hopMem.notePowers(10, atSweep(1), 1, 2441, 56);
  hopMem.notePowers(11, atSweep(1), 1, 2441, 56);
  check("повтор того же обхода не второй замер", hopMem.powerSnaps().length === 1);
  hopMem.notePowers(12, atSweep(2), 2, 2441, 56);
  check("следующий обход пишет замер", hopMem.powerSnaps().length === 2);
  hopMem.notePowers(13, hopTracks.map((t, i) => ({ ...t, lastSweep: i === 0 ? 3 : 1 })), 3, hopTracks[0]!.freqMhz, 1);
  const freshOnly = hopMem.powerSnaps().at(-1)!;
  check(
    "замер берёт свежий хит, не старую мощность",
    freshOnly.rows.length === 1 && freshOnly.rows[0]!.id === hopTracks[0]!.id && freshOnly.rows[0]!.measured === true,
  );
  hopMem.notePowers(14, atSweep(1), 4, 2441, 56);
  const missed = hopMem.powerSnaps().at(-1)!;
  check(
    "взгляд в окно без хита — промах, не повтор мощности",
    missed.rows.length === hopTracks.length && missed.rows.every((r) => r.measured === false),
  );
  hopMem.forgetLooks();
  check("старт скана забывает разбор старых id", hopMem.looks.size === 0);
  check("старт скана забывает ряд мощности", hopMem.powerSnaps().length === 0);
  check("старт скана не трёт hop-память", hopMem.hops.length === hopTracks.length + 1);

  const sticky = [{
    id: 1, freqMhz: 2442, fLowMhz: 2432, fHighMhz: 2452, widthMhz: 20,
    powerDbm: -18, noiseDbm: -90, snrDb: 72, hits: 10, streak: 10, maxStreak: 10,
    firstSweep: 1, lastSweep: 10, gap: 0, duty: 0.9, state: "confirmed" as const, lastSeenTs: 1,
  }];
  const advice = buildAttackAdvice({
    tracks: sticky,
    families: [],
    widths: new Map([[1, { width3Mhz: 19.5, width26Mhz: 20.2, occ99Mhz: 20.0 }]]),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check("тон против 20 МГц — спор", advice.hints.some((h) => h.kind === "wave" && h.wave === "awgn"));
  check("рамка предлагается, не ставится", advice.suggestPaint != null && advice.hints.some((h) => h.kind === "paint" && h.paint != null));
  const adviceOut = buildAttackAdvice({
    tracks: sticky,
    families: [],
    widths: new Map([[1, { width3Mhz: 19.5, width26Mhz: 20.2, occ99Mhz: 20.0 }]]),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 5100, f2Mhz: 5200 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check(
    "рамка вне коридора не предлагается взять",
    !adviceOut.hints.some((h) => h.kind === "paint" && h.paint != null && h.applyLabel != null),
  );
  check("одна полка — информация, не досье", advice.scene.includes("Информация") && advice.scene.includes("борт") && !advice.scene.includes("досье"));
  check("помощник не пишет советник", !advice.scene.includes("советник"));

  function track(part: Partial<AttackTrack> & Pick<AttackTrack, "id" | "freqMhz">): AttackTrack {
    return {
      fLowMhz: part.freqMhz - (part.widthMhz ?? 0.8) / 2,
      fHighMhz: part.freqMhz + (part.widthMhz ?? 0.8) / 2,
      widthMhz: 0.8,
      powerDbm: -40,
      noiseDbm: -90,
      snrDb: 50,
      hits: 6,
      streak: 2,
      maxStreak: 4,
      firstSweep: 1,
      lastSweep: 8,
      gap: 0,
      duty: 0.3,
      state: "confirmed",
      lastSeenTs: 1,
      ...part,
    };
  }
  function powerSnaps(
    series: Array<Array<{ id: number; freqMhz: number; powerDbm: number; widthMhz: number; duty: number; firstSweep?: number; measured?: boolean }>>,
  ): AttackInfoSnap[] {
    return series.map((rows, i) => ({
      ts: i + 1,
      rows: rows.map((r) => ({
        firstSweep: r.firstSweep ?? 1,
        state: "confirmed" as const,
        ...r,
      })),
    }));
  }
  function mid(p: { f1Mhz: number; f2Mhz: number } | null): number {
    return p ? (p.f1Mhz + p.f2Mhz) / 2 : Number.NaN;
  }
  const wideBands = [
    { f1Mhz: 800, f2Mhz: 1000 },
    { f1Mhz: 1100, f2Mhz: 1400 },
    { f1Mhz: 2400, f2Mhz: 2500 },
    { f1Mhz: 5600, f2Mhz: 5900 },
  ];
  const room = track({ id: 1, freqMhz: 2412, widthMhz: 0.4, duty: 0.95, powerDbm: -20, streak: 8, firstSweep: 1 });
  const board = track({ id: 2, freqMhz: 5800, widthMhz: 12, duty: 0.9, powerDbm: -48, streak: 6, firstSweep: 8 });
  const roomSnaps = powerSnaps([
    [{ id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 }],
    [{ id: 1, freqMhz: 2412, powerDbm: -20.2, widthMhz: 0.4, duty: 0.95, firstSweep: 1 }],
    [{ id: 1, freqMhz: 2412, powerDbm: -19.8, widthMhz: 0.4, duty: 0.95, firstSweep: 1 }],
    [{ id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 }],
    [{ id: 1, freqMhz: 2412, powerDbm: -20.1, widthMhz: 0.4, duty: 0.95, firstSweep: 1 }],
    [{ id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 }, { id: 2, freqMhz: 5800, powerDbm: -48, widthMhz: 12, duty: 0.9, firstSweep: 8 }],
  ]);
  const roomAdvice = buildAttackAdvice({
    tracks: [room, board],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    snaps: roomSnaps,
  });
  check(
    "фон не забирает рамку у борта",
    roomAdvice.suggestPaint != null && Math.abs(mid(roomAdvice.suggestPaint) - 5800) < 2,
    `mid=${mid(roomAdvice.suggestPaint).toFixed(2)}`,
  );
  check("фон назван информацией", roomAdvice.scene.includes("фон") && roomAdvice.scene.includes("Информация"));

  const hand = track({ id: 3, freqMhz: 915, widthMhz: 0.5, duty: 0.2, powerDbm: -55, streak: 1, firstSweep: 2 });
  const shadowSnaps = powerSnaps([
    [
      { id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9, firstSweep: 1 },
      { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2, firstSweep: 2 },
      { id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 },
    ],
    [
      { id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9, firstSweep: 1 },
      { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2, firstSweep: 2 },
      { id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 },
    ],
    [
      { id: 4, freqMhz: 5800, powerDbm: -31, widthMhz: 20, duty: 0.9, firstSweep: 1 },
      { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2, firstSweep: 2 },
      { id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 },
    ],
    [
      { id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9, firstSweep: 1 },
      { id: 3, freqMhz: 915, powerDbm: -54, widthMhz: 0.5, duty: 0.2, firstSweep: 2 },
      { id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 },
    ],
    [
      { id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9, firstSweep: 1, measured: false },
      { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2, firstSweep: 2 },
      { id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 },
    ],
    [
      { id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9, firstSweep: 1, measured: false },
      { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2, firstSweep: 2 },
      { id: 1, freqMhz: 2412, powerDbm: -20, widthMhz: 0.4, duty: 0.95, firstSweep: 1 },
    ],
  ]);
  const shadowAdvice = buildAttackAdvice({
    tracks: [room, hand],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    snaps: shadowSnaps,
  });
  check(
    "тень держит живой узкий голос, не фон",
    shadowAdvice.suggestPaint != null && Math.abs(mid(shadowAdvice.suggestPaint) - 915) < 2,
    `mid=${mid(shadowAdvice.suggestPaint).toFixed(2)}`,
  );
  check("тень в информации", shadowAdvice.scene.includes("тень") && shadowAdvice.scene.includes("Информация"));
  check(
    "тень не растягивает рамку на весь эфир",
    shadowAdvice.suggestPaint != null && paintSpanMhz(shadowAdvice.suggestPaint) < 20,
  );
  const walkedAway = powerSnaps([
    [{ id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9 }],
    [{ id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9 }],
    [{ id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9 }],
    [{ id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9 }],
    [{ id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2 }],
    [{ id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2 }],
  ]);
  const walked = readAttackInfo({ tracks: [room, hand], snaps: walkedAway });
  check("уход окна с полки — не тень", !walked.line.includes("тень"));
  const shortDrop = readAttackInfo({
    tracks: [
      track({ id: 4, freqMhz: 5800, widthMhz: 20, duty: 0.9, powerDbm: -50, streak: 6 }),
      hand,
    ],
    snaps: powerSnaps([
      [
        { id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9 },
        { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2 },
      ],
      [
        { id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9 },
        { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2 },
      ],
      [
        { id: 4, freqMhz: 5800, powerDbm: -30, widthMhz: 20, duty: 0.9 },
        { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2 },
      ],
      [
        { id: 4, freqMhz: 5800, powerDbm: -50, widthMhz: 20, duty: 0.9 },
        { id: 3, freqMhz: 915, powerDbm: -55, widthMhz: 0.5, duty: 0.2 },
      ],
    ]),
  });
  check("посадка полки на 20 дБ за четыре взгляда — тень", shortDrop.line.includes("тень"), shortDrop.line);

  // Живой трекер: 915 и 5800 не бывают в одном окне. Duty пульта остаётся 1,
  // полка садится на 20 дБ. Раньше preferWide отдавал рамку севшей полке.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    const narrow = (p: number) => ({
      freqMhz: 915, fLowMhz: 914.75, fHighMhz: 915.25, widthMhz: 0.5, powerDbm: p, noiseDbm: -90, snrDb: p + 90,
    });
    const shelf = (p: number) => ({
      freqMhz: 5800, fLowMhz: 5790, fHighMhz: 5810, widthMhz: 20, powerDbm: p, noiseDbm: -90, snrDb: p + 90,
    });
    let ts = 1000;
    const videoP = [-30, -30, -30, -50];
    for (let i = 0; i < 4; i++) {
      const snap = tr.update([narrow(-40)], ts, { centerMhz: 915, spanMhz: 56 });
      mem.notePowers(ts, snap, tr.currentSweep(), 915, 56);
      ts += 100;
      const seen = tr.update([shelf(videoP[i]!)], ts, { centerMhz: 5800, spanMhz: 56 });
      mem.notePowers(ts, seen, tr.currentSweep(), 5800, 56);
      ts += 100;
    }
    const held = buildAttackAdvice({
      tracks: tr.snapshot(),
      families: [],
      widths: new Map(),
      looks: new Map(),
      windowMhz: 56,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: wideBands,
      residual: null,
      memory: mem.stats(),
      transmitArmed: false,
      snaps: mem.powerSnaps(),
      sweep: tr.currentSweep(),
    });
    const heldMid = mid(held.suggestPaint);
    check(
      "ровный пульт не отдаёт рамку севшей полке",
      Math.abs(heldMid - 915) < 2 && held.scene.includes("тень") && held.scene.includes("пульт") && !held.scene.includes("фон"),
      `mid=${heldMid.toFixed(2)} ${held.scene}`,
    );
  }
  // Тот же обход, но пульт ни разу не попал дважды подряд — след остаётся new.
  // Последний взгляд на 5.8. Раньше такой след выкидывался из кадра вместе с тенью.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    const narrow = (p: number) => ({
      freqMhz: 915, fLowMhz: 914.75, fHighMhz: 915.25, widthMhz: 0.5, powerDbm: p, noiseDbm: -90, snrDb: p + 90,
    });
    const shelf = (p: number) => ({
      freqMhz: 5800, fLowMhz: 5790, fHighMhz: 5810, widthMhz: 20, powerDbm: p, noiseDbm: -90, snrDb: p + 90,
    });
    let ts = 1000;
    const videoP = [-30, -30, -30, -50];
    const steps: Array<"hit" | "miss"> = ["hit", "miss", "hit", "miss", "hit", "miss", "hit"];
    let vi = 0;
    for (let i = 0; i < steps.length; i++) {
      const hits = steps[i] === "hit" ? [narrow(-40)] : [];
      const snap = tr.update(hits, ts, { centerMhz: 915, spanMhz: 56 });
      mem.notePowers(ts, snap, tr.currentSweep(), 915, 56);
      ts += 100;
      if (i >= steps.length - videoP.length) {
        const seen = tr.update([shelf(videoP[vi]!)], ts, { centerMhz: 5800, spanMhz: 56 });
        mem.notePowers(ts, seen, tr.currentSweep(), 5800, 56);
        vi += 1;
        ts += 100;
      }
    }
    const hop = tr.snapshot().find((t) => Math.abs(t.freqMhz - 915) < 1);
    const hopped = buildAttackAdvice({
      tracks: tr.snapshot(),
      families: [],
      widths: new Map(),
      looks: new Map(),
      windowMhz: 56,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: wideBands,
      residual: null,
      memory: mem.stats(),
      transmitArmed: false,
      snaps: mem.powerSnaps(),
      sweep: tr.currentSweep(),
    });
    const hopMid = mid(hopped.suggestPaint);
    check(
      "мигающий пульт другого окна держит тень",
      hop != null && hop.state === "new" && hop.lastSweep !== tr.currentSweep() && Math.abs(hopMid - 915) < 2 && hopped.scene.includes("тень"),
      `state=${hop?.state} last=${hop?.lastSweep} sweep=${tr.currentSweep()} mid=${hopMid.toFixed(2)} ${hopped.scene}`,
    );
  }
  // Сначала долго видим только 915, потом полка. firstSweep полки далеко:
  // раньше ровный пульт становился «фоном», рамка уходила на севшую 5.8.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    const narrow = (p: number) => ({
      freqMhz: 915, fLowMhz: 914.75, fHighMhz: 915.25, widthMhz: 0.5, powerDbm: p, noiseDbm: -90, snrDb: p + 90,
    });
    const shelf = (p: number) => ({
      freqMhz: 5800, fLowMhz: 5790, fHighMhz: 5810, widthMhz: 20, powerDbm: p, noiseDbm: -90, snrDb: p + 90,
    });
    let ts = 1000;
    for (let i = 0; i < 4; i++) {
      const snap = tr.update([narrow(-40)], ts, { centerMhz: 915, spanMhz: 56 });
      mem.notePowers(ts, snap, tr.currentSweep(), 915, 56);
      ts += 100;
    }
    for (let i = 0; i < 8; i++) {
      const snap = tr.update([], ts, { centerMhz: 2000, spanMhz: 56 });
      mem.notePowers(ts, snap, tr.currentSweep(), 2000, 56);
      ts += 100;
    }
    const videoP = [-30, -30, -30, -50];
    for (let i = 0; i < videoP.length; i++) {
      const back = tr.update([narrow(-40)], ts, { centerMhz: 915, spanMhz: 56 });
      mem.notePowers(ts, back, tr.currentSweep(), 915, 56);
      ts += 100;
      const seen = tr.update([shelf(videoP[i]!)], ts, { centerMhz: 5800, spanMhz: 56 });
      mem.notePowers(ts, seen, tr.currentSweep(), 5800, 56);
      ts += 100;
    }
    const late = buildAttackAdvice({
      tracks: tr.snapshot(),
      families: [],
      widths: new Map(),
      looks: new Map(),
      windowMhz: 56,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: wideBands,
      residual: null,
      memory: mem.stats(),
      transmitArmed: false,
      snaps: mem.powerSnaps(),
      sweep: tr.currentSweep(),
    });
    const lateMid = mid(late.suggestPaint);
    check(
      "поздняя полка не делает живой пульт фоном",
      Math.abs(lateMid - 915) < 2 && late.scene.includes("тень") && late.scene.includes("пульт") && !late.scene.includes("фон"),
      `mid=${lateMid.toFixed(2)} ${late.scene}`,
    );
  }
  // Канал меняется каждый взгляд. Семья уже есть, но свежий удар duty 1 в неё не входил,
  // и после посадки 5.8 рамка оставалась на полке: у одного id нет четырёх точек.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    let ts = 1000;
    const videoP = [-30, -30, -30, -50];
    for (let i = 0; i < 8; i++) {
      const hop = {
        freqMhz: 900 + i, fLowMhz: 900 + i - 0.3, fHighMhz: 900 + i + 0.3,
        widthMhz: 0.6, powerDbm: -40, noiseDbm: -90, snrDb: 50,
      };
      const snap = tr.update([hop], ts, { centerMhz: 915, spanMhz: 56 });
      mem.notePowers(ts, snap, tr.currentSweep(), 915, 56);
      mem.noteHops(snap, ts);
      ts += 100;
      if (i >= 4) {
        const shelf = {
          freqMhz: 5800, fLowMhz: 5790, fHighMhz: 5810,
          widthMhz: 20, powerDbm: videoP[i - 4]!, noiseDbm: -90, snrDb: 40,
        };
        const seen = tr.update([shelf], ts, { centerMhz: 5800, spanMhz: 56 });
        mem.notePowers(ts, seen, tr.currentSweep(), 5800, 56);
        mem.noteHops(seen, ts);
        ts += 100;
      }
    }
    const hopped = buildAttackScene({
      tracks: tr.snapshot(),
      bins: [],
      windowMhz: 56,
      memory: mem,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: wideBands,
      transmitArmed: false,
      sweep: tr.currentSweep(),
    });
    const hopMid = mid(hopped.advice.suggestPaint);
    const hopSpan = hopped.advice.suggestPaint ? paintSpanMhz(hopped.advice.suggestPaint) : 0;
    check(
      "hop-сетка держит тень, не севшая полка",
      hopSpan > 2 && hopMid > 890 && hopMid < 920 && hopped.advice.scene.includes("тень") && hopped.advice.scene.includes("уже виденные"),
      `mid=${hopMid.toFixed(2)} span=${hopSpan.toFixed(2)} ${hopped.advice.scene}`,
    );
  }
  // Маяк 2412 громче ровного 915. Оба duty 1. Тень — пульт 915, не маяк.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    let ts = 1000;
    const videoP = [-30, -30, -30, -50];
    for (let i = 0; i < 4; i++) {
      const a = tr.update(
        [{ freqMhz: 915, fLowMhz: 914.75, fHighMhz: 915.25, widthMhz: 0.5, powerDbm: -40, noiseDbm: -90, snrDb: 50 }],
        ts, { centerMhz: 915, spanMhz: 56 },
      );
      mem.notePowers(ts, a, tr.currentSweep(), 915, 56);
      ts += 100;
      const b = tr.update(
        [{ freqMhz: 2412, fLowMhz: 2411.8, fHighMhz: 2412.2, widthMhz: 0.4, powerDbm: -20, noiseDbm: -90, snrDb: 70 }],
        ts, { centerMhz: 2412, spanMhz: 56 },
      );
      mem.notePowers(ts, b, tr.currentSweep(), 2412, 56);
      ts += 100;
      const c = tr.update(
        [{ freqMhz: 5800, fLowMhz: 5790, fHighMhz: 5810, widthMhz: 20, powerDbm: videoP[i]!, noiseDbm: -90, snrDb: 40 }],
        ts, { centerMhz: 5800, spanMhz: 56 },
      );
      mem.notePowers(ts, c, tr.currentSweep(), 5800, 56);
      ts += 100;
    }
    const beacon = buildAttackScene({
      tracks: tr.snapshot(),
      bins: [],
      windowMhz: 56,
      memory: mem,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: wideBands,
      transmitArmed: false,
      sweep: tr.currentSweep(),
    });
    const beaconMid = mid(beacon.advice.suggestPaint);
    check(
      "громкий маяк 2.4 не забирает тень у 915",
      Math.abs(beaconMid - 915) < 2 && beacon.advice.scene.includes("пульт") && beacon.advice.scene.includes("915"),
      `mid=${beaconMid.toFixed(2)} ${beacon.advice.scene}`,
    );
  }
  // Окно уже на 5.8. Ближний бин этого спектра — не ширина пульта 915.
  // Раньше кнопка была 895…935 МГц: 56 МГц чужого окна, обрезанные рукой 40.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    let ts = 1000;
    const videoP = [-30, -30, -30, -50];
    for (let i = 0; i < 4; i++) {
      const a = tr.update(
        [{ freqMhz: 915, fLowMhz: 914.75, fHighMhz: 915.25, widthMhz: 0.5, powerDbm: -40, noiseDbm: -90, snrDb: 50 }],
        ts, { centerMhz: 915, spanMhz: 56 },
      );
      mem.notePowers(ts, a, tr.currentSweep(), 915, 56);
      ts += 100;
      const c = tr.update(
        [{ freqMhz: 5800, fLowMhz: 5790, fHighMhz: 5810, widthMhz: 20, powerDbm: videoP[i]!, noiseDbm: -90, snrDb: 40 }],
        ts, { centerMhz: 5800, spanMhz: 56 },
      );
      mem.notePowers(ts, c, tr.currentSweep(), 5800, 56);
      ts += 100;
    }
    const bins5800 = [];
    for (let i = 0; i < 400; i++) {
      const f = 5800 - 28 + (56 * i) / 399;
      bins5800.push({ freqMhz: f, powerDbm: f >= 5790 && f <= 5810 ? -30 : -92 });
    }
    const foreign = buildAttackScene({
      tracks: tr.snapshot(),
      bins: bins5800,
      windowMhz: 56,
      memory: mem,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: wideBands,
      transmitArmed: false,
      sweep: tr.currentSweep(),
    });
    const fp = foreign.advice.suggestPaint;
    const hand = foreign.rows.find((r) => Math.abs(r.freqMhz - 915) < 1);
    const board = foreign.rows.find((r) => Math.abs(r.freqMhz - 5800) < 1);
    check(
      "чужое окно не раздаёт пульту ширину полки",
      fp != null && 915 >= fp.f1Mhz && 915 <= fp.f2Mhz && paintSpanMhz(fp) < 2
        && hand != null && hand.width26Mhz < 2
        && board != null && board.width26Mhz > 10
        && foreign.advice.scene.includes("тень"),
      fp && hand && board
        ? `paint ${fp.f1Mhz.toFixed(2)}…${fp.f2Mhz.toFixed(2)} hand26=${hand.width26Mhz.toFixed(2)} board26=${board.width26Mhz.toFixed(2)}`
        : "нет рамки",
    );
  }
  // Семья 2400…2479 шире руки 40 МГц. Срез от низа оставлял кнопку на 2400…2440,
  // канал 2479 в неё не входил.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    let ts = 1000;
    for (let f = 2400; f <= 2479; f++) {
      const snap = tr.update(
        [{ freqMhz: f, fLowMhz: f - 0.3, fHighMhz: f + 0.3, widthMhz: 0.6, powerDbm: -40, noiseDbm: -90, snrDb: 50 }],
        ts,
        { centerMhz: f, spanMhz: 56 },
      );
      mem.notePowers(ts, snap, tr.currentSweep(), f, 56);
      mem.noteHops(snap, ts);
      ts += 20;
    }
    const wideHop = buildAttackScene({
      tracks: tr.snapshot(),
      bins: [],
      windowMhz: 56,
      memory: mem,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
      transmitArmed: false,
      sweep: tr.currentSweep(),
    });
    const hp = wideHop.advice.suggestPaint;
    check(
      "широкая сетка hop держит текущий канал",
      hp != null && 2479 >= hp.f1Mhz && 2479 <= hp.f2Mhz && paintSpanMhz(hp) <= ATTACK_TX_MAX_MHZ + 1e-6 && hp.f1Mhz > 2420,
      hp ? `${hp.f1Mhz.toFixed(2)}…${hp.f2Mhz.toFixed(2)}` : "нет рамки",
    );
  }
  // Маяк duty 1 на каждом взгляде в 2 МГц от края сетки. Это не свежая вспышка:
  // кнопка должна обвести маяк, а не всю семью hop.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    const hops = [2405, 2406, 2407];
    let ts = 1000;
    for (let i = 0; i < 12; i++) {
      const f = hops[i % hops.length]!;
      const snap = tr.update(
        [
          { freqMhz: f, fLowMhz: f - 0.3, fHighMhz: f + 0.3, widthMhz: 0.6, powerDbm: -45, noiseDbm: -90, snrDb: 45 },
          { freqMhz: 2409, fLowMhz: 2408.8, fHighMhz: 2409.2, widthMhz: 0.4, powerDbm: -20, noiseDbm: -90, snrDb: 70 },
        ],
        ts,
        { centerMhz: 2407, spanMhz: 56 },
      );
      mem.notePowers(ts, snap, tr.currentSweep(), 2407, 56);
      mem.noteHops(snap, ts);
      ts += 20;
    }
    const stuck = buildAttackScene({
      tracks: tr.snapshot(),
      bins: [],
      windowMhz: 56,
      memory: mem,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
      transmitArmed: false,
      sweep: tr.currentSweep(),
    });
    const sp = stuck.advice.suggestPaint;
    const beaconIn = sp != null && 2409 >= sp.f1Mhz && 2409 <= sp.f2Mhz;
    const famHi = stuck.families.reduce((m, f) => Math.max(m, f.fHighMhz), 0);
    check(
      "липкий маяк не входит в семью hop",
      beaconIn && sp != null && paintSpanMhz(sp) < 2 && famHi < 2408.5,
      sp ? `paint ${sp.f1Mhz.toFixed(2)}…${sp.f2Mhz.toFixed(2)} famHi=${famHi.toFixed(2)}` : "нет рамки",
    );
  }
  // Свежий удар duty 1 (ещё без промахов) по-прежнему входит в уже виденную сетку.
  {
    const tr = new AttackTracker();
    const mem = new AttackSessionMemory();
    const hops = [2405, 2406, 2407];
    let ts = 1000;
    for (let i = 0; i < 9; i++) {
      const f = hops[i % hops.length]!;
      const snap = tr.update(
        [{ freqMhz: f, fLowMhz: f - 0.3, fHighMhz: f + 0.3, widthMhz: 0.6, powerDbm: -45, noiseDbm: -90, snrDb: 45 }],
        ts,
        { centerMhz: 2407, spanMhz: 56 },
      );
      mem.notePowers(ts, snap, tr.currentSweep(), 2407, 56);
      mem.noteHops(snap, ts);
      ts += 20;
    }
    const snap = tr.update(
      [{ freqMhz: 2408, fLowMhz: 2407.7, fHighMhz: 2408.3, widthMhz: 0.6, powerDbm: -40, noiseDbm: -90, snrDb: 50 }],
      ts,
      { centerMhz: 2407, spanMhz: 56 },
    );
    mem.notePowers(ts, snap, tr.currentSweep(), 2407, 56);
    mem.noteHops(snap, ts);
    const fresh = buildAttackScene({
      tracks: tr.snapshot(),
      bins: [],
      windowMhz: 56,
      memory: mem,
      paint: null,
      wave: null,
      holdMs: 3000,
      bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
      transmitArmed: false,
      sweep: tr.currentSweep(),
    });
    const fp = fresh.advice.suggestPaint;
    check(
      "свежий удар входит в уже виденную сетку",
      fp != null && 2408 >= fp.f1Mhz && 2408 <= fp.f2Mhz && paintSpanMhz(fp) > 2,
      fp ? `${fp.f1Mhz.toFixed(2)}…${fp.f2Mhz.toFixed(2)}` : "нет рамки",
    );
  }

  const txMem = new AttackSessionMemory();
  const shelfAt = (lastSweep: number) =>
    track({ id: 4, freqMhz: 5800, widthMhz: 20, duty: 0.9, powerDbm: -30, firstSweep: 1, lastSweep, streak: 6 });
  const handAt = (lastSweep: number) =>
    track({ id: 3, freqMhz: 915, widthMhz: 0.5, duty: 0.2, powerDbm: -55, firstSweep: 1, lastSweep, streak: 4 });
  const roomAt = (lastSweep: number) =>
    track({ id: 1, freqMhz: 2412, widthMhz: 0.4, duty: 0.95, powerDbm: -20, firstSweep: 1, lastSweep, streak: 8 });
  for (let sweep = 1; sweep <= 4; sweep++) {
    txMem.notePowers(sweep, [shelfAt(sweep), handAt(sweep), roomAt(sweep)], sweep, 5800, 40);
  }
  const ownTx = (mhz: number) => mhz >= 5790 && mhz <= 5810;
  txMem.notePowers(5, [shelfAt(4), handAt(5), roomAt(4)], 5, 5800, 40, ownTx);
  txMem.notePowers(6, [shelfAt(4), handAt(6), roomAt(4)], 6, 5800, 40, ownTx);
  const duringTx = txMem.powerSnaps().at(-1)!;
  check(
    "свой TX не пишется промахом полки",
    !duringTx.rows.some((r) => r.id === 4) && duringTx.rows.some((r) => r.id === 3 && r.measured === true),
  );
  const bareMiss = new AttackSessionMemory();
  bareMiss.notePowers(1, [shelfAt(1)], 1, 5800, 40);
  bareMiss.notePowers(2, [shelfAt(1)], 2, 5800, 40);
  check(
    "промах в окне без своего TX остаётся промахом",
    bareMiss.powerSnaps().at(-1)!.rows.some((r) => r.id === 4 && r.measured === false),
  );
  const txInfo = readAttackInfo({ tracks: [roomAt(6), handAt(6)], snaps: txMem.powerSnaps() });
  check("вырезанный свой TX — не тень", !txInfo.line.includes("тень"), txInfo.line);
  const slow = [-30, -32, -34, -36, -38, -40];
  const walkMem = new AttackSessionMemory();
  let walkSweep = 0;
  for (let i = 0; i < slow.length; i++) {
    for (let gap = 0; gap < 20; gap++) {
      walkSweep += 1;
      walkMem.notePowers(
        walkSweep,
        [track({ id: 9, freqMhz: 2440, widthMhz: 0.4, duty: 0.2, powerDbm: -50, lastSweep: walkSweep, firstSweep: 1 })],
        walkSweep,
        2440,
        56,
      );
    }
    walkSweep += 1;
    walkMem.notePowers(
      walkSweep,
      [track({ id: 6, freqMhz: 5800, widthMhz: 16, duty: 0.9, powerDbm: slow[i]!, lastSweep: walkSweep, firstSweep: 1 })],
      walkSweep,
      5800,
      56,
    );
    walkSweep += 1;
    walkMem.notePowers(
      walkSweep,
      [track({ id: 5, freqMhz: 1280, widthMhz: 16, duty: 0.9, powerDbm: slow[i]! + 18, lastSweep: walkSweep, firstSweep: 1 })],
      walkSweep,
      1280,
      56,
    );
  }
  const walkedRepeater = readAttackInfo({
    tracks: [
      track({ id: 6, freqMhz: 5800, widthMhz: 16, duty: 0.9, powerDbm: -40 }),
      track({ id: 5, freqMhz: 1280, widthMhz: 16, duty: 0.9, powerDbm: -22 }),
    ],
    snaps: walkMem.powerSnaps(),
  });
  const keptHigh = walkMem.powerSnaps().reduce((n, s) => n + s.rows.filter((r) => r.id === 6).length, 0);
  check(
    "чужие окна не стирают ход двух полок",
    keptHigh === slow.length && walkedRepeater.line.includes("ретранслятор"),
    `high=${keptHigh} ${walkedRepeater.line}`,
  );
  const holdMem = new AttackSessionMemory();
  for (let sweep = 1; sweep <= 4; sweep++) {
    holdMem.notePowers(sweep, [shelfAt(sweep)], sweep, 5800, 56);
  }
  for (let sweep = 5; sweep <= 64; sweep++) {
    holdMem.notePowers(sweep, [shelfAt(4)], sweep, 5800, 40, (mhz) => mhz >= 5790 && mhz <= 5810);
  }
  const keptShelf = holdMem.powerSnaps().reduce((n, s) => n + s.rows.filter((r) => r.id === 4 && r.measured !== false).length, 0);
  check("выдержка своего TX не стирает прежние замеры полки", keptShelf === 4, `kept=${keptShelf}`);

  const breathe = [-40, -34, -42, -30, -38, -28];
  const lowCopy = track({ id: 5, freqMhz: 1280, widthMhz: 16, duty: 0.9, powerDbm: -22, streak: 8 });
  const highShelf = track({ id: 6, freqMhz: 5800, widthMhz: 16, duty: 0.9, powerDbm: -40, streak: 8 });
  const repeaterSnaps = powerSnaps(breathe.map((p) => [
    { id: 6, freqMhz: 5800, powerDbm: p, widthMhz: 16, duty: 0.9 },
    { id: 5, freqMhz: 1280, powerDbm: p + 18, widthMhz: 16, duty: 0.9 },
  ]));
  const repeaterAdvice = buildAttackAdvice({
    tracks: [lowCopy, highShelf],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    snaps: repeaterSnaps,
  });
  check(
    "ретранслятор: рамка на громкой полке сейчас",
    repeaterAdvice.suggestPaint != null &&
      Math.abs(mid(repeaterAdvice.suggestPaint) - 1280) < 2 &&
      paintSpanMhz(repeaterAdvice.suggestPaint) < 40,
    `mid=${mid(repeaterAdvice.suggestPaint).toFixed(2)} span=${repeaterAdvice.suggestPaint ? paintSpanMhz(repeaterAdvice.suggestPaint).toFixed(1) : "нет"}`,
  );
  check(
    "ретранслятор в информации, обе частоты текущие",
    repeaterAdvice.scene.includes("ретранслятор") &&
      repeaterAdvice.scene.includes("1280.00") &&
      repeaterAdvice.scene.includes("5800.00") &&
      repeaterAdvice.scene.includes("сейчас"),
  );
  const apart = readAttackInfo({
    tracks: [lowCopy, highShelf],
    snaps: powerSnaps(breathe.map((p) => [
      { id: 6, freqMhz: 5800, powerDbm: p, widthMhz: 16, duty: 0.9 },
      { id: 5, freqMhz: 1280, powerDbm: -62 - p, widthMhz: 16, duty: 0.9 },
    ])),
  });
  check("разный ход полок — не ретранслятор", !apart.line.includes("ретранслятор"));
  const shifted = readAttackInfo({
    tracks: [lowCopy, highShelf],
    snaps: powerSnaps([
      [
        { id: 6, freqMhz: 5800, powerDbm: -40, widthMhz: 16, duty: 0.9 },
        { id: 5, freqMhz: 1280, powerDbm: -22, widthMhz: 16, duty: 0.9 },
      ],
      [
        { id: 6, freqMhz: 5800, powerDbm: -34, widthMhz: 16, duty: 0.9 },
        { id: 5, freqMhz: 1280, powerDbm: -21.5, widthMhz: 16, duty: 0.9 },
      ],
      [
        { id: 6, freqMhz: 5800, powerDbm: -33.5, widthMhz: 16, duty: 0.9 },
        { id: 5, freqMhz: 1280, powerDbm: -16, widthMhz: 16, duty: 0.9 },
      ],
      [
        { id: 6, freqMhz: 5800, powerDbm: -42, widthMhz: 16, duty: 0.9 },
        { id: 5, freqMhz: 1280, powerDbm: -24, widthMhz: 16, duty: 0.9 },
      ],
    ]),
  });
  check(
    "шаг вверх в разные моменты — не ретранслятор",
    !shifted.line.includes("ретранслятор"),
    shifted.line,
  );

  const geminiAdvice = buildAttackAdvice({
    tracks: [
      track({ id: 7, freqMhz: 915, widthMhz: 0.5, duty: 0.2, powerDbm: -30, streak: 1 }),
      track({ id: 8, freqMhz: 2440, widthMhz: 0.5, duty: 0.2, powerDbm: -46, streak: 1 }),
    ],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check(
    "разные полосы без совместного окна — не одна радиосвязь и не мост",
    geminiAdvice.suggestPaint != null &&
      geminiAdvice.suggestPaint.f1Mhz > 800 &&
      geminiAdvice.suggestPaint.f2Mhz < 1100 &&
      !geminiAdvice.scene.includes("одна радиосвязь"),
  );
  const geminiPair = [
    track({ id: 21, freqMhz: 2420, widthMhz: 0.5, duty: 0.2, powerDbm: -28, streak: 1 }),
    track({ id: 22, freqMhz: 2448, widthMhz: 0.5, duty: 0.2, powerDbm: -36, streak: 1 }),
  ];
  const geminiSeen = buildAttackAdvice({
    tracks: geminiPair,
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    snaps: powerSnaps([1, 2, 3, 4].map(() => [
      { id: 21, freqMhz: 2420, powerDbm: -28, widthMhz: 0.5, duty: 0.2 },
      { id: 22, freqMhz: 2448, powerDbm: -36, widthMhz: 0.5, duty: 0.2 },
    ])),
  });
  check(
    "две узкие в одном окне четыре раза — одна радиосвязь",
    geminiSeen.scene.includes("одна радиосвязь") &&
      geminiSeen.suggestPaint != null &&
      paintSpanMhz(geminiSeen.suggestPaint) < 20,
  );

  const stepWide = track({ id: 9, freqMhz: 5800, widthMhz: 12, duty: 0.9, powerDbm: -35, streak: 8 });
  const stepHand = track({ id: 10, freqMhz: 2440, widthMhz: 0.6, duty: 0.2, powerDbm: -30, streak: 1 });
  const stepSnaps = powerSnaps(
    [-40, -40, -40, -30, -30, -30].map((p, i) => [
      { id: 9, freqMhz: 5800, powerDbm: -35, widthMhz: 12, duty: 0.9 },
      { id: 10, freqMhz: 2440, powerDbm: p, widthMhz: 0.6, duty: 0.2, firstSweep: i < 3 ? 1 : 1 },
    ]),
  );
  const stepAdvice = buildAttackAdvice({
    tracks: [stepWide, stepHand],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    snaps: stepSnaps,
  });
  check(
    "шаг пульта не становится новой целью",
    stepAdvice.suggestPaint != null && Math.abs(mid(stepAdvice.suggestPaint) - 5800) < 2,
    `mid=${mid(stepAdvice.suggestPaint).toFixed(2)}`,
  );
  check("шаг описан как информация", stepAdvice.scene.includes("шаг мощности"));

  const flutterBoard = track({ id: 11, freqMhz: 5800, widthMhz: 14, duty: 0.9, powerDbm: -38, streak: 8 });
  const flutterNeighbor = track({ id: 12, freqMhz: 5760, widthMhz: 1, duty: 0.9, powerDbm: -32, streak: 8 });
  const flutterSnaps = powerSnaps(
    [-30, -38, -30, -38, -30, -38].map((p) => [
      { id: 11, freqMhz: 5800, powerDbm: p, widthMhz: 14, duty: 0.9 },
      { id: 12, freqMhz: 5760, powerDbm: -32, widthMhz: 1, duty: 0.9 },
    ]),
  );
  const flutterAdvice = buildAttackAdvice({
    tracks: [flutterBoard, flutterNeighbor],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    snaps: flutterSnaps,
  });
  check(
    "дрожание нуля не отдаёт рамку соседу",
    flutterAdvice.suggestPaint != null && Math.abs(mid(flutterAdvice.suggestPaint) - 5800) < 2,
    `mid=${mid(flutterAdvice.suggestPaint).toFixed(2)}`,
  );
  check("дрожание в информации", flutterAdvice.scene.includes("дрожание"));

  const fadeVideo = track({ id: 13, freqMhz: 5800, widthMhz: 12, duty: 0.9, powerDbm: -50, streak: 6 });
  const fadeHand = track({ id: 14, freqMhz: 915, widthMhz: 0.5, duty: 0.2, powerDbm: -60, streak: 1 });
  const fadeRoom = track({ id: 15, freqMhz: 2412, widthMhz: 0.4, duty: 0.95, powerDbm: -25, streak: 8 });
  const fadeSnaps = powerSnaps(
    [0, 1, 2, 3, 4, 5].map((i) => [
      { id: 13, freqMhz: 5800, powerDbm: i < 3 ? -30 : -50, widthMhz: 12, duty: 0.9 },
      { id: 14, freqMhz: 915, powerDbm: i < 3 ? -40 : -60, widthMhz: 0.5, duty: 0.2 },
      { id: 15, freqMhz: 2412, powerDbm: -25, widthMhz: 0.4, duty: 0.95 },
    ]),
  );
  const fadeAdvice = buildAttackAdvice({
    tracks: [fadeVideo, fadeHand, fadeRoom],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    snaps: fadeSnaps,
  });
  check(
    "совместная посадка не отдаёт рамку фону",
    fadeAdvice.suggestPaint != null && Math.abs(mid(fadeAdvice.suggestPaint) - 5800) < 2,
    `mid=${mid(fadeAdvice.suggestPaint).toFixed(2)}`,
  );
  check("посадка в информации", fadeAdvice.scene.includes("обе сели"));

  const plateBody = track({ id: 16, freqMhz: 5800, widthMhz: 12, duty: 0.9, powerDbm: -30, streak: 8 });
  const plateSnaps = powerSnaps(
    [1, 2, 3, 4, 5, 6].map(() => [{ id: 16, freqMhz: 5800, powerDbm: -30, widthMhz: 12, duty: 0.9 }]),
  );
  const noPlate = readAttackInfo({ tracks: [plateBody], snaps: plateSnaps });
  check("декодера таблички нет — слово не появляется", !noPlate.line.includes("табличка"));
  const plateAdvice = buildAttackAdvice({
    tracks: [plateBody],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
    snaps: plateSnaps,
  });
  check(
    "ровная полка без таблички остаётся рамкой",
    plateAdvice.suggestPaint != null && Math.abs(mid(plateAdvice.suggestPaint) - 5800) < 2,
  );

  const hopAdvice = buildAttackAdvice({
    tracks: hopTracks,
    families: fams,
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 1000,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check(
    "hop-рамка по-прежнему семья уже виденных",
    hopAdvice.suggestPaint != null && paintSpanMhz(hopAdvice.suggestPaint) > 2,
  );
  const boardOverHop = buildAttackAdvice({
    tracks: [
      track({ id: 40, freqMhz: 5800, widthMhz: 16, duty: 0.9, powerDbm: -28, streak: 8, maxStreak: 8 }),
      ...[2410, 2414, 2418, 2422].map((f, i) =>
        track({ id: 41 + i, freqMhz: f, widthMhz: 0.5, duty: 0.2, powerDbm: -55, streak: 1 }),
      ),
    ],
    families: stitchHopFamilies(
      [
        track({ id: 40, freqMhz: 5800, widthMhz: 16, duty: 0.9, powerDbm: -28, streak: 8, maxStreak: 8 }),
        ...[2410, 2414, 2418, 2422].map((f, i) =>
          track({ id: 41 + i, freqMhz: f, widthMhz: 0.5, duty: 0.2, powerDbm: -55, streak: 1 }),
        ),
      ],
      [],
    ),
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  const handOverHop = buildAttackAdvice({
    tracks: [
      track({ id: 50, freqMhz: 915, widthMhz: 0.5, duty: 0.3, powerDbm: -20, streak: 4, maxStreak: 4 }),
      ...[2410, 2414, 2418, 2422].map((f, i) =>
        track({ id: 51 + i, freqMhz: f, widthMhz: 0.5, duty: 0.2, powerDbm: -55, streak: 1 }),
      ),
    ],
    families: stitchHopFamilies(
      [
        track({ id: 50, freqMhz: 915, widthMhz: 0.5, duty: 0.3, powerDbm: -20, streak: 4, maxStreak: 4 }),
        ...[2410, 2414, 2418, 2422].map((f, i) =>
          track({ id: 51 + i, freqMhz: f, widthMhz: 0.5, duty: 0.2, powerDbm: -55, streak: 1 }),
        ),
      ],
      [],
    ),
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check(
    "громкий пульт не отдаёт рамку hop-семье другой полосы",
    handOverHop.suggestPaint != null &&
      Math.abs(mid(handOverHop.suggestPaint) - 915) < 2 &&
      paintSpanMhz(handOverHop.suggestPaint) < 5,
    `mid=${mid(handOverHop.suggestPaint).toFixed(2)} span=${handOverHop.suggestPaint ? paintSpanMhz(handOverHop.suggestPaint).toFixed(1) : "нет"}`,
  );
  const loudHop = [2440, 2444, 2448, 2452].map((f, i) =>
    track({ id: 70 + i, freqMhz: f, widthMhz: 0.4, duty: 0.2, powerDbm: -25, streak: 1 }),
  );
  const quietHop = [868, 870, 872, 874].map((f, i) =>
    track({ id: 60 + i, freqMhz: f, widthMhz: 0.4, duty: 0.2, powerDbm: -60, streak: 1 }),
  );
  const twoFamilies = buildAttackAdvice({
    tracks: [...quietHop, ...loudHop],
    families: stitchHopFamilies([...quietHop, ...loudHop], []),
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check(
    "рамка семьи — та, где громкая вспышка, не первая в списке",
    twoFamilies.suggestPaint != null &&
      twoFamilies.suggestPaint.f1Mhz > 2400 &&
      twoFamilies.suggestPaint.f2Mhz < 2500,
    `f1=${twoFamilies.suggestPaint?.f1Mhz.toFixed(2)} f2=${twoFamilies.suggestPaint?.f2Mhz.toFixed(2)}`,
  );
  check(
    "широкий борт не отдаёт рамку чужой hop-семье",
    boardOverHop.suggestPaint != null &&
      Math.abs(mid(boardOverHop.suggestPaint) - 5800) < 2 &&
      paintSpanMhz(boardOverHop.suggestPaint) < 40,
    `mid=${mid(boardOverHop.suggestPaint).toFixed(2)} span=${boardOverHop.suggestPaint ? paintSpanMhz(boardOverHop.suggestPaint).toFixed(1) : "нет"}`,
  );
  check("сетка hop не называется одной радиосвязью", !hopAdvice.scene.includes("одна радиосвязь"));
  check("hop в информации — пульт", hopAdvice.scene.includes("Информация") && hopAdvice.scene.includes("пульт"));

  const louderHand = track({ id: 17, freqMhz: 2440, widthMhz: 0.6, duty: 0.2, powerDbm: -18, streak: 1 });
  const quieterBoard = track({ id: 18, freqMhz: 5800, widthMhz: 12, duty: 0.9, powerDbm: -42, streak: 8 });
  const wideFirst = buildAttackAdvice({
    tracks: [louderHand, quieterBoard],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: wideBands,
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check(
    "широкая полка важнее громкого пульта",
    wideFirst.suggestPaint != null && Math.abs(mid(wideFirst.suggestPaint) - 5800) < 2,
    `mid=${mid(wideFirst.suggestPaint).toFixed(2)}`,
  );

  const floorAdvice = buildAttackAdvice({
    tracks: [
      track({ id: 19, freqMhz: 5800, widthMhz: 30, duty: 0.9, powerDbm: -30, streak: 8, fLowMhz: 5785, fHighMhz: 5815 }),
      track({ id: 20, freqMhz: 5760, widthMhz: 0.8, duty: 0.2, powerDbm: -15, streak: 1, fLowMhz: 5759.6, fHighMhz: 5760.4 }),
    ],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 5600, f2Mhz: 5900 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check(
    "два этажа в одной корзине по-прежнему с широкого",
    floorAdvice.hints.some((h) => h.kind === "paint" && h.text.includes("Сначала широкое")),
  );
  const louderShelf = buildAttackAdvice({
    tracks: [
      track({ id: 80, freqMhz: 5780, widthMhz: 20, duty: 0.9, powerDbm: -40, streak: 8, maxStreak: 8 }),
      track({ id: 81, freqMhz: 5820, widthMhz: 12, duty: 0.9, powerDbm: -22, streak: 8, maxStreak: 8 }),
      track({ id: 82, freqMhz: 5760, widthMhz: 0.5, duty: 0.2, powerDbm: -15, streak: 1, maxStreak: 1 }),
    ],
    families: [],
    widths: new Map(),
    looks: new Map(),
    windowMhz: 56,
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 5600, f2Mhz: 5900 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  check(
    "два этажа берут громкую полку, не первую в списке",
    louderShelf.suggestPaint != null && Math.abs(mid(louderShelf.suggestPaint) - 5820) < 2,
    `mid=${mid(louderShelf.suggestPaint).toFixed(2)}`,
  );
  check("пустая волна = узкий класс", waveClassOf(null) === "narrow");
  const scene = buildAttackScene({
    tracks: sticky,
    bins: brick20,
    windowMhz: 56,
    memory: new AttackSessionMemory(),
    paint: null,
    wave: null,
    holdMs: 3000,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    transmitArmed: false,
  });
  check("сцена не пишет TX", scene.advice.hints.every((h) => h.kind !== "wave" || h.wave == null || h.applyLabel != null));
  check("память пишет по-русски", scene.memoryLine.includes("помнит") || scene.memoryLine.includes("пуста") || scene.memoryLine.includes("IQ"));
  check("сцена показывает информацию борта", scene.rows[0]?.infoRu === "борт");
  check("сцена помощника без таблички", !scene.advice.scene.includes("табличка"));

  const analog30 = detectAttackHits(brickBins(5800, 56, 512, 5785, 5815, -25), 12, 56);
  check(
    "слух 56 видит analog ~30, не 22",
    analog30.some((h) => h.widthMhz >= 28 && h.widthMhz <= 32),
    analog30.map((h) => h.widthMhz.toFixed(2)).join(","),
  );

  const fat = clampPaintToCaps({ f1Mhz: 2400, f2Mhz: 2500 });
  check("рамка шире 40 обрезана", paintSpanMhz(fat) <= ATTACK_TX_MAX_MHZ + 1e-9);
  const bands = [{ f1Mhz: 2400, f2Mhz: 2500 }];
  const clipped = clipPaintToAllowlist({ f1Mhz: 2430, f2Mhz: 2440 }, bands);
  check("рамка в allowlist", clipped != null && paintCenterMhz(clipped!) > 2430);
  check("рамка вне полосы отказ", clipPaintToAllowlist({ f1Mhz: 900, f2Mhz: 910 }, bands) === null);
  const twoCorridors = [
    { f1Mhz: 2400, f2Mhz: 2500 },
    { f1Mhz: 5725, f2Mhz: 5850 },
  ];
  const leak = clipPaintToAllowlist({ f1Mhz: 2490, f2Mhz: 2510 }, twoCorridors);
  check(
    "клип не вылезает в дыру между коридорами",
    leak != null && leak.f2Mhz <= 2500 + 1e-9 && leak.f1Mhz >= 2400 - 1e-9,
    leak ? `${leak.f1Mhz}…${leak.f2Mhz}` : "null",
  );
  check("без рамки ПЕРЕДАТЬ отказ", paintRefuseReason(null, bands, true)?.includes("мышкой") === true);
  check("без 50 Ом отказ", paintRefuseReason({ f1Mhz: 2430, f2Mhz: 2440 }, bands, false)?.includes("50") === true);
  check("выдержка режется", clampAttackHoldMs(10) === 200 && clampAttackHoldMs(999999) === 120000);
  const p = { f1Mhz: 2430, f2Mhz: 2450 };
  check("синус не заливает 20 МГц", waveOccupiesPaintMhz("sine", p, {}) < 1);
  check("шум заливает рамку", Math.abs(waveOccupiesPaintMhz("awgn", p, {}) - 20) < 1e-9);
  check("SC-FDMA не заливка", Math.abs(waveOccupiesPaintMhz("scfdma", p, {}) - 5) < 1e-9);
  check("SC-FDMA класс часть", waveClassOf("scfdma") === "part");
  check("текст заливки без SC-FDMA", waveClassRu("fill").includes("OFDM") && !waveClassRu("fill").includes("SC-FDMA"));
  const chirp = attackWaveParams("chirp", p, {});
  check("чирп размах = рамка, не 1 МГц", (chirp.spanKhz ?? 0) >= 10000);
  check("fs рамки в потолке USB", paintTxFsHz(p) <= 40e6 && paintTxFsHz(p) >= 20e6 * 0.99);
  check("подсказка волны честная", paintWaveHint("sine", p, {}).includes("не всю"));
  check(
    "рамка владеет TX с момента ПЕРЕДАТЬ, не с lastForward",
    attackPaintOwnsTx("auto", p, true) &&
      !attackPaintOwnsTx("auto", p, false) &&
      !attackPaintOwnsTx("auto", null, true) &&
      !attackPaintOwnsTx("fpga", p, true),
  );

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
  useLegion.setState({
    attackAdvice: {
      scene: "тест",
      after: "",
      hints: [{
        kind: "paint",
        title: "Рамка",
        text: "тест",
        why: "тест",
        applyLabel: "Взять",
        paint: { f1Mhz: 2410, f2Mhz: 2430 },
        wave: null,
        holdMs: null,
      }],
      suggestPaint: { f1Mhz: 2410, f2Mhz: 2430 },
    },
  });
  L().applyAttackHint("paint");
  check("взять рамку — только клик оператора", L().attackPaint != null && Math.abs(L().attackPaint.f1Mhz - 2410) < 0.05);
  L().setAttackPaint({ f1Mhz: 2430, f2Mhz: 2450 });

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
  // Замок рамки должен держать оператора, а не lastForward (его ещё нет до
  // commit ПЕРЕДАТЬ). Иначе тик скана в окне armed→TX забирает демо-несущую.
  useLegion.setState({ transmitArmed: true });
  const stolen = await waitFor("тик украл TX", () => L().lastForwardMhz != null, 500);
  check(
    "рамка+armed: тик не авто-handoff до ПЕРЕДАТЬ",
    !stolen,
    `lastForward=${L().lastForwardMhz}`,
  );
  await L().stopTransmit();
  await new Promise((r) => setTimeout(r, ATTACK_COOLDOWN_MS + 30));
  L().setAttackPaint({ f1Mhz: 2430, f2Mhz: 2450 });
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

  // sweep/band/hop сканер не поднимают (scanRefusedReason). Тот же crop, что tickScan без listen.
  const other = new MockSdrBackend();
  other.setEmulation(true);
  other.open("bladerf-micro-xa4");
  const otherBins = cropPsdBins(other.scanWindow(2442, hostScanSpanMhz(56), 1024));
  const otherSpan =
    otherBins.length > 1 ? otherBins[otherBins.length - 1]!.freqMhz - otherBins[0]!.freqMhz : 0;
  check("чужой путь: 1024 × crop 0.5", otherBins.length === 512);
  check("чужой путь: окно ~20, не 56", Math.abs(otherSpan - 20) < 2, `span=${otherSpan.toFixed(2)}`);

  console.log(failures === 0 ? "\nHOST ATTACK: ALL PASS" : `\nHOST ATTACK: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
