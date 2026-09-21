// ============================================================================
// LEGION — тесты хост-Атаки. Не трогают FPGA / ESP32 / detectFromBins.
// Запуск: npx tsx scripts/test_host_attack.ts
// ============================================================================
import { caCfar1d, detectAttackHits, ATTACK_MIN_BW_MHZ, ATTACK_MAX_BW_MHZ } from "../src/sense/attackDetect";
import { AttackTracker, ATTACK_MIN_HITS } from "../src/sense/attackTracks";
import { atlasForTracks, classifyAttackFamily, bandBucket } from "../src/sense/attackAtlas";
import { stitchHopFamilies } from "../src/sense/attackFamily";
import { occupied99Mhz, width26dbMhz, width3dbMhzAttack } from "../src/sense/attackMeasure";
import { buildAttackAdvice, waveClassOf, waveClassRu } from "../src/sense/attackAdvisor";
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
  const rc24 = classifyAttackFamily({
    freqMhz: 2442, widthMhz: 0.8, duty: 0.2, streak: 1,
  });
  check("2.4 hop ≤2 — rc-24", rc24.id === "rc-24");
  check(
    "2.4 класс: ELRS, mLRS и не разделить",
    rc24.hint.includes("ELRS") && rc24.hint.includes("mLRS") && rc24.hint.includes("не разделить"),
    rc24.hint,
  );
  const rc900 = classifyAttackFamily({
    freqMhz: 915, widthMhz: 0.5, duty: 0.2, streak: 1,
  });
  check(
    "900 класс не разделить",
    rc900.hint.includes("Crossfire") && rc900.hint.includes("не разделить"),
    rc900.hint,
  );
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
  check(
    "два этажа — FPV без имени борта",
    floors[0]?.atlas.hint.includes("FPV") === true && !/лелека|шарк|fp-2/i.test(floors[0]?.atlas.hint ?? ""),
    floors[0]?.atlas.hint ?? "",
  );

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
  hopMem.forgetLooks();
  check("старт скана забывает разбор старых id", hopMem.looks.size === 0);
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
  const chirpAdvice = buildAttackAdvice({
    tracks: sticky,
    families: [],
    widths: new Map([[1, { width3Mhz: 19.5, width26Mhz: 20.2, occ99Mhz: 20.0 }]]),
    looks: new Map(),
    windowMhz: 56,
    paint: { f1Mhz: 2432, f2Mhz: 2452 },
    wave: "chirp",
    holdMs: 3000,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    residual: null,
    memory: new AttackSessionMemory().stats(),
    transmitArmed: false,
  });
  const chirpWave = chirpAdvice.hints.find((h) => h.kind === "wave");
  check("чирп на широкой рамке зальёт края", (chirpWave?.text ?? "").includes("зальёт"), chirpWave?.text ?? "");
  check("рамка предлагается, не ставится", advice.suggestPaint != null && advice.hints.some((h) => h.kind === "paint" && h.paint != null));
  check("предложение не команда", advice.scene.includes("не команда"));
  check("MAVLink не форма спектра", advice.scene.includes("MAVLink"));

  function hopAt(id: number, mhz: number, dbm: number) {
    return {
      id,
      freqMhz: mhz,
      fLowMhz: mhz - 0.4,
      fHighMhz: mhz + 0.4,
      widthMhz: 0.8,
      powerDbm: dbm,
      noiseDbm: -90,
      snrDb: dbm + 90,
      hits: 3,
      streak: 1,
      maxStreak: 2,
      firstSweep: 1,
      lastSweep: 4,
      gap: 0,
      duty: 0.2,
      state: "confirmed" as const,
      lastSeenTs: 1,
    };
  }
  const memHops: number[] = [];
  for (let f = 2408; f <= 2492; f += 8) memHops.push(f);
  const liveHop = hopAt(1, 2472, -20);
  const wideFams = stitchHopFamilies([liveHop], memHops);
  check(
    "огибающая соседних окон шире 40",
    (wideFams[0] ? wideFams[0].fHighMhz - wideFams[0].fLowMhz : 0) > 40,
    wideFams[0] ? `${wideFams[0].fLowMhz}…${wideFams[0].fHighMhz}` : "нет семьи",
  );
  const wideAdvice = buildAttackAdvice({
    tracks: [liveHop],
    families: wideFams,
    widths: new Map([[1, { width3Mhz: 0.6, width26Mhz: 0.9, occ99Mhz: 0.8 }]]),
    looks: new Map(),
    windowMhz: 56,
    paint: { f1Mhz: 2468, f2Mhz: 2476 },
    wave: "sine",
    holdMs: 3000,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    residual: null,
    memory: {
      hopRemembered: memHops.length,
      scenes: 4,
      residuals: 0,
      workerSamples: 0,
      workerCap: 0,
      workerMs: 0,
    },
    memoryHopsMhz: memHops,
    transmitArmed: false,
  });
  const paintHint = wideAdvice.hints.find((h) => h.kind === "paint");
  const proposed = paintHint?.paint ?? wideAdvice.suggestPaint;
  check(
    "кусок не шире 40",
    proposed != null && paintSpanMhz(proposed) <= ATTACK_TX_MAX_MHZ + 1e-6,
    proposed ? `${paintSpanMhz(proposed)}` : "нет",
  );
  check(
    "кусок накрывает живую вспышку, не нижний край",
    proposed != null && proposed.f1Mhz <= 2472 && proposed.f2Mhz >= 2472 && proposed.f1Mhz > 2420,
    proposed ? `${proposed.f1Mhz}…${proposed.f2Mhz}` : "нет",
  );
  check("следующим мазком", (paintHint?.text ?? "").includes("следующим мазком"), paintHint?.text ?? "");
  check(
    "канал не угадываем",
    wideAdvice.hints.some((h) => h.text.includes("канал не угадываем")),
  );
  check(
    "класс ELRS в сцене",
    wideAdvice.scene.includes("ELRS") && wideAdvice.scene.includes("не разделить"),
    wideAdvice.scene,
  );
  check("борта не названы", !/лелека|шарк|хорнет|fp-2/i.test(wideAdvice.scene + (paintHint?.text ?? "")));
  const waveHint = wideAdvice.hints.find((h) => h.kind === "wave");
  check(
    "синус не зальёт края",
    (waveHint?.text ?? "").includes("не зальёт") || (waveHint?.text ?? "").includes("края"),
    waveHint?.text ?? "",
  );
  const holdHint = wideAdvice.hints.find((h) => h.kind === "hold");
  check(
    "выдержка коротковата для hop",
    (holdHint?.text ?? "").includes("коротковата") && holdHint?.holdMs === 5000,
    holdHint?.text ?? "",
  );
  check(
    "взять не передаёт",
    wideAdvice.scene.includes("не передаёт") && wideAdvice.hints.length <= 3,
  );
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
