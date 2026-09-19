// ============================================================================
// LEGION — лабораторный PSD / журнал xA4. Не эфир, не STA/SMA PASS.
// Запуск: npx tsx scripts/test_lab_scanner.ts
// ============================================================================
import { cropPsdBins, detectFromBins, estimateNoiseFloor, hostPaintSpanMhz, MockSdrBackend } from "../src/sdr/backend";
import { allocAtMhz, bandsInSpan, FREQ_EUROPE_XA4 } from "../src/sense/labAlloc";
import { PersistentDisplay, RTS_CALIBRATE_MS } from "../src/sense/labPersist2d";
import { SpurFilter } from "../src/sense/labSpur";
import { catalogById } from "../src/sdr/catalog";
import {
  LAB_BASELINE_DEFAULT_SEC,
  LAB_OCCUPANCY_MARGIN_DB,
  baselineElapsedSec,
  emptyLabPsd,
  finiteDbm,
  freezeLabBaseline,
  ingestLabFrame,
  makeGrid,
  occupancyCoverage,
  occupancyMask,
  paintWindow,
  persistBin,
  peakHoldBin,
  resetLabHolds,
  startLabBaseline,
  subtractBaseline,
  width3dbMhz,
} from "../src/sense/labPsd";
import {
  LAB_MIN_DURATION_SEC,
  LAB_PLAYLIST_PRESETS,
  LabEventTracker,
  XA4_ANALOG_MHZ,
  XA4_RX_MHZ,
  XA4_TX_MHZ,
  buildLabJournal,
  buildPlaylist,
  hostPeaksForJournal,
  listHits,
  parseIperfJson,
  parseMhzList,
  parsePlaylistJson,
  playlistStepFromScanner,
  playlistStepPatch,
  recordBper,
  recordJsr,
} from "../src/sense/labJournal";
import { useLegion } from "../src/state/store";

let failures = 0;
function check(name: string, cond: boolean): void {
  if (cond) console.log(`  ok  ${name}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${name}`);
  }
}

function toneWindow(center: number, bw: number, n: number, toneMhz: number, peak = -40, floor = -90) {
  const half = bw / 2;
  return Array.from({ length: n }, (_, i) => {
    const freqMhz = center - half + (bw * i) / (n - 1);
    const powerDbm = Math.abs(freqMhz - toneMhz) < bw / n ? peak : floor;
    return { freqMhz, powerDbm };
  });
}

