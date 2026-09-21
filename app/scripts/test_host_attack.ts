// ============================================================================
// LEGION — тесты хост-Атаки. Не трогают FPGA / ESP32 / detectFromBins.
// Запуск: npx tsx scripts/test_host_attack.ts
// ============================================================================
import { caCfar1d, detectAttackHits, ATTACK_MIN_BW_MHZ, ATTACK_MAX_BW_MHZ } from "../src/sense/attackDetect";
import { AttackTracker, ATTACK_MIN_HITS, type AttackTrack } from "../src/sense/attackTracks";
import { atlasForTracks, classifyAttackFamily, bandBucket } from "../src/sense/attackAtlas";
import { stitchHopFamilies } from "../src/sense/attackFamily";
import { occupied99Mhz, width26dbMhz, width3dbMhzAttack } from "../src/sense/attackMeasure";
import { buildAttackAdvice, waveClassOf, waveClassRu } from "../src/sense/attackAdvisor";
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