async function main(): Promise<void> {
  console.log("LAB SCANNER");

  const xa4 = catalogById("bladerf-micro-xa4");
  check("каталог xA4 RX 70–6000", !!xa4 && xa4.rxMhz?.[0] === 70 && xa4.rxMhz[1] === 6000);
  check("каталог xA4 TX 47–6000", !!xa4 && xa4.txMhz?.[0] === 47 && xa4.txMhz[1] === 6000);
  check("каталог xA4 analog ≤56", !!xa4 && xa4.analogBwMhz === 56);
  check("константы журнала = каталог", XA4_RX_MHZ[0] === 70 && XA4_TX_MHZ[0] === 47 && XA4_ANALOG_MHZ === 56);
  check("полка по умолчанию 120 с (poc), не 30–60", LAB_BASELINE_DEFAULT_SEC === 120);
  check("min_duration 0.1 с (rtl-sdr-analyzer)", LAB_MIN_DURATION_SEC === 0.1);

  check("peak-hold берёт max", peakHoldBin(-80, -50) === -50 && peakHoldBin(-50, -70) === -50);
  check("peak-hold не затирает NaN живым", peakHoldBin(-40, Number.NaN) === -40);
  check("peak-hold пишет в пустой бин", peakHoldBin(Number.NaN, -55) === -55);

  const faded = persistBin(-80, Number.NaN, 0.94);
  check("persistence гаснет в линейной мощности", finiteDbm(faded) && faded < -80 && faded > -81);
  check("persistence не умножает dBm (−80×0.94 = −75 — запрещено)", faded !== -80 * 0.94);

  const w1 = toneWindow(915, 20, 64, 915, -35, -92);
  const w2 = toneWindow(5800, 20, 64, 5800, -30, -95);
  let psd = emptyLabPsd();
  const paintedNear = (bins: { freqMhz: number; powerDbm: number }[], mhz: number) =>
    bins.filter((b) => Math.abs(b.freqMhz - mhz) < 20 && finiteDbm(b.powerDbm));
  psd = ingestLabFrame(psd, w1, 100, 6000, 1_000);
  const pooled = paintWindow(makeGrid(900, 930, 8), [
    { freqMhz: 915, powerDbm: -35 },
    { freqMhz: 915, powerDbm: -90 },
  ]);
  check("paintWindow max-pool не даёт полу затереть пик", pooled.filter((b) => finiteDbm(b.powerDbm)).every((b) => b.powerDbm === -35));
  check("коридор 100–6000 принимает 915 (не зашит 2450)", paintedNear(psd.composite, 915).some((b) => b.powerDbm > -50));
  check("окно 915 не растягивается на 5800 (soapy_power)", paintedNear(psd.composite, 5800).length === 0);
  psd = ingestLabFrame(psd, w2, 100, 6000, 2_000);
  check("второе окно пишет 5800 на ту же ось", paintedNear(psd.composite, 5800).some((b) => b.powerDbm > -50));
  check("peak-hold помнит 915 после hop на 5800", paintedNear(psd.peakHold, 915).some((b) => b.powerDbm > -50));

  const w3 = toneWindow(915, 20, 64, 915, -60, -92);
  psd = ingestLabFrame(psd, w3, 100, 6000, 3_000);
  check("peak-hold не падает за live", paintedNear(psd.peakHold, 915).some((b) => b.powerDbm > -40));

  let base = startLabBaseline(emptyLabPsd(), 0);
  check("старт полки не заморожен", base.baselineStartedMs === 0 && base.baselineFrozen === false);
  const quiet = toneWindow(2442, 40, 128, 2442, -91, -91);
  base = ingestLabFrame(base, quiet, 2400, 2500, 1_000);
  const loud = toneWindow(2442, 40, 128, 2442, -40, -91);
  const mid = ingestLabFrame(base, loud, 2400, 2500, 2_000);
  const floorBin = mid.baseline.find((b) => Math.abs(b.freqMhz - 2442) < 0.5);
  check("полка копится средне, не прыгает на пик кадра 2", !!floorBin && finiteDbm(floorBin.powerDbm) && floorBin.powerDbm < -60);
  const frozenTime = ingestLabFrame(mid, loud, 2400, 2500, 120_000);
  check("полка замирает на 120 с", frozenTime.baselineFrozen === true);
  const afterFreeze = ingestLabFrame(frozenTime, toneWindow(2442, 40, 128, 2442, -10, -10), 2400, 2500, 130_000);
  const frozenBin = afterFreeze.baseline.find((b) => Math.abs(b.freqMhz - 2442) < 0.5);
  check("после freeze полка не ест новый тон", !!frozenBin && !!floorBin && Math.abs((frozenBin.powerDbm ?? 0) - (floorBin.powerDbm ?? 0)) < 1e-6);
  check("elapsed при freeze не больше цели", (baselineElapsedSec(afterFreeze, 200_000) ?? 999) <= 120 + 1e-6);

  const sub = subtractBaseline(
    [{ freqMhz: 100, powerDbm: -40 }],
    [{ freqMhz: 100, powerDbm: -90 }],
  );
  check("baseline subtract = current − полка", sub[0].powerDbm === 50);

  const occWin = [
    { freqMhz: 1, powerDbm: -90 },
    { freqMhz: 2, powerDbm: -90 },
    { freqMhz: 3, powerDbm: -70 },
    { freqMhz: 4, powerDbm: -90 },
  ];
  const occBase = occWin.map((b) => ({ freqMhz: b.freqMhz, powerDbm: -90 }));
  const mask = occupancyMask(occWin, occBase, LAB_OCCUPANCY_MARGIN_DB);
  check("занятость +12 дБ: один бин из четырёх", mask.filter(Boolean).length === 1 && occupancyCoverage(mask) === 0.25);
  check("poc 40 % — метрика, не зашитая цель", occupancyCoverage(mask) !== 0.4);

  const wide = toneWindow(1000, 10, 101, 1000, -30, -80);
  for (let i = 40; i <= 60; i++) wide[i].powerDbm = -30;
  const w3db = width3dbMhz(wide, 1000);
  check("3 дБ ширина около 2 МГц на площадке", w3db > 1.5 && w3db < 2.6);

  const mock = new MockSdrBackend();
  mock.setEmulation(true);
  mock.open("bladerf-micro-xa4");
  mock.injectTone(433.0, -38);
  const bins = mock.scanWindow(433, 8, 64);
  const noise = estimateNoiseFloor(bins);
  const dets = detectFromBins(bins, 12);
  check("мок xA4 видит тон 433", dets.some((d) => Math.abs(d.freqMhz - 433) < 0.3) && noise < -70);
  const peaks = hostPeaksForJournal(bins, 12, 0.01);
  check("журнал хоста берёт тот же тон", peaks.some((p) => Math.abs(p.freqMhz - 433) < 0.3));
  const skinny = hostPeaksForJournal(bins, 12, 50);
  check("мин. ширина отсекает узкий тон", skinny.length === 0);

  const tr = new LabEventTracker();
  const live = [
    {
      source: "host-welch" as const,
      freqMhz: 915,
      powerDbm: -40,
      noiseDbm: -90,
      snrDb: 50,
      widthMhz: 0.2,
      widthKind: "3db" as const,
      forwarded: false,
    },
  ];
  const none = tr.ingest(live, 1000, LAB_MIN_DURATION_SEC);
  const still = tr.ingest(live, 1050, LAB_MIN_DURATION_SEC);
  check("короткая вспышка <0.1 с не в журнале", none.length === 0 && still.length === 0);
  const closedEarly = tr.ingest([], 1100, LAB_MIN_DURATION_SEC, 20);
  check("пропала до 0.1 с — событие не пишется (антиспам rtl)", closedEarly.length === 0);
  const tr2 = new LabEventTracker();
  tr2.ingest(live, 0, LAB_MIN_DURATION_SEC);
  tr2.ingest(live, 120, LAB_MIN_DURATION_SEC);
  const logged = tr2.ingest([], 400, LAB_MIN_DURATION_SEC, 20);
  check("вспышка ≥0.1 с попадает в журнал", logged.length === 1 && logged[0].durationSec >= 0.1);
  check("журнал не утверждает USB-handoff", logged[0].source === "host-welch");

  const fpgaTr = new LabEventTracker();
  const gate = [
    {
      source: "fpga-gate" as const,
      freqMhz: 3500,
      powerDbm: null,
      noiseDbm: null,
      snrDb: null,
      widthMhz: 10,
      widthKind: "look" as const,
      forwarded: true,
    },
  ];
  const micro = fpgaTr.ingest(gate, 0, LAB_MIN_DURATION_SEC);
  const gone = fpgaTr.ingest([], 0.016, LAB_MIN_DURATION_SEC, 0);
  check("гейт 16 µs не задерживается журналом (пусто, не ARM)", micro.length === 0 && gone.length === 0 && fpgaTr.openCount() === 0);

  check("ignore бьёт known", listHits(2442, [2442], [2442])?.kind === "ignore");
  check("known на 0.2 МГц", listHits(5800.1, [5800], [], 0.25)?.kind === "known");
  check("чужая частота не в списках", listHits(1200, [915], [433]) == null);
  check("parseMhzList commа/пробел", parseMhzList("433, 915;5800").join() === "433,915,5800");

  const iperfBad = parseIperfJson(`{"lost_percent":80}`);
  check("голый lost_percent без end.sum — отказ, не 80 %", iperfBad.ok === false);
  const iperfOk = parseIperfJson(
    JSON.stringify({
      end: { sum: { lost_percent: 0.75, bytes: 1_250_000, packets: 1000, lost_packets: 8 } },
    }),
    50,
  );
  check(
    "iperf3 end.sum как у jamrf",
    iperfOk.ok && iperfOk.ok && iperfOk.record.lostPercent === 0.75 && iperfOk.record.bytes === 1_250_000,
  );

  const bper = recordBper(97, 3, 1);
  check("BPER 3/100 = 0.03 (eris)", bper.ok && bper.record.bper === 0.03);
  check("BPER пустой — отказ", recordBper(0, 0).ok === false);

  const jsr = recordJsr({ jsr: 4, eSig: 2 }, 1);
  check("JSR Pj = JSR×Esig", jsr.ok && jsr.record.pJ === 8 && Math.abs(jsr.record.jsrDb - 6.020599) < 1e-3);
  check("JSR одной цифры нет", recordJsr({ jsr: 10 }).ok === false);
  check("JSR врёт, если Pj ≠ произведение", recordJsr({ jsr: 2, eSig: 3, pJ: 100 }).ok === false);

  const plBad = parsePlaylistJson(`{"name":"x","steps":[{"name":"a","centerMhz":2450,"lookMhz":80,"dwellMs":1}]}`);
  check("playlist look 80 МГц > analog 56 — отказ", plBad.ok === false);
  const plOut = parsePlaylistJson(`{"name":"x","steps":[{"centerMhz":20,"lookMhz":2,"dwellMs":1}]}`);
  check("playlist 20 МГц < RX 70 xA4 — отказ", plOut.ok === false);
  const plOk = parsePlaylistJson(
    JSON.stringify({
      name: "lab-xa4",
      steps: [
        { name: "uhf", centerMhz: 433, lookMhz: 2, dwellMs: 0.4, wave: "awgn" },
        { name: "c-band", centerMhz: 5800, lookMhz: 10, dwellMs: 1, wave: "tone" },
      ],
    }),
  );
  check("playlist 433 и 5800 на xA4 принимаются", plOk.ok && plOk.playlist.steps.length === 2);
  if (plOk.ok) {
    const patch = playlistStepPatch(plOk.playlist.steps[0]);
    check("шаг не стартует ARM", patch.reason.includes("Старт не нажат") && patch.fpgaAirBwMhz === "2");
    check("коридор шага = взгляд вокруг центра", Number(patch.sdrF1) < 433 && Number(patch.sdrF2) > 433);
  }
  const plWave = parsePlaylistJson(`{"name":"x","steps":[{"centerMhz":915,"lookMhz":2,"dwellMs":1,"wave":"no-such"}]}`);
  check("чужая волна playlist — отказ", plWave.ok === false);
  const fromFields = buildPlaylist({
    name: "поля",
    steps: [{ name: "u", centerMhz: 433, lookMhz: 2, dwellMs: 0.4, wave: "awgn" }],
  });
  check("buildPlaylist без строки JSON", fromFields.ok && fromFields.playlist.steps[0].centerMhz === 433);
  check("пустые шаги — отказ", buildPlaylist({ name: "x", steps: [] }).ok === false);
  check(
    "пресеты 433/2442/5800 в RX xA4",
    LAB_PLAYLIST_PRESETS.length === 3 &&
      LAB_PLAYLIST_PRESETS.every((p) => p.centerMhz >= XA4_RX_MHZ[0] && p.centerMhz <= XA4_RX_MHZ[1]),
  );
  const fromScan = playlistStepFromScanner({
    signalFreqMhz: "2442.000",
    sdrF1: "2400",
    sdrF2: "2500",
    fpgaAirBwMhz: "2",
    scanWindowMhz: "20",
    fpgaTurnDwellMs: "3000",
    scanDwellMs: "40",
    txWaveKind: "tone",
  });
  check(
    "шаг со сканера копирует уже выставленное",
    fromScan.centerMhz === 2442 && fromScan.lookMhz === 2 && fromScan.dwellMs === 3000 && fromScan.wave === "tone",
  );

  const journal = buildLabJournal({
    f1: 100,
    f2: 6000,
    baselineTargetSec: 120,
    baselineFrozen: false,
    coverage: 0.25,
    events: logged,
    iperf: iperfOk.ok ? iperfOk.record : null,
    bper: bper.ok ? bper.record : null,
    jsr: jsr.ok ? jsr.record : null,
    playlist: plOk.ok ? plOk.playlist : null,
    knownMhz: [433],
    ignoreMhz: [],
  });
  check("журнал STA/SMA FAIL-closed", journal.staSma === "FAIL-closed");
  check("журнал не пишет PASS", !JSON.stringify(journal).includes("PASS"));
  check("устройство журнала — xA4", journal.device === "bladerf-micro-xa4");

  const holds = resetLabHolds(afterFreeze);
  check("сброс hold чистит peak, не ось", holds.peakHold.every((b) => !finiteDbm(b.powerDbm)) && holds.composite.length > 0);
  const frozen = freezeLabBaseline(startLabBaseline(emptyLabPsd(), 10));
  check("ручной freeze без 120 с честен", frozen.baselineFrozen === true && frozen.baselineStartedMs === 10);

  const L = () => useLegion.getState();
  L().clearLabJournal();
  L().setLabKnown("433 915");
  L().setLabIgnore("2442");
  check("store known/ignore парсятся", L().labKnownMhz.length === 2 && L().labIgnoreMhz[0] === 2442);
  const applied = L().applyPlaylist({
    name: "store",
    steps: [{ name: "u", centerMhz: 3500, lookMhz: 8, dwellMs: 0.4, wave: "qpsk" }],
  });
  check("store playlist полями без ARM", applied === true && L().fpgaArmed === false && L().scanPattern !== undefined);
  check("store шаг выставил взгляд 8", L().fpgaAirBwMhz === "8" && L().signalFreqMhz === "3500.000");
  L().stopScan();
  useLegion.setState({
    scanPattern: "auto",
    sdrEmulation: true,
    sdrLoadOk: true,
    rfOn: false,
    paOn: false,
    fpgaArmed: false,
    signalTxActive: false,
    flashBusy: false,
  });
  L().startScan();
  await new Promise((r) => setTimeout(r, 40));
  check("хост-скан поднялся в эмуляции", L().scanRunning === true);
  check("старт скана сбрасывает калибровку шпор (pavsa new SpurFilter на sweep)", L().labSpurReady === false);
  const again = L().applyPlaylistJson(
    JSON.stringify({ name: "re", steps: [{ name: "u", centerMhz: 915, lookMhz: 4, dwellMs: 1 }] }),
  );
  await new Promise((r) => setTimeout(r, 40));
  check(
    "playlist в живом скане перезапускает walker на новую ось",
    again && L().scanRunning === true && L().sdrF1 === "913.000" && L().sdrF2 === "917.000",
  );
  L().stopScan();
  L().setLabIperfJson(JSON.stringify({ end: { sum: { lost_percent: 1.2, bytes: 9 } } }));
  check("store iperf записан", L().labIperf?.lostPercent === 1.2 && L().labIperf?.bytes === 9);
  L().setLabBper(10, 2);
  check("store BPER 2/12", L().labBper?.bper === 2 / 12);
  L().setLabJsr({ jsr: 5, eSig: 2 });
  check("store JSR Pj=10", L().labJsr?.pJ === 10);
  const file = L().exportLabJournal();
  check("export не PASS", file.staSma === "FAIL-closed" && file.device === "bladerf-micro-xa4");

  check("hop после crop = 20, не analog 56", hostPaintSpanMhz(56) === 20);
  check("cropPsdBins как soapy half", cropPsdBins(["a", "b", "c", "d", "e", "f", "g", "h"]).join() === "c,d,e,f");

  const spur = new SpurFilter(6, 4, 4, 8);
  const spurFloor = Array.from({ length: 32 }, (_, i) => ({ freqMhz: 2400 + i, powerDbm: -90 }));
  const spiked = spurFloor.map((b, i) => (i === 16 ? { ...b, powerDbm: -40 } : b));
  for (let i = 0; i < 8; i++) spur.filter(spiked);
  check("шпора калибруется за validIterations", spur.isCalibrated() === true);
  const cleaned = spur.filter(spiked);
  check("после калибровки стабильная шпора снята", (cleaned[16].powerDbm ?? 0) < -70);
  const moving = new SpurFilter(6, 4, 4, 8);
  for (let i = 0; i < 8; i++) {
    moving.filter(spurFloor.map((b, j) => (j === 16 ? { ...b, powerDbm: -40 - i * 2 } : b)));
  }
  const jittered = moving.filter(spiked);
  check("дрожащий пик > jitter не шпора", (jittered[16].powerDbm ?? 0) > -50);

  const rtsa = new PersistentDisplay(32, 16, 5);
  const row = Array.from({ length: 32 }, (_, i) => ({ freqMhz: 2400 + i, powerDbm: i === 8 ? -40 : -90 }));
  for (let t = 0; t < 12; t++) rtsa.push(row, -120, -20, t * 100);
  rtsa.push(row, -120, -20, RTS_CALIBRATE_MS + 200);
  const pix = new Uint8ClampedArray(32 * 16 * 4);
  rtsa.renderRgba(pix);
  check("RTSA после калибровки не пустой", pix.some((v) => v > 0));

  check("EFIS таблица не пустая (pavsa europe ∩ xA4)", FREQ_EUROPE_XA4.length > 50);
  check("ISM 2400 есть в EFIS", !!allocAtMhz(2442));
  check("bandsInSpan 2400–2500 не пустой", bandsInSpan(2400, 2500).length > 0);
  check("вне таблицы — null", allocAtMhz(12) == null);

  L().setLabShowRtsa(false);
  L().setLabShowAlloc(false);
  L().setLabSpurOn(false);
  check("store тумблеры RTSA/EFIS/шпоры", L().labShowRtsa === false && L().labShowAlloc === false && L().labSpurOn === false);
  const noHost = await L().runLabIperf();
  check("iperf без хоста — отказ, не 80 %", noHost === false && (L().labIperf == null || L().labIperf.lostPercent !== 80));

  console.log(failures === 0 ? "\nLAB: ALL PASS" : `\nLAB: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
