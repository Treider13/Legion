// ============================================================================
// LEGION — хостовые тесты фазы 11: каталог SDR, прошивка, allowlist, скан, CUE.
// Запуск: npx tsx scripts/test_orchestrator.ts
// ============================================================================
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { cueFreqAllowed, hzInAllowlist, parseBand, paCurrentInRange } from "../src/policy/allowlist";
import { detectFromBins, estimateNoiseFloor, hostScanSpanMhz, MockSdrBackend, SDR_TX_US } from "../src/sdr/backend";
import { SDR_CATALOG, catalogById, soapyRemoteArgs } from "../src/sdr/catalog";
import { envMatchesChip, parseEsp32Chip, planEsp32Flash, usableSerialPort } from "../src/flash/esp32";
import { inspectSdrWrite, planSdrWrite } from "../src/flash/sdrWrite";
import { looksLikeEsp32Firmware, looksLikeSdrFirmware, refuseCrossFlash } from "../src/flash/guard";
import {
  LEGION_BOARDS,
  classifyLegionRbf,
  legionBoardFor,
  planLegionBuild,
  planLegionFlashGateway,
  planLegionFlashLocal,
} from "../src/flash/legionCustom";
import { classifyFirmware, validateFlashJob } from "../src/sdr/firmware";
import { planFlashCli } from "../src/sdr/flashcli";
import { flashFileRequired, hostOpenAllowed, usableImagePath } from "../src/sdr/host";
import { markCatalogPresent } from "../src/sdr/hostClient";
import {
  WAVE_CATALOG,
  clampParams,
  constellationPoints,
  defaultParams,
  previewWaveform,
  spectrumDb,
} from "../src/sdr/waveforms";
import { defaultFlashName, defaultEthHost, imagesFor, planEthernet, sdrOpenArgs } from "../src/sdr/official";
import { fpgaBoardPlan, fpgaGatewayRefused, fpgaLegionMissing, fpgaPlayerReady, peekFpgaAirGen, peekFpgaArmGen, peekFpgaSoloGen, pokeLastKickOkMs, useLegion } from "../src/state/store";
import { firmwareDoesTask, firmwareFileDoesTask, rejectAlienFirmware } from "../src/sdr/task";
import { HandoffGate, planHandoff } from "../src/sense/fastpath";
import {
  FPGA_DEFAULT_DET_THR,
  FPGA_DET_THR_FLOOR,
  FPGA_US_DET_SHIFT,
  clampDetShift,
  detThrFromMedian,
  detectorWindowUs,
  fpgaArmCmd,
  fpgaObserveLine,
  fpgaTurnDwellClamp,
  FPGA_TURN_DWELL_DEFAULT_MS,
  FPGA_TURN_DWELL_MIN_MS,
  fpgaTurnDwellUs,
  airTractParams,
  airFsHz,
  airThrTable,
  captureParkMhz,
  clampAirBwMhz,
  detCaptureWindows,
  handoffRetryMs,
  handoffSkipAfter,
  handoffTimeline,
  ncoFtwFromFrac,
  parkSpanMhz,
  planFpgaAir,
  planOnboardIntercept,
} from "../src/sense/fpgaFastpath";
import {
  FPGA_SOLO_FS_MIN_HZ,
  FPGA_SOLO_MICRO_ANALOG_MHZ,
  airHopBlockedReason,
  clampSoloAnalogMhz,
  clampSoloDwellMs,
  makeSoloWalker,
  planFpgaSoloWalk,
  soloFsHz,
  soloHopAllowed,
  soloHopBlockedReason,
  SOLO_HOP_MICRO_ONLY,
  soloParkOpts,
  standingWordRu,
  soloTuneCmd,
  waveFillsSoloWindow,
} from "../src/sense/fpgaSoloWalk";
import { cinemaIsLive, runCinemaStop, runSmartStart } from "../src/components/cinema/run";
import { coolingWarn, heroStatusLine } from "../src/components/cinema/status";
import {
  heldHitAlive,
  nextAfterOperatorReset,
  pickArmedAutoTarget,
  pickPriorityTarget,
  pickTurnTarget,
  refreshSkipMhz,
  RESENSE_MS,
  shouldContinuePriorityTick,
  uniqueBins,
  windowCoversMhz,
} from "../src/sense/hold";
import { sensitivityToThresholdDb, thresholdToSensitivity } from "../src/sense/sensitivity";
import {
  autoDispatchLabelRu,
  autoDispatchOptionRu,
  autoForwardAllowed,
  bandListFor,
  isFpgaAirLive,
  isFpgaAirPattern,
  isFpgaTaskLive,
  isFpgaTaskMode,
  modeConflict,
  modeOf,
  patternLabelRu,
  patternOptionRu,
  planSdrWork,
  runIntentArmsTx,
  scanRefusedReason,
  scannerParticipates,
  shouldKeepTransmit,
  walkPatternArmsTx,
} from "../src/sense/modes";
import {
  decideCue,
  decideForward,
  decideSdrTx,
  markForwarded,
  mergeDetections,
  pickStrongest,
  sameBin,
  withoutOwnTx,
} from "../src/sense/orchestrator";
import {
  AllowlistScanner,
  clampDwellMs,
  clampWindowMhz,
  clipToAllowlist,
  hopCenterInBand,
  mulberry32,
  planCenters,
  scanHopMhz,
  scanTickMs,
  ScanWalker,
} from "../src/sense/scan";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures++;
  }
}

async function main(): Promise<void> {
  check("каталог содержит xA4", SDR_CATALOG.some((e) => e.id === "bladerf-micro-xa4"));
  const xa4 = SDR_CATALOG.find((e) => e.id === "bladerf-micro-xa4");
  check("xA4 без нативного Ethernet (Nuand USB3)", xa4?.nativeEthernet === false && xa4.iface === "usb3");
  const n210 = SDR_CATALOG.find((e) => e.id === "usrp-n210");
  check("N210 с нативным Ethernet (Ettus KB)", n210?.nativeEthernet === true && n210.iface === "ethernet");
  check("RTL только RX", SDR_CATALOG.find((e) => e.id === "rtl-sdr")?.role === "rx");
  check("xA4 analog BW 56 (Nuand)", xa4?.analogBwMhz === 56 && xa4.fullDuplex === true);
  check(
    "HackRF half-duplex 20 МГц",
    SDR_CATALOG.find((e) => e.id === "hackrf-one")?.fullDuplex === false &&
      SDR_CATALOG.find((e) => e.id === "hackrf-one")?.analogBwMhz === 20,
  );
  check("RTL analog BW 2.4", SDR_CATALOG.find((e) => e.id === "rtl-sdr")?.analogBwMhz === 2.4);

  check(
    "SoapyRemote args",
    soapyRemoteArgs("10.0.0.5") === "driver=remote,remote=tcp://10.0.0.5:55132",
  );
  check("пустой шлюз → пустая строка", soapyRemoteArgs("  ") === "");
  check(
    "xA4 Ethernet = SoapyRemote на шлюз",
    sdrOpenArgs("bladerf-micro-xa4", "10.0.0.5") === "driver=remote,remote=tcp://10.0.0.5:55132",
  );
  check(
    "N210 Ethernet = UHD в плату",
    sdrOpenArgs("usrp-n210", "192.168.10.2") === "driver=uhd,type=usrp2,addr=192.168.10.2",
  );
  check(
    "Pluto Ethernet = hostname ADI",
    sdrOpenArgs("plutosdr", "192.168.2.1") === "driver=plutosdr,hostname=192.168.2.1",
  );
  check("пустой host xA4 → driver=bladerf (не enumerate[0])", sdrOpenArgs("bladerf-micro-xa4", "") === "driver=bladerf");
  check("пустой host x40 → driver=bladerf", sdrOpenArgs("bladerf-x40", "") === "driver=bladerf");
  check("пустой host HackRF → driver=hackrf", sdrOpenArgs("hackrf-one", "") === "driver=hackrf");
  check("FPGA x40 без смены", fpgaBoardPlan("bladerf-x40").ok && !fpgaBoardPlan("bladerf-x40").switched);
  check("FPGA micro xA4 как сама (без подмены)", fpgaBoardPlan("bladerf-micro-xa4").ok && fpgaBoardPlan("bladerf-micro-xa4").sdrId === "bladerf-micro-xa4");
  check("FPGA micro xA9 как сама", fpgaBoardPlan("bladerf-micro-xa9").ok && !fpgaBoardPlan("bladerf-micro-xa9").switched);
  check("FPGA HackRF отказ, каталог не трогаем", !fpgaBoardPlan("hackrf-one").ok && fpgaBoardPlan("hackrf-one").sdrId === "hackrf-one");
  check("FPGA Pluto отказ", !fpgaBoardPlan("plutosdr").ok);
  check("шлюз ok не FAKE", fpgaGatewayRefused({ ok: true, fake: false }) === null);
  check("шлюз FAKE → отказ", (fpgaGatewayRefused({ ok: true, fake: true }) ?? "").includes("FAKE"));
  check("шлюз мёртв → отказ", fpgaGatewayRefused({ ok: false, reason: "down" }) === "down");
  check("player capture_done → можно ARM", fpgaPlayerReady({ ok: true, capture_done: true }) === null);
  check("player без capture_done → отказ", (fpgaPlayerReady({ ok: true, capture_done: false }) ?? "").includes("в памяти нет волны"));
  check("отказ player без сырого ключа capture_done (аудит P1-6)",
    !((fpgaPlayerReady({ ok: true, capture_done: false }) ?? "").includes("capture_done")));
  check("player статус мёртв → отказ", fpgaPlayerReady({ ok: false, reason: "usb" }) === "usb");
  check("кабель xA4 = шлюз", planEthernet("bladerf-micro-xa4", "1.2.3.4").cable === "gateway-rj45");
  check("кабель N210 = RJ45 в SDR", planEthernet("usrp-n210", "").cable === "sdr-rj45");
  check("кабель Pluto = usb-gadget", planEthernet("plutosdr", "").cable === "usb-gadget");
  check("дефолт N210 192.168.10.2", defaultEthHost("usrp-n210") === "192.168.10.2");
  check("дефолт образ xA4 hosted", defaultFlashName("bladerf-micro-xa4") === "hostedxA4.rbf");
  check("LimeNET в каталоге", SDR_CATALOG.some((e) => e.id === "limenet-micro" && e.nativeEthernet));

  check("hostedxA4.rbf → fpga-a4", classifyFirmware("hostedxA4.rbf") === "fpga-a4");
  check("hostedxA4-latest.rbf → fpga-a4", classifyFirmware("hostedxA4-latest.rbf") === "fpga-a4");
  check("bladeRF.img → fx3", classifyFirmware("bladeRF.img") === "fx3");
  check("bladeRF_fw_latest.img → fx3", classifyFirmware("bladeRF_fw_latest.img") === "fx3");
  check("pluto.frm → pluto-frm", classifyFirmware("pluto.frm") === "pluto-frm");
  check("usrp_n210_r4_fpga.bin", classifyFirmware("usrp_n210_r4_fpga.bin") === "uhd-n210-fpga");
  check(
    "A9-образ на xA4 отклонён",
    validateFlashJob({
      deviceId: "bladerf-micro-xa4",
      filename: "hostedxA9.rbf",
      byteLength: 100,
      action: "flash-fpga",
    }).ok === false,
  );
  check(
    "A4-образ на xA4 принят",
    validateFlashJob({
      deviceId: "bladerf-micro-xa4",
      filename: "hostedxA4.rbf",
      byteLength: 100,
      action: "load-fpga",
    }).ok === true,
  );
  check(
    "FX3 действие на .rbf отклонён",
    validateFlashJob({
      deviceId: "bladerf-micro-xa4",
      filename: "hostedxA4.rbf",
      byteLength: 100,
      action: "flash-fx3",
    }).ok === false,
  );
  check(
    "пустой файл отклонён",
    validateFlashJob({
      deviceId: "bladerf-micro-xa4",
      filename: "hostedxA4.rbf",
      byteLength: 0,
      action: "load-fpga",
    }).ok === false,
  );
  check(
    "RTL не прошивается",
    validateFlashJob({
      deviceId: "rtl-sdr",
      filename: "hostedxA4.rbf",
      byteLength: 10,
      action: "load-fpga",
    }).ok === false,
  );
  check(
    "pluto.frm на Pluto принят",
    validateFlashJob({
      deviceId: "plutosdr",
      filename: "pluto.frm",
      byteLength: 100,
      action: "flash-fpga",
    }).ok === true,
  );
  check(
    "pluto.frm на xA4 отклонён",
    validateFlashJob({
      deviceId: "bladerf-micro-xa4",
      filename: "pluto.frm",
      byteLength: 100,
      action: "flash-fpga",
    }).ok === false,
  );
  check(
    "N210 FPGA принят",
    validateFlashJob({
      deviceId: "usrp-n210",
      filename: "usrp_n210_r4_fpga.bin",
      byteLength: 100,
      action: "flash-fpga",
    }).ok === true,
  );
  check(
    "B210 ручная прошивка отклонена (UHD autoload)",
    validateFlashJob({
      deviceId: "usrp-b210",
      filename: "hostedxA4.rbf",
      byteLength: 100,
      action: "load-fpga",
    }).ok === false,
  );

  const ism = [{ f1Mhz: 2400, f2Mhz: 2500 }];
  check("пустой allowlist не режет SET FREQ", hzInAllowlist(915, []) === true);
  check("CUE без полос запрещён", cueFreqAllowed(2475, []) === false);
  check("CUE в ISM разрешён", cueFreqAllowed(2475, ism) === true);
  check("CUE вне ISM запрещён", cueFreqAllowed(433, ism) === false);
  check("parseBand 2400-2500", parseBand("2400", "2500")?.f2Mhz === 2500);
  check("parseBand 5000 отклонён", parseBand("2400", "5000") === null);
  check("ток 1500 ок", paCurrentInRange(1500));
  check("ток 1501 нет", paCurrentInRange(1501) === false);

  const sdr = new MockSdrBackend();
  check("probe ≥ 8", sdr.probe().length >= 8);
  const open = sdr.open("bladerf-micro-xa4", soapyRemoteArgs("192.168.1.20"));
  check("open xA4", open.ok && (sdr.opened()?.id === "bladerf-micro-xa4"));
  check("remote сохранён", sdr.remoteArgs().includes("192.168.1.20"));
  const flash = sdr.flash({
    deviceId: "bladerf-micro-xa4",
    filename: "hostedxA4.rbf",
    byteLength: 2048,
    action: "flash-fpga",
  });
  check("flash mock A4 не врёт про запись", flash.ok === false && flash.written === false);
  check("validate того же образа ок", validateFlashJob({
    deviceId: "bladerf-micro-xa4",
    filename: "hostedxA4.rbf",
    byteLength: 2048,
    action: "flash-fpga",
  }).ok === true);

  sdr.injectTone(2442, -35);
  const bins = sdr.scanWindow(2442, 20, 64);
  const dets = detectFromBins(bins, 12);
  check("energy detection ловит несущую", dets.some((d) => Math.abs(d.freqMhz - 2442) < 0.5));
  check(
    "пол = медиана нижних 60%",
    estimateNoiseFloor([
      { freqMhz: 1, powerDbm: -90 },
      { freqMhz: 2, powerDbm: -88 },
      { freqMhz: 3, powerDbm: -86 },
      { freqMhz: 4, powerDbm: -84 },
      { freqMhz: 5, powerDbm: -10 },
    ]) === -88,
  );
  check("хост FFT span = ADC 40, не analog 28", hostScanSpanMhz(28) === 40);
  check("хост FFT span xa4 тоже 40", hostScanSpanMhz(56) === 40);

  const centers = planCenters(ism, 20);
  check("план скана непустой", centers.length >= 5);
  check("центры внутри полосы", centers.every((c) => c >= 2400 && c <= 2500));

  const scanner = new AllowlistScanner(sdr, { bands: ism, bwMhz: 20, bins: 32, thresholdDb: 12 });
  let found = false;
  for (let i = 0; i < 20; i++) {
    const t = scanner.tick(1);
    if (t.detections.length) found = true;
    if (t.done) break;
  }
  check("сканер находит тон в allowlist", found);
  const tight = new AllowlistScanner(sdr, { bands: ism, bwMhz: 20, bins: 32, thresholdDb: 80, loop: true });
  const miss = tight.tick(1);
  tight.setThresholdDb(8);
  let afterSens = false;
  for (let i = 0; i < 20; i++) {
    if (tight.tick(1).detections.length) {
      afterSens = true;
      break;
    }
  }
  check("высокая строгость режет слабые", miss.detections.length === 0 || miss.detections.every((d) => d.snrDb >= 80));
  check("после снижения порога тон снова ловится", afterSens);

  const hit = dets[0];
  check("CUE без нагрузки запрещён", decideCue(hit, ism, false, true).ok === false);
  check("CUE без авто — ручной", decideCue(hit, ism, true, false).ok === false);
  check("CUE авто+нагрузка+полоса", decideCue(hit, ism, true, true).ok === true);
  check("pickStrongest", pickStrongest(dets)?.powerDbm === Math.max(...dets.map((d) => d.powerDbm)));
  check("forward без тока запрещён", decideForward(hit, ism, true, true, 0).ok === false);
  check("forward с током и ПЕРЕДАТЬ", decideForward(hit, ism, true, true, 250).ok === true);
  check("sameBin 0.1 МГц", sameBin(2442.0, 2442.05));
  const merged = mergeDetections([], dets);
  const marked = markForwarded(merged, dets[0].freqMhz);
  check("markForwarded красит попадание", marked.some((x) => x.forwarded));
  check("markForwarded не красит чужое", marked.filter((x) => !sameBin(x.freqMhz, dets[0].freqMhz)).every((x) => !x.forwarded) || marked.length === 1);

  const hop56 = planCenters(ism, scanHopMhz(56));
  check("ISM 100 МГц / 56 МГц → 2 стойки, не 5", hop56.length === 2);
  check(
    "полоса ≤ BW → одна стойка (ice9 park)",
    planCenters([{ f1Mhz: 2440, f2Mhz: 2448 }], 56).length === 1,
  );
  check("тик parked 16 мс", scanTickMs(1) === 16);
  check("тик hop 40 мс", scanTickMs(2) === 40);
  check("окно 1 МГц не режется", clampWindowMhz(1, 56) === 1);
  check("окно 20 МГц на xA4", clampWindowMhz(20, 56) === 20);
  check("окно 100 режется analog BW", clampWindowMhz(100, 56) === 56);
  check("выдержка 0.3 мс → 1 мс (хост, не FPGA)", clampDwellMs(0.3) === 1);
  check("выдержка 10 мс не режется до 16", clampDwellMs(10) === 10);
  const sweepW = new ScanWalker({
    bands: ism,
    pattern: "sweep",
    windowMhz: 20,
    analogBwMhz: 56,
    dwellMs: 40,
  });
  const sweepPath = Array.from({ length: 12 }, () => sweepW.next().centerMhz);
  const hi = Math.max(...sweepW.centers);
  const lo = Math.min(...sweepW.centers);
  const hitHi = sweepPath.indexOf(hi);
  const afterHi = hitHi >= 0 ? sweepPath.slice(hitHi + 1, hitHi + 4) : [];
  check("качание (реверс) доходит до края", hitHi >= 0);
  check("sweep после края идёт назад", afterHi.some((c) => c < hi));
  check("sweep не вылезает из полосы", sweepPath.every((c) => c >= lo && c <= hi));
  const bandW = new ScanWalker({
    bands: [{ f1Mhz: 2440, f2Mhz: 2448 }],
    pattern: "band",
    windowMhz: 20,
    analogBwMhz: 56,
  });
  check("сплошная узкая полоса — одна стойка", bandW.centers.length === 1);
  const hopW = new ScanWalker({
    bands: ism,
    pattern: "hop",
    windowMhz: 1,
    analogBwMhz: 56,
    dwellMs: 80,
    seed: 7,
  });
  check("случайная выдержка 80 мс", hopW.tickMs === 80);
  const hops = Array.from({ length: 20 }, () => hopW.next().centerMhz);
  check(
    "случайные центры внутри полосы",
    hops.every((c) => c >= 2400 && c <= 2500) && new Set(hops.map((c) => c.toFixed(3))).size > 3,
  );
  const rng = mulberry32(1);
  const hc = hopCenterInBand(ism, 20, rng);
  check("hop 20 МГц не на самом краю полосы", hc > 2400 && hc < 2500);

  const edgeTone = new MockSdrBackend();
  edgeTone.open("bladerf-micro-xa4");
  edgeTone.injectTone(2435, -30);
  const raw = detectFromBins(edgeTone.scanWindow(2442, 20, 64), 12);
  const clipped = clipToAllowlist(raw, [{ f1Mhz: 2440, f2Mhz: 2444 }]);
  check("сырой скан видит край окна", raw.some((d) => d.freqMhz < 2440));
  check("clipToAllowlist режет край", clipped.every((d) => d.freqMhz >= 2440 && d.freqMhz <= 2444));

  const tx = sdr.txCue(2442);
  check("xA4 txCue ok", tx.ok && tx.path === "sdr-tx" && tx.latencyUs === SDR_TX_US.usb3);
  check("lastTx после cue", sdr.lastTxMhz() === 2442);
  const rtl = new MockSdrBackend();
  rtl.open("rtl-sdr");
  check("RTL txCue отказ", rtl.txCue(100).ok === false && rtl.canTx() === false);

  check("вкладка scan = режим SDR", modeOf("scan") === "sdr");
  check("вкладка sdrFlash = режим SDR", modeOf("sdrFlash") === "sdr");
  check("вкладка corridor = режим ESP32", modeOf("corridor") === "esp32");
  check("вкладка pa = режим ESP32", modeOf("pa") === "esp32");
  check("вкладка esp32Flash = режим ESP32", modeOf("esp32Flash") === "esp32");
  check("скан пишет sdrBands, не allowBands", bandListFor("sdr") === "sdrBands");
  check("ESP32 пишет allowBands, не sdrBands", bandListFor("esp32") === "allowBands");
  check("конфликт: коридор при SDR TX", modeConflict("esp32", false, true) !== null);
  check("конфликт: SDR при коридоре", modeConflict("sdr", true, false) !== null);
  check("нет конфликта", modeConflict("sdr", false, false) === null);
  check("конфликт: ESP32 при FPGA ARM", modeConflict("esp32", false, false, true) !== null);
  check("конфликт FPGA: текст про ОСТАНОВИТЬ FPGA", (modeConflict("esp32", false, false, true) ?? "").includes("FPGA"));
  check("обход полосы сам TX не включает", walkPatternArmsTx() === false);
  check("авто — сканер участвует", scannerParticipates("auto") === true);
  check("случайная — сканер не участвует", scannerParticipates("hop") === false);
  check("сплошная — сканер не участвует", scannerParticipates("band") === false);
  check("planSdrWork авто: сканер, не open-loop", planSdrWork("auto").useScanner && !planSdrWork("auto").openLoopTx);
  check("planSdrWork hop: Ethernet TX, без сканера", planSdrWork("hop").openLoopTx && !planSdrWork("hop").useScanner);
  check("planSdrWork качание: Ethernet TX, без сканера", planSdrWork("sweep").openLoopTx && !planSdrWork("sweep").useScanner);
  check("planSdrWork сплошная: Ethernet TX, без сканера", planSdrWork("band").openLoopTx && !planSdrWork("band").useScanner);
  check("имя sweep = КАЧАНИЕ, не туда-сюда", patternLabelRu("sweep") === "КАЧАНИЕ");
  check("опция качания без туда-сюда", !patternOptionRu("sweep").toLowerCase().includes("туда"));
  check("СКАНИРОВАТЬ в АВТО можно", scanRefusedReason("auto") === null);
  check("FPGA+сканер стартует (не хост-FFT)", scanRefusedReason("fpga") === null);
  check("онбордовый перехват: хост-сканер не в круге", scannerParticipates("fpga") === false);
  check("автоперехват имя", patternLabelRu("fpga") === "АВТОПЕРЕХВАТ");
  check("isFpgaAirPattern", isFpgaAirPattern("fpga") && !isFpgaAirPattern("auto"));
  check("FPGA без сканера = player/nco/always", isFpgaTaskMode("player") && isFpgaTaskMode("nco") && isFpgaTaskMode("lb_always"));
  check("lb_gated не задача с ноутбука", isFpgaTaskMode("lb_gated") === false);
  check("меню FPGA+СКАНЕР ≠ живой конвейер", isFpgaAirLive(false, "lb_gated") === false);
  check("живой конвейер только lb_gated+ARM", isFpgaAirLive(true, "lb_gated") && !isFpgaAirLive(true, "player"));
  check("PLAYER+ARM = задача, не сканер", isFpgaTaskLive(true, "player") && !isFpgaAirLive(true, "player"));
  check("без ARM нет живой задачи", isFpgaTaskLive(false, "player") === false);
  const fpgaWork = planSdrWork("fpga");
  check("planSdrWork FPGA: плата смотрит эфир, хост-сканер не в круге",
    fpgaWork.useFpgaAir && !fpgaWork.useScanner && !fpgaWork.openLoopTx);
  check("planSdrWork FPGA: USB не в круге увидел→усилитель", fpgaWork.reason.includes("USB не в круге"));
  check("СКАНИРОВАТЬ в качании отказано", (scanRefusedReason("sweep") ?? "").includes("КАЧАНИЕ"));
  check(
    "пустой эфир не стопает АВТО",
    shouldKeepTransmit({ operatorArmed: true, liveEmpty: true }) === true,
  );
  check(
    "конец прохода walker не стопает качание",
    shouldKeepTransmit({ operatorArmed: true, walkerFinished: true }) === true,
  );
  check("без ПЕРЕДАТЬ процесс не живёт", shouldKeepTransmit({ operatorArmed: false, liveEmpty: true }) === false);
  check("авто reason — до стопа оператора", planSdrWork("auto").reason.includes("пока оператор не стопнет"));
  check("качание reason — Ethernet до стопа", planSdrWork("sweep").reason.includes("пока оператор не стопнет"));
  check("обычный АВТО по очереди", planSdrWork("auto", "turn").reason.includes("по очереди"));
  check("приоритет АВТО держим", planSdrWork("auto", "priority").reason.includes("держим"));
  check("имя обычного АВТО", autoDispatchLabelRu("turn") === "ОБЫЧНЫЙ");
  check("имя приоритета", autoDispatchLabelRu("priority") === "ПРИОРИТЕТ");
  check("опция обычного про выдержку", autoDispatchOptionRu("turn").includes("очереди"));
  const autoW = new ScanWalker({ bands: ism, pattern: "auto", windowMhz: 20, analogBwMhz: 56, seed: 1 });
  const sweepEq = new ScanWalker({ bands: ism, pattern: "sweep", windowMhz: 20, analogBwMhz: 56, seed: 1 });
  check(
    "авто-поиск RX ходит как sweep, не как случайный TX",
    Array.from({ length: 5 }, () => autoW.next().centerMhz).join(",") ===
      Array.from({ length: 5 }, () => sweepEq.next().centerMhz).join(","),
  );
  check("слушать антенну ≠ ПЕРЕДАТЬ", runIntentArmsTx("listen") === false);
  check("ПЕРЕДАТЬ включает авто на усилитель", runIntentArmsTx("transmit") === true);
  check(
    "без ПЕРЕДАТЬ засечка на усилитель не идёт",
    autoForwardAllowed({ transmitArmed: false, loadOk: true, sdrCanTx: true }) === false,
  );
  check(
    "ПЕРЕДАТЬ + нагрузка + TX → авто",
    autoForwardAllowed({ transmitArmed: true, loadOk: true, sdrCanTx: true }) === true,
  );
  check(
    "ПЕРЕДАТЬ без нагрузки нельзя",
    autoForwardAllowed({ transmitArmed: true, loadOk: false, sdrCanTx: true }) === false,
  );

  const det = { freqMhz: 2442, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: false };
  check("SDR TX без тока ESP32 разрешён", decideSdrTx(det, ism, true, true).ok === true);
  const live = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    lastCuedMhz: null,
    inflight: false,
    sdrCanTx: true,
  });
  check(
    "режим SDR: только sdrTx, полей CUE/PA/RF в плане нет",
    live.skip === false &&
      live.sdrTx &&
      !("cue" in live) &&
      !("paSetI" in live) &&
      !("paOn" in live) &&
      !("rfOn" in live),
  );
  const noArm = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: false,
    lastCuedMhz: null,
    inflight: false,
    sdrCanTx: true,
  });
  check("без ПЕРЕДАТЬ SDR не излучает", noArm.skip && !noArm.sdrTx);
  const same = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    lastCuedMhz: 2442.05,
    inflight: false,
    sdrCanTx: true,
  });
  check("тот же бин не шлёт повторный SDR TX", same.skip);
  const busy = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    lastCuedMhz: 2410,
    inflight: true,
    sdrCanTx: true,
  });
  check("inflight не плодит второй TX", busy.skip);
  const noTx = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    lastCuedMhz: null,
    inflight: false,
    sdrCanTx: false,
  });
  check("RTL без TX не идёт в усилитель", noTx.skip);
  const holdSkip = planHandoff({
    det: { ...det, freqMhz: 2480 },
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    lastCuedMhz: 2442,
    inflight: false,
    sdrCanTx: true,
    holdLock: true,
  });
  check("holdLock не прыгает на другую засечку", holdSkip.skip && holdSkip.reason.includes("держим"));
  const autoHop = planHandoff({
    det: { ...det, freqMhz: 2480, powerDbm: -30 },
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    lastCuedMhz: 2442,
    inflight: false,
    sdrCanTx: true,
  });
  check("авто: чуть сильнее сразу на усилитель", autoHop.skip === false && autoHop.freqMhz === 2480);
  const forceHop = planHandoff({
    det: { ...det, freqMhz: 2480 },
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    lastCuedMhz: 2442,
    inflight: false,
    sdrCanTx: true,
    holdLock: true,
    forceRetarget: true,
  });
  check("СБРОСИТЬ / forceRetarget пускает другую частоту", forceHop.skip === false && forceHop.freqMhz === 2480);

  check("чувствительность 0 → порог 3 дБ (все подряд)", sensitivityToThresholdDb(0) === 3);
  check("чувствительность 100 → порог 24 дБ (только сильные)", sensitivityToThresholdDb(100) === 24);
  check("порог 12 ↔ ~43 на слайдере", thresholdToSensitivity(12) === 43);
  check("слайдер 43 → порог 12", Math.abs(sensitivityToThresholdDb(43) - 12) < 0.3);
  check("re-sense интервал 1 с", RESENSE_MS === 1000);
  check(
    "heldHitAlive видит свой бин",
    heldHitAlive(
      [{ freqMhz: 2442.05, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: true }],
      2442,
    ),
  );
  check(
    "heldHitAlive не врёт про чужой",
    heldHitAlive(
      [{ freqMhz: 2480, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: false }],
      2442,
    ) === false,
  );
  const archive = [
    { freqMhz: 2442, powerDbm: -20, noiseDbm: -90, snrDb: 70, ts: 1, forwarded: true },
    { freqMhz: 2480, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: false },
  ];
  check("СБРОСИТЬ не выбирает из архива", nextAfterOperatorReset(archive) === null);
  const three = [
    { freqMhz: 2410, powerDbm: -30, noiseDbm: -90, snrDb: 60, ts: 1, forwarded: false },
    { freqMhz: 2442, powerDbm: -10, noiseDbm: -90, snrDb: 80, ts: 1, forwarded: true },
    { freqMhz: 2480, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: false },
  ];
  check(
    "приоритет: сильнее рядом перехватывает",
    pickPriorityTarget(
      [
        { freqMhz: 2442, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: true },
        { freqMhz: 2447, powerDbm: -35, noiseDbm: -90, snrDb: 55, ts: 1, forwarded: false },
      ],
      2442,
    )?.freqMhz === 2447,
  );
  check(
    "приоритет: слабее не сбивает",
    pickPriorityTarget(
      [
        { freqMhz: 2442, powerDbm: -20, noiseDbm: -90, snrDb: 70, ts: 1, forwarded: true },
        { freqMhz: 2480, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: false },
      ],
      2442,
    ) === null,
  );
  check(
    "приоритет: свой TX скрыт — слабее не считаем пропавшей",
    pickPriorityTarget(
      [{ freqMhz: 2480, powerDbm: -50, noiseDbm: -90, snrDb: 40, ts: 1, forwarded: false }],
      2442,
      null,
      true,
      -20,
    ) === null,
  );
  check(
    "приоритет: свой TX скрыт — сильнее рядом перехватывает",
    pickPriorityTarget(
      [{ freqMhz: 2447, powerDbm: -25, noiseDbm: -90, snrDb: 65, ts: 1, forwarded: false }],
      2442,
      null,
      true,
      -40,
    )?.freqMhz === 2447,
  );
  check(
    "приоритет: равная мощность не перехватывает",
    pickPriorityTarget(
      [
        { freqMhz: 2442, powerDbm: -30, noiseDbm: -90, snrDb: 60, ts: 1, forwarded: true },
        { freqMhz: 2447, powerDbm: -30, noiseDbm: -90, snrDb: 60, ts: 1, forwarded: false },
      ],
      2442,
    ) === null,
  );
  check(
    "withoutOwnTx прячет 2442, 2447 остаётся",
    withoutOwnTx(
      [
        { freqMhz: 2442, powerDbm: -10, noiseDbm: -90, snrDb: 80, ts: 1, forwarded: true },
        { freqMhz: 2447, powerDbm: -25, noiseDbm: -90, snrDb: 65, ts: 1, forwarded: false },
      ],
      2442,
    ).every((d) => Math.abs(d.freqMhz - 2447) < 0.01) &&
      withoutOwnTx(
        [
          { freqMhz: 2442, powerDbm: -10, noiseDbm: -90, snrDb: 80, ts: 1, forwarded: true },
          { freqMhz: 2447, powerDbm: -25, noiseDbm: -90, snrDb: 65, ts: 1, forwarded: false },
        ],
        2442,
      ).length === 1,
  );
  check(
    "armed priority + mask: сильнее перехватывает",
    pickArmedAutoTarget({
      liveWindow: [{ freqMhz: 2447, powerDbm: -25, noiseDbm: -90, snrDb: 65, ts: 1, forwarded: false }],
      archive: [{ freqMhz: 2410, powerDbm: -5, noiseDbm: -90, snrDb: 85, ts: 1, forwarded: false }],
      heldMhz: 2442,
      heldPowerDbm: -40,
      skipMhz: null,
      dispatch: "priority",
      holdMasked: true,
    })?.freqMhz === 2447,
  );
  check(
    "armed priority + mask: архив не стомпит",
    pickArmedAutoTarget({
      liveWindow: [],
      archive: [{ freqMhz: 2410, powerDbm: -5, noiseDbm: -90, snrDb: 85, ts: 1, forwarded: false }],
      heldMhz: 2442,
      heldPowerDbm: -40,
      skipMhz: null,
      dispatch: "priority",
      holdMasked: true,
    }) === null,
  );
  check("после switch второй pick тика запрещён", shouldContinuePriorityTick("switch") === false);
  check("после gone тик может взять следующую", shouldContinuePriorityTick("gone") === true);
  check("после alive тик может украсть сильнее", shouldContinuePriorityTick("alive") === true);
  const walkerOnly = [
    { freqMhz: 2410, powerDbm: -30, noiseDbm: -90, snrDb: 60, ts: 1, forwarded: false },
  ];
  check(
    "факт стомпа: held=null на окне walker берёт 2410, не 2447",
    pickPriorityTarget(walkerOnly, null)?.freqMhz === 2410,
  );
  check(
    "поэтому switch не продолжает тик — иначе 2410 перебьёт 2447",
    shouldContinuePriorityTick("switch") === false,
  );
  check(
    "приоритет: пропала — берём следующую сильнейшую",
    pickPriorityTarget(
      [{ freqMhz: 2480, powerDbm: -30, noiseDbm: -90, snrDb: 60, ts: 1, forwarded: false }],
      2442,
    )?.freqMhz === 2480,
  );
  check(
    "приоритет: без замка берём сильнейший",
    pickPriorityTarget(
      [{ freqMhz: 2480, powerDbm: -30, noiseDbm: -90, snrDb: 60, ts: 1, forwarded: false }],
      null,
    )?.freqMhz === 2480,
  );
  check(
    "после сброса живое окно минус снятая",
    pickPriorityTarget(
      [
        { freqMhz: 2442, powerDbm: -10, noiseDbm: -90, snrDb: 80, ts: 2, forwarded: false },
        { freqMhz: 2410, powerDbm: -30, noiseDbm: -90, snrDb: 60, ts: 2, forwarded: false },
      ],
      null,
      2442,
    )?.freqMhz === 2410,
  );
  const q1 = pickTurnTarget(three, null, 2410, -30);
  const q2 = pickTurnTarget(three, null, q1?.freqMhz ?? 2410, q1?.powerDbm ?? 0);
  const q3 = pickTurnTarget(three, null, q2?.freqMhz ?? 2442, q2?.powerDbm ?? 0);
  check("очередь идёт по кругу трёх частот", q1?.freqMhz === 2442 && q2?.freqMhz === 2480 && q3?.freqMhz === 2410);
  check(
    "очередь одна частота — остаёмся на ней",
    pickTurnTarget(
      [{ freqMhz: 2442, powerDbm: -20, noiseDbm: -90, snrDb: 70, ts: 1, forwarded: true }],
      null,
      2442,
      -20,
    )?.freqMhz === 2442,
  );
  check(
    "очередь без замка стартует с сильнейшей",
    pickTurnTarget(three, null, null)?.freqMhz === 2442,
  );
  check("uniqueBins сливает соседние", uniqueBins(three.concat(three)).length === 3);
  const staleArchive = [
    { freqMhz: 2410, powerDbm: -5, noiseDbm: -90, snrDb: 85, ts: 1, forwarded: false },
  ];
  const liveNow = [
    { freqMhz: 2480, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 9, forwarded: false },
  ];
  check(
    "ПЕРЕДАТЬ не берёт сильный бин из архива",
    pickArmedAutoTarget({
      liveWindow: liveNow,
      archive: staleArchive,
      heldMhz: null,
      heldPowerDbm: null,
      skipMhz: null,
      dispatch: "priority",
    })?.freqMhz === 2480,
  );
  check(
    "пустое живое окно не хватает архив",
    pickArmedAutoTarget({
      liveWindow: [],
      archive: staleArchive,
      heldMhz: null,
      heldPowerDbm: null,
      skipMhz: null,
      dispatch: "turn",
    }) === null,
  );
  check("окно покрывает центр", windowCoversMhz(2442, 20, 2442));
  check("окно не покрывает чужую стойку", windowCoversMhz(2442, 20, 2480) === false);
  check(
    "сброс: частота жива в этом окне — skip держим",
    refreshSkipMhz(2442, liveNow.concat([{ freqMhz: 2442, powerDbm: -20, noiseDbm: -90, snrDb: 70, ts: 9, forwarded: false }]), 2442, 20) === 2442,
  );
  check(
    "сброс: в покрывающем окне частоты нет — skip снимаем",
    refreshSkipMhz(2442, liveNow, 2442, 20) === null,
  );
  check(
    "сброс: другое окно не снимает skip",
    refreshSkipMhz(2442, liveNow, 2480, 20) === 2442,
  );
  check(
    "сброс: нет бинов — skip не снимаем (half-duplex пауза)",
    refreshSkipMhz(2442, [], 2442, 20, false) === 2442,
  );
  check(
    "сброс: бины есть, засечки нет — skip снимаем, сигнал может вернуться",
    refreshSkipMhz(2442, [], 2442, 20, true) === null,
  );
  const hopA = new ScanWalker({ bands: ism, pattern: "hop", windowMhz: 1, analogBwMhz: 56, seed: 1 });
  const hopB = new ScanWalker({ bands: ism, pattern: "hop", windowMhz: 1, analogBwMhz: 56, seed: 99 });
  const seqA = Array.from({ length: 8 }, () => hopA.next().centerMhz);
  const seqB = Array.from({ length: 8 }, () => hopB.next().centerMhz);
  check("разный сид — разная случайная трасса", seqA.join(",") !== seqB.join(","));
  const gate = new HandoffGate();
  gate.reserve(2442);
  check("reserve не есть успех TX", gate.lastCuedMhz === null && gate.pendingMhz === 2442);
  check("queueIfBusy на том же pending не дублирует", gate.queueIfBusy(2442) === true && gate.queued === null);
  check("queueIfBusy ставит чуть сильнее в очередь", gate.queueIfBusy(2480, -35) === true && gate.queued?.mhz === 2480);
  check("очередь несёт мощность цели", gate.queued?.powerDbm === -35);
  gate.abort();
  check("abort снимает pending", gate.pendingMhz === null && gate.lastCuedMhz === null);
  gate.reserve(2442);
  gate.commit(2442);
  check("commit фиксирует TX", gate.lastCuedMhz === 2442);
  const rel = gate.release();
  check("release отдаёт очередь с мощностью", rel?.mhz === 2480 && rel?.powerDbm === -35 && gate.inflight === false);
  check("dropHold снимает замок", gate.dropHold() === 2442 && gate.lastCuedMhz === null);
  check(
    "свой тон не улов",
    withoutOwnTx(
      [
        { freqMhz: 2442, powerDbm: -20, noiseDbm: -90, snrDb: 70, ts: 1, forwarded: false },
        { freqMhz: 2480, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: false },
      ],
      2442,
    ).every((d) => Math.abs(d.freqMhz - 2442) > 0.5),
  );

  const loop = new AllowlistScanner(sdr, {
    bands: [{ f1Mhz: 2440, f2Mhz: 2444 }],
    bwMhz: 20,
    bins: 16,
    thresholdDb: 12,
    loop: true,
  });
  const t1 = loop.tick(1);
  const t2 = loop.tick(2);
  check("loop не останавливается", t1.done === false && t2.done === false && t2.centerMhz > 0);
  check("тик отдаёт бины спектра", t1.bins.length > 0);

  check("hosted A4 закрывает задачу RX+TX", firmwareDoesTask("fpga-a4", "bladerf-micro-xa4").ok);
  check("FX3 задачу не закрывает", firmwareDoesTask("fx3", "bladerf-micro-xa4").ok === false);
  check("RTL не TX", firmwareDoesTask("unknown", "rtl-sdr").tx === false);
  check("RF-Clown имя отклонено", rejectAlienFirmware("RF-Clown.bin") !== null);
  check("BlueJammer имя отклонено", rejectAlienFirmware("ESP32-BlueJammer.bin") !== null);
  check("nRF24 имя отклонено", firmwareFileDoesTask("nrf24_jam.rbf", "bladerf-micro-xa4").ok === false);
  check(
    "BlueJammer на xA4 не validate",
    validateFlashJob({
      deviceId: "bladerf-micro-xa4",
      filename: "bluejammer.bin",
      byteLength: 100,
      action: "load-fpga",
    }).ok === false,
  );
  check(
    "Nuand RAM CLI",
    planFlashCli({
      deviceId: "bladerf-micro-xa4",
      filename: "hostedxA4.rbf",
      byteLength: 10,
      action: "load-fpga",
    }).argv.join(" ") === "bladeRF-cli -l hostedxA4.rbf",
  );
  check(
    "CLI сохраняет полный путь файла",
    planFlashCli({
      deviceId: "bladerf-micro-xa4",
      filename: "/tmp/fw/hostedxA4.rbf",
      byteLength: 10,
      action: "load-fpga",
    }).argv[2] === "/tmp/fw/hostedxA4.rbf",
  );
  check(
    "N210 loader берёт IP шлюза",
    planFlashCli(
      {
        deviceId: "usrp-n210",
        filename: "usrp_n210_r4_fpga.bin",
        byteLength: 10,
        action: "flash-fpga",
      },
      "10.1.2.3",
    ).argv.some((a) => a.includes("10.1.2.3")),
  );
  check(
    "N210 MCU-firmware идёт через --fw-path, не --fpga-path",
    planFlashCli({
      deviceId: "usrp-n210",
      filename: "usrp_n210_fw.bin",
      byteLength: 10,
      action: "flash-fx3",
    }).argv.some((a) => a.startsWith("--fw-path=")),
  );
  check(
    "N210 FPGA идёт через --fpga-path",
    planFlashCli({
      deviceId: "usrp-n210",
      filename: "usrp_n210_r4_fpga.bin",
      byteLength: 10,
      action: "flash-fpga",
    }).argv.some((a) => a.startsWith("--fpga-path=")),
  );
  check(
    "N210 RAM-load отклонён (uhd_image_loader пишет только во flash)",
    validateFlashJob({
      deviceId: "usrp-n210",
      filename: "usrp_n210_r4_fpga.bin",
      byteLength: 100,
      action: "load-fpga",
    }).ok === false,
  );
  check(
    "Nuand autoload CLI",
    planFlashCli({
      deviceId: "bladerf-micro-xa4",
      filename: "hostedxA4.rbf",
      byteLength: 10,
      action: "flash-fpga",
    }).argv.includes("-L"),
  );
  check("без файла образа нельзя", flashFileRequired(0).ok === false);
  check("одно имя без пути нельзя", flashFileRequired(2048, "hostedxA4.rbf").ok === false);
  check("абсолютный путь ок", flashFileRequired(2048, "/tmp/fw/hostedxA4.rbf").ok);
  check("usableImagePath unix", usableImagePath("/tmp/hostedxA4.rbf"));
  check("usableImagePath basename нет", usableImagePath("hostedxA4.rbf") === false);
  check("без эмуляции и без CLI открытие запрещено", hostOpenAllowed({
    emulation: false,
    hasSoapyOrCli: false,
    imageBytes: 0,
  }).ok === false);
  check("эмуляция открытие честно", hostOpenAllowed({
    emulation: true,
    hasSoapyOrCli: false,
    imageBytes: 0,
  }).ok);

  const soapyHit = markCatalogPresent(
    [{ ...(xa4 as NonNullable<typeof xa4>), serial: "", present: false }],
    [{ driver: "bladerf", label: "Nuand bladeRF", serial: "cafe1234" }],
  );
  check("probe Soapy помечает xA4 present", soapyHit[0]?.present === true);
  check("probe Soapy берёт serial устройства, не свалку", soapyHit[0]?.serial === "cafe1234");
  const soapyMiss = markCatalogPresent(
    [{ ...(xa4 as NonNullable<typeof xa4>), serial: "", present: false }],
    [{ driver: "rtlsdr", label: "RTL2838" }],
  );
  check("чужой донгл не помечает bladeRF", soapyMiss[0]?.present === false);

  const dry = new MockSdrBackend({ emulation: false });
  check("мок без эмуляции не present", dry.probe().every((d) => d.present === false));
  check("мок без эмуляции не open", dry.open("bladerf-micro-xa4").ok === false);

  const sdrJob = {
    deviceId: "bladerf-micro-xa4",
    filename: "/tmp/fw/hostedxA4.rbf",
    byteLength: 2048,
    action: "load-fpga" as const,
  };
  check("SDR без галочки не шьём", planSdrWrite({ job: sdrJob, imagePath: sdrJob.filename, confirmed: false }).ok === false);
  const sdrOk = planSdrWrite({ job: sdrJob, imagePath: sdrJob.filename, confirmed: true });
  check("SDR официальный xA4 → bladeRF-cli", sdrOk.ok && sdrOk.argv[0] === "bladeRF-cli" && sdrOk.argv.includes("-l"));
  check(
    "SDR inspect совпадает с confirmed",
    inspectSdrWrite({ job: sdrJob, imagePath: sdrJob.filename }).argv.join(" ") === sdrOk.argv.join(" "),
  );
  check(
    "ESP32 .elf на SDR отказ",
    planSdrWrite({
      job: { ...sdrJob, filename: "/tmp/fw/legion.elf" },
      imagePath: "/tmp/fw/legion.elf",
      confirmed: true,
    }).ok === false,
  );
  check(
    "xA4 образ на xA9 отказ",
    planSdrWrite({
      job: { ...sdrJob, deviceId: "bladerf-micro-xa9" },
      imagePath: sdrJob.filename,
      confirmed: true,
    }).ok === false,
  );
  check(
    "hostedxA4 на ESP32 отказ",
    planEsp32Flash({
      env: "esp32-s3",
      port: "/dev/ttyUSB0",
      confirmed: true,
      chip: "ESP32-S3",
      chipPort: "/dev/ttyUSB0",
      filename: "hostedxA4.rbf",
    }).ok === false,
  );
  check(
    "RF-Clown на ESP32 отказ",
    planEsp32Flash({
      env: "esp32-s3",
      port: "/dev/ttyUSB0",
      confirmed: true,
      chip: "ESP32-S3",
      chipPort: "/dev/ttyUSB0",
      filename: "RF-Clown.bin",
    }).ok === false,
  );
  check(
    "native env отказ",
    planEsp32Flash({
      env: "native",
      port: "/dev/ttyUSB0",
      confirmed: true,
      chip: "ESP32-S3",
      chipPort: "/dev/ttyUSB0",
    }).ok === false,
  );
  check(
    "чип C3 ≠ env S3",
    planEsp32Flash({
      env: "esp32-s3",
      port: "/dev/ttyUSB0",
      confirmed: true,
      chip: "ESP32-C3",
      chipPort: "/dev/ttyUSB0",
    }).reason.includes("кирпич"),
  );
  check(
    "порт после пробы другой — отказ",
    planEsp32Flash({
      env: "esp32-s3",
      port: "/dev/ttyUSB1",
      confirmed: true,
      chip: "ESP32-S3",
      chipPort: "/dev/ttyUSB0",
    }).ok === false,
  );
  const espOk = planEsp32Flash({
    env: "esp32-s3",
    port: "/dev/ttyUSB0",
    confirmed: true,
    chip: "ESP32-S3",
    chipPort: "/dev/ttyUSB0",
  });
  check("ESP32 план = pio upload", espOk.ok === true && espOk.argv?.[0] === "pio" && espOk.argv.includes("upload"));
  check("ESP32 план без bladeRF-cli", !(espOk.argv ?? []).includes("bladeRF-cli"));
  check("ESP32 без галочки отказ", planEsp32Flash({
    env: "esp32-s3",
    port: "/dev/ttyUSB0",
    confirmed: false,
    chip: "ESP32-S3",
    chipPort: "/dev/ttyUSB0",
  }).ok === false);
  check("порт инъекция отказ", usableSerialPort("/dev/ttyUSB0;rm") === false);
  check("порт cwd отказ", usableSerialPort("/dev/ttyUSB0/../sda") === false);
  check("порт ttyUSB ок", usableSerialPort("/dev/ttyUSB0"));
  check("hosted выглядит как SDR", looksLikeSdrFirmware("hostedxA4.rbf"));
  check("elf выглядит как ESP32", looksLikeEsp32Firmware("legion.elf"));
  check("cross SDR←ESP32", (refuseCrossFlash("sdr", "app.elf") ?? "").includes("ESP32"));
  check("cross ESP32←SDR", (refuseCrossFlash("esp32", "hostedxA4.rbf") ?? "").includes("SDR"));
  check("alien jam", refuseCrossFlash("sdr", "ESP32-BlueJammer.bin") !== null);
  check("parse chip S3", parseEsp32Chip("Chip is ESP32-S3 (QFN56)") === "ESP32-S3");
  check("parse chip classic", parseEsp32Chip("Chip is ESP32 (revision 3)") === "ESP32");
  check("S3 не classic", envMatchesChip("esp32dev", "ESP32-S3") === false);
  check("classic = esp32dev", envMatchesChip("esp32dev", "ESP32"));

  // --- ТИП СИГНАЛА: каталог и превью-генератор (зеркало воркера) ---
  check("каталог: 31 тип", WAVE_CATALOG.length === 31);
  check("каталог: id уникальны", new Set(WAVE_CATALOG.map((w) => w.id)).size === WAVE_CATALOG.length);
  check("каталог: у всех есть amp", WAVE_CATALOG.every((w) => w.params.some((p) => p.key === "amp")));
  let prevOk = true;
  for (const w of WAVE_CATALOG) {
    const pr = defaultParams(w.id);
    const { re, im } = previewWaveform(w.id, pr, 4096);
    if (re.length === 0 || re.length !== im.length) {
      prevOk = false;
      console.log(`    … пустой превью: ${w.id}`);
      continue;
    }
    let peak = 0;
    for (let i = 0; i < re.length; i++) {
      if (!Number.isFinite(re[i]) || !Number.isFinite(im[i])) prevOk = false;
      peak = Math.max(peak, Math.hypot(re[i], im[i]));
    }
    if (peak > (pr.amp ?? 0.25) + 1e-6) {
      prevOk = false;
      console.log(`    … пик ${peak} > amp: ${w.id}`);
    }
    const spec = spectrumDb(re, im, 1024);
    if (spec.length !== 1024 || !Number.isFinite(spec[0])) prevOk = false;
  }
  check("превью: все волны finite, пик ≤ amp, спектр 1024", prevOk);
  const clamped = clampParams("qpsk", { amp: 99, alpha: -1, sps: 2.7, seed: 5 });
  check("кламп параметров", clamped.amp === 0.9 && clamped.alpha === 0.03 && clamped.seed === 5);
  const qp = constellationPoints("qpsk", defaultParams("qpsk"), 256);
  const phases = new Set((qp ?? []).map((p) => Math.atan2(p.q, p.i).toFixed(3)));
  check("QPSK созвездие: 4 точки", qp !== null && phases.size === 4);
  check("у синуса нет созвездия", constellationPoints("sine", defaultParams("sine")) === null);
  const mockWave = new MockSdrBackend();
  mockWave.open("bladerf-micro-xa4");
  const mw = mockWave.txWave(2442, "qpsk");
  check("мок txWave ok и называет волну", mw.ok && mw.reason.includes("qpsk"));
  check("мок txWave вне диапазона", mockWave.txWave(10, "qpsk").ok === false);

  // --- bladeRF x40 (родной USB3, 300–3800 МГц, 28 МГц BW) ---
  const x40 = catalogById("bladerf-x40");
  check("x40 в каталоге", x40 !== undefined);
  check("x40 trx 300–3800", x40?.txMhz?.[0] === 300 && x40?.txMhz?.[1] === 3800 && x40?.role === "trx");
  check("x40 full-duplex 28 МГц", x40?.fullDuplex === true && x40?.analogBwMhz === 28);
  check("x40 FPGA образ", imagesFor("bladerf-x40").some((r) => r.names.includes("hostedx40.rbf")));
  check("x40 FX3 образ", imagesFor("bladerf-x40").some((r) => r.kind === "fx3"));
  check("x40 дефолтный образ", defaultFlashName("bladerf-x40") === "hostedx40.rbf");
  check("x40 валиден hostedx40", validateFlashJob({
    deviceId: "bladerf-x40", filename: "hostedx40-latest.rbf", byteLength: 1000, action: "load-fpga",
  }).ok === true);
  check("x40 чужой A4 отказ", validateFlashJob({
    deviceId: "bladerf-x40", filename: "hostedxA4.rbf", byteLength: 1000, action: "load-fpga",
  }).ok === false);
  check("x40 flash-cli = bladeRF-cli", planFlashCli({
    deviceId: "bladerf-x40", filename: "hostedx40.rbf", byteLength: 1000, action: "load-fpga",
  }).argv[0] === "bladeRF-cli");
  const mockX40 = new MockSdrBackend();
  mockX40.open("bladerf-x40");
  check("x40 мок TX в диапазоне", mockX40.txWave(2450, "otfs").ok === true);
  check("x40 мок TX 100 МГц вне диапазона", mockX40.txWave(100, "otfs").ok === false);

  // --- FPGA эфир: микросекунды только внутри чипа, не хост-скан ---
  check("shift=4 @ 2 МГц = 8 µs", detectorWindowUs(4) === 8);
  check("shift=8 @ 2 МГц = 128 µs", detectorWindowUs(8) === 128);
  check("дефолт окна = 8 µs", FPGA_US_DET_SHIFT === 4 && detectorWindowUs(FPGA_US_DET_SHIFT) === 8);
  check("кламп shift 3→4, 15→12", clampDetShift(3) === 4 && clampDetShift(15) === 12);
  check("span 2400–2500 = 100", parkSpanMhz([{ f1Mhz: 2400, f2Mhz: 2500 }]) === 100);
  const airOk = planFpgaAir({
    sdrId: "bladerf-x40",
    analogBwMhz: 28,
    bands: [{ f1Mhz: 2436, f2Mhz: 2464 }],
    loadOk: true,
    detThr: FPGA_DEFAULT_DET_THR,
    detShift: FPGA_US_DET_SHIFT,
  });
  check("FPGA эфир в 28 МГц окне ok", airOk.ok && airOk.windowUs === 8);
  const airWide = planFpgaAir({
    sdrId: "bladerf-x40",
    analogBwMhz: 28,
    bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    loadOk: true,
    detThr: FPGA_DEFAULT_DET_THR,
    detShift: FPGA_US_DET_SHIFT,
  });
  check(
    "FPGA эфир 100 МГц: ARM ок, честно про hop",
    airWide.ok === true && airWide.reason.includes("не сканируется"),
  );
  check("FPGA эфир без нагрузки отказ", planFpgaAir({
    sdrId: "bladerf-x40", analogBwMhz: 28, bands: [{ f1Mhz: 2436, f2Mhz: 2464 }],
    loadOk: false, detThr: 5000, detShift: 4,
  }).ok === false);
  check("FPGA эфир порог 0 отказ", planFpgaAir({
    sdrId: "bladerf-x40", analogBwMhz: 28, bands: [{ f1Mhz: 2436, f2Mhz: 2464 }],
    loadOk: true, detThr: 0, detShift: 4,
  }).ok === false);
  check("FPGA эфир не x40 отказ", planFpgaAir({
    sdrId: "hackrf-one", analogBwMhz: 20, bands: [{ f1Mhz: 2436, f2Mhz: 2450 }],
    loadOk: true, detThr: 5000, detShift: 4,
  }).ok === false);
  check("FPGA эфир micro xA4 ok (AD9361, без подмены)", planFpgaAir({
    sdrId: "bladerf-micro-xa4", analogBwMhz: 56, bands: [{ f1Mhz: 2436, f2Mhz: 2464 }],
    loadOk: true, detThr: 5000, detShift: 4,
  }).ok === true);
  check("detThrFromMedian: полка × K", detThrFromMedian(1200, 4) === 4800);
  check("detThrFromMedian: ноль/мусор → 0 (шлюз откажет)", detThrFromMedian(0) === 0 && detThrFromMedian(Number.NaN) === 0);
  check("detThrFromMedian: ниже floor → 0 (деградированный захват, гейт на шум)",
    detThrFromMedian(10) === 0 && detThrFromMedian(15) === 0);
  check("detThrFromMedian: на floor живёт (16×4=64)", detThrFromMedian(16) === 64);
  check("floor pinned (порядок от фикстуры полки 400–2000)", FPGA_DET_THR_FLOOR === 64);
  check("handoff backoff: 10→20→40 с", handoffRetryMs(1) === 10_000 && handoffRetryMs(2) === 20_000 && handoffRetryMs(3) === 40_000);
  check("handoff backoff: страйк 0/мусор → базовые 10 с", handoffRetryMs(0) === 10_000);
  check("turn dwell: дефолт 3000", FPGA_TURN_DWELL_DEFAULT_MS === 3000 && fpgaTurnDwellClamp(Number.NaN) === 3000 && fpgaTurnDwellClamp(0) === 3000);
  check("turn dwell: 0.4 мс оператора не клампится", fpgaTurnDwellClamp(0.4) === 0.4 && fpgaTurnDwellUs(0.4) === 400);
  check("turn dwell: пол 0.1 мс, потолок 60000", FPGA_TURN_DWELL_MIN_MS === 0.1 && fpgaTurnDwellClamp(0.05) === 0.1 && fpgaTurnDwellClamp(999999) === 60_000);
  check("turn dwell: значение в диапазоне как есть", fpgaTurnDwellClamp(1500) === 1500 && fpgaTurnDwellClamp(40) === 40);
  check("air полоса: дефолт 2 на мусоре", clampAirBwMhz(Number.NaN, 56) === 2 && clampAirBwMhz(0, 56) === 2);
  check("air полоса: кламп потолком платы", clampAirBwMhz(56, 28) === 28 && clampAirBwMhz(20, 56) === 20);
  check("air полоса: пол 0.2 МГц", clampAirBwMhz(0.1, 56) === 0.2);
  check("air fs = max(полоса, 520834)", airFsHz(2) === 2_000_000 && airFsHz(20) === 20_000_000 && airFsHz(0.2) === 520_834);
  check("air тракт: окно мкс честно от fs", airTractParams(20, 56, 4).windowUs === detectorWindowUs(4, 20_000_000));
  check("air тракт: shift не масштабируется (χ² от числа сэмплов)",
    airTractParams(20, 56, 4).detShift === 4 && airTractParams(20, 56, 15).detShift === 12);
  check("захват полки: отстройка 1.6×bw (геометрия 3.2 @ 2 МГц)", captureParkMhz(2442, 6000, 70, 20) === 2474);
  check("захват полки: окно захвата НЕ пересекает канал сигнала ни на одной полосе", (() => {
    // Сигнал живёт в ±bw/2 от пика; захват видит cap ± bw/2. Пересечение =
    // полка измерена по сигналу → гейт глухой навсегда (та самая ловушка).
    for (const bw of [2, 5, 20, 28, 56]) {
      const cap = captureParkMhz(2442, 6000, 70, bw);
      if (cap >= 2442 && cap - bw / 2 < 2442 + bw / 2) return false;
      if (cap < 2442 && cap + bw / 2 > 2442 - bw / 2) return false;
    }
    return true;
  })());
  check("захват полки: 3.2 МГц при канале 2 и по умолчанию",
    captureParkMhz(2442, 6000, 70, 2) === 2445.2 && captureParkMhz(2442, 6000, 70) === 2445.2);
  check("захват полки: окон в пределах IQ-кольца воркера",
    detCaptureWindows(4) === 512 && detCaptureWindows(9) === 256 && detCaptureWindows(12) === 64);
  check("planFpgaAir: полоса шире платы урезана честно", (() => {
    const p = planFpgaAir({
      sdrId: "bladerf-x40", analogBwMhz: 28, bands: [{ f1Mhz: 2436, f2Mhz: 2464 }],
      loadOk: true, detThr: 5000, detShift: 4, bwMhz: 56,
    });
    return p.bwMhz === 28 && p.reason.includes("урезана");
  })());
  check("planFpgaAir: канал 20 МГц → fs 20 MSPS", planFpgaAir({
    sdrId: "bladerf-micro-xa4", analogBwMhz: 56, bands: [{ f1Mhz: 2436, f2Mhz: 2464 }],
    loadOk: true, detThr: 5000, detShift: 4, bwMhz: 20,
  }).fsHz === 20_000_000);
  check("онбордовый перехват: 2400–2500 @ 28 МГц → несколько взглядов", (() => {
    const p = planOnboardIntercept({
      sdrId: "bladerf-x40", analogBwMhz: 28, bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
      loadOk: true, detThr: 5000, detShift: 4, lookMhz: 28, turn: false, dwellMs: 3000,
    });
    return p.ok && p.centers.length === 4 && p.firstMhz === 2414 && p.reason.includes("USB не в круге");
  })());
  check("онбордовый перехват: коридор в одном взгляде — LO не шагает", (() => {
    const p = planOnboardIntercept({
      sdrId: "bladerf-micro-xa4", analogBwMhz: 56, bands: [{ f1Mhz: 2436, f2Mhz: 2464 }],
      loadOk: true, detThr: 5000, detShift: 4, lookMhz: 56, turn: false, dwellMs: 3000,
    });
    return p.ok && p.centers.length === 1 && p.reason.includes("не шагает");
  })());
  check("онбордовый перехват: 2 МГц взгляд — 2450 и 2465 разные стоянки, выдержка 0.4 мс", (() => {
    const p = planOnboardIntercept({
      sdrId: "bladerf-x40", analogBwMhz: 28, bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
      loadOk: true, detThr: 5000, detShift: 4, lookMhz: 2, turn: true, dwellMs: 0.4,
    });
    return p.ok && p.dwellMs === 0.4 && p.centers.includes(2465)
      && p.centers.some((c) => Math.abs(c - 2450) <= 1);
  })());
  check("онбордовый перехват без нагрузки отказ", planOnboardIntercept({
    sdrId: "bladerf-x40", analogBwMhz: 28, bands: [{ f1Mhz: 2400, f2Mhz: 2500 }],
    loadOk: false, detThr: 5000, detShift: 4, turn: false, dwellMs: 3000,
  }).ok === false);
  check("ARM lb_gated с scan_enable несёт коридор", (() => {
    const c = fpgaArmCmd("lb_gated", {
      detThr: 5000, detShift: 4, token: "t", freqMhz: 2414,
      fsHz: 28e6, bwMhz: 28, scanEnable: true, scanF1Mhz: 2400, scanF2Mhz: 2500,
      scanTurn: true, scanDwellMs: 1500,
    });
    return c.scan_enable === true && c.scan_f1_mhz === 2400 && c.scan_turn === true
      && c.scan_dwell_us === 1_500_000 && c.scan_dwell_ms === 1500;
  })());
  check("ARM 0.4 мс → 400 мкс на провод", fpgaArmCmd("lb_gated", {
    detThr: 5000, detShift: 4, token: "t", scanEnable: true, scanF1Mhz: 2400, scanF2Mhz: 2500,
    scanTurn: true, scanDwellMs: 0.4,
  }).scan_dwell_us === 400);
  check("air-таблица: полка × K по стоянкам", (() => {
    const t = airThrTable([1000, 2000, 3000]);
    return t !== null && t.join(",") === "4000,8000,12000";
  })());
  check("air-таблица: упавший захват → медиана успешных, не 0", (() => {
    const t = airThrTable([1000, null, 3000]);
    return t !== null && t.join(",") === "4000,12000,12000";
  })());
  check("air-таблица: все упали → null (честный отказ)", airThrTable([null, 10, null]) === null);
  check("air-обход: x40 с прыжками отказан", (airHopBlockedReason("bladerf-x40", true) ?? "").includes("micro"));
  check("air-обход: micro можно, одна стоянка можно",
    airHopBlockedReason("bladerf-micro-xa4", true) === null && airHopBlockedReason("bladerf-x40", false) === null);
  check("handoff skip на 3-м страйке", !handoffSkipAfter(2) && handoffSkipAfter(3));
  check("handoff таймлайн: этапы с dt",
    handoffTimeline(1000, [["park_полки", 1070], ["arm", 1540]]) === "park_полки +70мс · arm +540мс");
  check("handoff таймлайн пустой → пустая строка", handoffTimeline(1000, []) === "");
  check("ARM lb_gated несёт freq_mhz для micro", fpgaArmCmd("lb_gated", { detThr: 5000, detShift: 4, token: "t", freqMhz: 2442.5 }).freq_mhz === 2442.5);
  const gatedCmd = fpgaArmCmd("lb_gated", { detThr: 5000, detShift: 4, token: "t" });
  check("ARM lb_gated несёт det_thr и shift=4", gatedCmd.det_thr === 5000 && gatedCmd.det_shift === 4);
  const playerCmd = fpgaArmCmd("player", { detThr: 5000, detShift: 4, token: "" });
  check("ARM player без det_thr", playerCmd.det_thr === undefined && playerCmd.mode === "player");
  const ncoZero = fpgaArmCmd("nco", { detThr: 5000, detShift: 4, token: "", ncoFtw: ncoFtwFromFrac(0) });
  check("ARM nco шлёт FTW", typeof ncoZero.nco_ftw === "number");
  check("fj=0 → fs/8, не DC", ncoZero.nco_ftw === ncoFtwFromFrac(0.125) && ncoZero.nco_ftw !== 0);
  check("ARM nco без det_thr", ncoZero.det_thr === undefined);
  check(
    "наблюдение: тишина",
    fpgaObserveLine({ ok: true, det_active: false, det_count: 0 }).includes("тишина"),
  );
  check(
    "наблюдение: энергия на усилитель",
    fpgaObserveLine({ ok: true, det_active: true, det_count: 3 }).includes("RX→TX"),
  );
  check("наблюдение без статуса", fpgaObserveLine(null).includes("наблюдает"));

  // --- FPGA solo: сетка стоянок (не эфир, не хост-скан) ---
  const w100 = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 100, analogMaxMhz: 56, wave: "awgn" });
  check("100 МГц окно на 100 МГц коридоре → 1 стоянка", w100.ok && w100.hops === 1 && w100.hop === false);
  check("100 без прыжков: центр середины", w100.centers.length === 1 && Math.abs(w100.centers[0] - 2450) < 1e-6);
  check("100 без прыжков: analog clamped к 56", w100.analogClamped && w100.analogMhz === 56 && w100.fsHz === 56e6);
  const w50 = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 50, analogMaxMhz: 56, wave: "awgn" });
  check("50 МГц на 100 → 2 стоянки", w50.ok && w50.hops === 2 && w50.hop === true);
  check("50 МГц: центры 2425 и 2475", w50.centers[0] === 2425 && w50.centers[1] === 2475);
  check("50 МГц влезает в 56: analog=50", w50.analogMhz === 50 && !w50.analogClamped && w50.fsHz === 50e6);
  check("Nuand sample-rate min = 520834", FPGA_SOLO_FS_MIN_HZ === 520834);
  // WD_LIMIT считает только шлюз (watchdog_limit_for_fs, Python) — TS-дубль
  // удалён: два авторитета молча расходятся. Контракт пиннит test_legion_fpga.
  check("wd 10 МГц ×65536/fs > 500 мс kick", (153 * 65536) / 10e6 > 0.5);
  check("дефолт 61 @ 10 МГц < kick", (61 * 65536) / 10e6 < 0.5);
  check("hint analog не врёт «micro»", w100.reason.includes("фильтр платы") && !w100.reason.includes("фильтр micro"));
  check("soloFsHz(10) = 10e6 (выше пола)", soloFsHz(10) === 10e6);
  check("soloFsHz(0.2) = пол AD9361, не 200000", soloFsHz(0.2) === FPGA_SOLO_FS_MIN_HZ);
  const w02 = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2400.2, windowMhz: 0.2, analogMaxMhz: 56, wave: "awgn" });
  check("окно 0.2: analog 0.2 (BW min), fs = 520834", w02.ok && w02.analogMhz === 0.2 && w02.fsHz === 520834 && !w02.analogClamped);
  check("окно 0.2: одна стоянка", w02.hops === 1 && w02.hop === false);
  check("окно 1.0: fs = analog×1e6", planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2410, windowMhz: 1 }).fsHz === 1e6);
  const w20 = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 20 });
  check("20 МГц на 100 → 5 стоянок", w20.hops === 5);
  check("слово: 1 стоянка", standingWordRu(1) === "стоянка");
  check("слово: 2 стоянки", standingWordRu(2) === "стоянки");
  check("слово: 5 стоянок", standingWordRu(5) === "стоянок");
  check("слово: 21 стоянка", standingWordRu(21) === "стоянка");
  check("план 5 пишет стоянок, не стоянки", w20.reason.includes("5 стоянок"));
  const w10 = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 10 });
  check("10 МГц на 100 → 10 стоянок", w10.hops === 10);
  const w2 = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 2, pattern: "hop" });
  check("2 МГц: много стоянок и hop", w2.hops === 50 && w2.pattern === "hop");
  const w3 = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 3, pattern: "sweep" });
  check("3 МГц: ceil(100/3)=34 стоянки", w3.hops === 34 && w3.pattern === "sweep");
  const narrow = planFpgaSoloWalk({ f1Mhz: 2440, f2Mhz: 2450, windowMhz: 50 });
  check("окно шире коридора → 1 стоянка", narrow.hops === 1 && narrow.hop === false);
  check("дефолт analog micro = 56", FPGA_SOLO_MICRO_ANALOG_MHZ === 56);
  check("analog 30 не клипается к 56", clampSoloAnalogMhz(30, 56) === 30);
  check("analog 100 клипается к 56", clampSoloAnalogMhz(100, 56) === 56);
  check("выдержка 10 мс → минимум 200", clampSoloDwellMs(10) === 200);
  check("выдержка 800 без клипа", clampSoloDwellMs(800) === 800);
  check("тон не заполняет окно", waveFillsSoloWindow("sine") === false && waveFillsSoloWindow("tone") === false);
  check("AWGN заполняет окно", waveFillsSoloWindow("awgn") === true);
  check("план тона пишет «палочка»", planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 20, wave: "sine" }).reason.includes("палочка"));
  check("план AWGN пишет «заполнит»", w50.reason.includes("заполнит"));
  check("пустой коридор отказ", planFpgaSoloWalk({ f1Mhz: 2500, f2Mhz: 2400, windowMhz: 10 }).ok === false);
  check("окно 0 отказ", planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 0 }).ok === false);
  check("сетка не вылезает за F2", w50.centers.every((c) => c >= 2400 && c <= 2500));

  // --- FPGA solo: walker / ARM / tune (не recapture) ---
  const walk100 = makeSoloWalker(w100);
  check("walker 100 МГц: одна стоянка (сетка не сжата к 56)", walk100.centers.length === 1);
  const walk50 = makeSoloWalker(w50);
  check("walker 50 МГц: две стоянки", walk50.centers.length === 2 && walk50.centers[0] === 2425);
  const firstSweep = walk50.next();
  check("sweep: первая стоянка = next(), не mid коридора", firstSweep.centerMhz === 2425);
  const hopPlan = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 20, pattern: "hop" });
  const soloHopW = makeSoloWalker(hopPlan, 7);
  const hopFirst = soloHopW.next();
  const hopSecond = soloHopW.next();
  check("hop: первая стоянка из сетки, не mid коридора", hopPlan.centers.includes(hopFirst.centerMhz));
  check("hop: второй шаг тоже из сетки (не recapture)", hopPlan.centers.includes(hopSecond.centerMhz));
  const hopSeq = Array.from({ length: 40 }, () => soloHopW.next().centerMhz);
  check("hop: за 40 шагов не залипает на одной точке", new Set(hopSeq).size > 1);
  check("hop: все шаги из centers плана", hopSeq.every((c) => hopPlan.centers.includes(c)));
  const hop50 = planFpgaSoloWalk({ f1Mhz: 2400, f2Mhz: 2500, windowMhz: 50, pattern: "hop" });
  const hop50w = makeSoloWalker(hop50, 3);
  const hop50samples = Array.from({ length: 20 }, () => hop50w.next().centerMhz);
  check("hop 50 МГц только 2425/2475, не 2450", hop50samples.every((c) => c === 2425 || c === 2475));
  check("hop: первая стоянка бывает не centers[0] (порог ARM по индексу обязателен)", (() => {
    for (let seed = 1; seed < 50; seed++) {
      const w = makeSoloWalker(hopPlan, seed);
      if (w.next().centerMhz !== hopPlan.centers[0]) return true;
    }
    return false;
  })());
  const hostHop = Array.from({ length: 30 }, () => hopCenterInBand([{ f1Mhz: 2400, f2Mhz: 2500 }], 50, mulberry32(1)));
  check("хост hopCenterInBand ≠ сетка solo (не мешаем)", hostHop.some((c) => c !== 2425 && c !== 2475));
  check("parseBand 20–80 — синтезатор, отказ", parseBand("20", "80") === null);
  const low = planFpgaSoloWalk({ f1Mhz: 20, f2Mhz: 80, windowMhz: 20 });
  check("solo план 20–80 ок (не parseBand)", low.ok && low.hops === 3);
  const park = soloParkOpts(w50);
  check("park solo: fs/BW = окно 50, не 2 МГц", park.fsHz === 50e6 && park.analogMhz === 50 && park.spanMhz === 50);
  const tune = soloTuneCmd(2475, w50, "tok");
  check("tune: op=tune без USB/capture", tune.op === "tune" && tune.freq_mhz === 2475);
  check("tune несёт fs/bw окна", tune.fs_hz === 50e6 && tune.bw_mhz === 50);
  check("tune не несёт player_ctl", tune.player_ctl === undefined && tune.wave === undefined);
  check("прыжки на micro xA4", soloHopAllowed("bladerf-micro-xa4") === true);
  check("прыжки на x40 запрещены", soloHopAllowed("bladerf-x40") === false);
  check("x40 + hops: кино/start режут до ARM", soloHopBlockedReason("bladerf-x40", true)?.includes("micro") === true);
  check("x40 + одна стоянка: hops не блокируем", soloHopBlockedReason("bladerf-x40", false) === null);
  check("micro + hops: не блокируем", soloHopBlockedReason("bladerf-micro-xa4", true) === null);
  check("текст отказа hops один", SOLO_HOP_MICRO_ONLY.includes("tune LO без USB"));

  const soloArm = fpgaArmCmd("player", {
    detThr: 5000, detShift: 4, token: "t", freqMhz: 2425, fsHz: 20e6, bwMhz: 20,
  });
  check("ARM player solo несёт fs_hz и bw_mhz", soloArm.fs_hz === 20e6 && soloArm.bw_mhz === 20 && soloArm.freq_mhz === 2425);
  const airArm = fpgaArmCmd("lb_gated", { detThr: 5000, detShift: 4, token: "t", freqMhz: 2442.5 });
  check("ARM эфир без fs_hz/bw_mhz", airArm.fs_hz === undefined && airArm.bw_mhz === undefined);
  check("ARM эфир всё ещё несёт det_thr", airArm.det_thr === 5000 && airArm.freq_mhz === 2442.5);
  const ncoArm = fpgaArmCmd("nco", {
    detThr: 5000, detShift: 4, token: "", freqMhz: 2450, fsHz: 10e6, bwMhz: 10, ncoFtw: 1,
  });
  check("ARM nco solo несёт fs/bw", ncoArm.fs_hz === 10e6 && ncoArm.bw_mhz === 10 && ncoArm.nco_ftw === 1);

  const st0 = useLegion.getState();
  check("store: окно по умолчанию 10", st0.fpgaSoloWindowMhz === "10");
  check("store: задержка по умолчанию 500", st0.fpgaSoloDwellMs === "500");
  check("store: ход по умолчанию sweep", st0.fpgaSoloPattern === "sweep");
  st0.setFpgaSoloWindowMhz("50");
  st0.setFpgaSoloDwellMs("800");
  st0.setFpgaSoloPattern("hop");
  check("store: сеттеры окна/задержки/хода",
    useLegion.getState().fpgaSoloWindowMhz === "50"
    && useLegion.getState().fpgaSoloDwellMs === "800"
    && useLegion.getState().fpgaSoloPattern === "hop");
  useLegion.getState().setSdrLoad(true);
  useLegion.getState().setSdrId("bladerf-micro-xa4");
  const started = await runSmartStart({
    f1: "2400", f2: "2500", wave: "awgn", loadOk: true, path: "solo",
    windowMhz: "20", dwellMs: "400", pattern: "sweep",
  });
  const after = useLegion.getState();
  check("cinema записал окно/задержку/ход до ARM",
    after.fpgaSoloWindowMhz === "20" && after.fpgaSoloDwellMs === "400" && after.fpgaSoloPattern === "sweep");
  check("без шлюза solo не ARM (как air)", started === false && after.fpgaArmed === false);

  after.clearSdrBands();
  after.setSdrAllowField("sdrF1", "20");
  after.setSdrAllowField("sdrF2", "80");
  after.setSdrLoad(true);
  after.setSdrId("bladerf-micro-xa4");
  const lowSolo = await after.startFpgaPath("solo");
  const lowSoloLog = useLegion.getState().log.at(-1)?.text ?? "";
  check("solo 20–80 не режет parseBand", lowSolo === false && !lowSoloLog.includes("задайте начало и конец полосы"));
  check("solo 20–80 доходит до шлюза", /шлюз|desktop|Tauri|FAKE/i.test(lowSoloLog));

  useLegion.getState().clearSdrBands();
  useLegion.getState().setSdrAllowField("sdrF1", "20");
  useLegion.getState().setSdrAllowField("sdrF2", "80");
  const airGenBeforeReject = peekFpgaAirGen();
  const lowAir = await useLegion.getState().startFpgaPath("air");
  const lowAirLog = useLegion.getState().log.at(-1)?.text ?? "";
  check("air 20–80 по-прежнему parseBand", lowAir === false && lowAirLog.includes("задайте начало и конец полосы"));
  check("air 20–80 не бампает air gen (не срывает FPGA+сканер)", peekFpgaAirGen() === airGenBeforeReject);

  useLegion.getState().clearSdrBands();
  useLegion.getState().setSdrAllowField("sdrF1", "2400");
  useLegion.getState().setSdrAllowField("sdrF2", "2500");
  const airGenBeforePing = peekFpgaAirGen();
  await useLegion.getState().startFpgaPath("air");
  check("air после parseBand бампает gen (отзыв Стоп на ping/park)", peekFpgaAirGen() === airGenBeforePing + 1);

  const idleLive = {
    scanRunning: false, transmitArmed: false, corridorRunning: false,
    signalTxActive: false, fpgaArmed: false, fpgaBusy: false,
  };
  check("cinema idle не live", cinemaIsLive(idleLive) === false);
  check("cinema live при capture (busy, не armed)", cinemaIsLive({ ...idleLive, fpgaBusy: true }) === true);
  check("cinema live при ARM", cinemaIsLive({ ...idleLive, fpgaArmed: true }) === true);

  // --- Кино: автоматический перехват (FPGA+сканер из мастера, не лаборатория) ---
  useLegion.getState().clearSdrBands();
  useLegion.getState().setSdrAllowField("sdrF1", "2400");
  useLegion.getState().setSdrAllowField("sdrF2", "2500");
  useLegion.getState().setSdrLoad(true);
  useLegion.getState().setSdrId("bladerf-micro-xa4");
  const autoOk = await runSmartStart({
    f1: "2400", f2: "2500", wave: "awgn", loadOk: true, path: "auto",
    windowMhz: "5", dwellMs: "1500", dispatch: "priority",
  });
  const autoSt = useLegion.getState();
  check("кино перехват: эмуляция не врёт скан-фазу и не ARM",
    autoOk === true && autoSt.scanRunning === false && autoSt.fpgaArmed === false);
  check("кино перехват: scanPattern=fpga, не fpgaArm",
    autoSt.scanPattern === "fpga" && autoSt.fpgaArmed === false);
  check("кино перехват: стратегия приоритет записана", autoSt.autoDispatch === "priority");
  check("кино перехват: канал 5 МГц записан", autoSt.fpgaAirBwMhz === "5");
  useLegion.getState().stopScan();
  const autoTurn = await runSmartStart({
    f1: "2400", f2: "2500", wave: "awgn", loadOk: true, path: "auto",
    windowMhz: "2", dwellMs: "1500", dispatch: "turn",
  });
  const autoTurnSt = useLegion.getState();
  check("кино перехват: очередь + выдержка записаны",
    autoTurn === true && autoTurnSt.autoDispatch === "turn" && autoTurnSt.fpgaTurnDwellMs === "1500");
  useLegion.getState().stopScan();

  // --- Кино: ручной порог чувствительности для автономного эфира ---
  useLegion.getState().setFpgaDetThr(5000);
  await runSmartStart({
    f1: "2400", f2: "2500", wave: "awgn", loadOk: true, path: "air",
    windowMhz: "100", dwellMs: "500", pattern: "sweep", detThr: "7000",
  });
  check("кино эфир: ручной порог из мастера записан в стор (уйдёт в ARM как det_thr)",
    useLegion.getState().fpgaDetThr === 7000);

  // Регрессия: уставший fpgaStatus (ok:false из лабораторного СТАТУСа без
  // шлюза) не должен красить новый цикл в ОШИБКУ — вход в ARM чистит статус.
  // (fpgaArm ставит busy до первого await — доезжает и без Tauri.)
  useLegion.setState({ fpgaStatus: { ok: false, reason: "старый провал" } });
  await useLegion.getState().fpgaArm();
  check("fpgaArm чистит уставший fpgaStatus на входе",
    useLegion.getState().fpgaStatus === null);

  const genBeforeAbort = peekFpgaSoloGen();
  useLegion.getState().abortFpgaSolo();
  check("abortFpgaSolo бампает поколение", peekFpgaSoloGen() === genBeforeAbort + 1);
  const airBeforeAbort = peekFpgaAirGen();
  useLegion.getState().abortFpgaAir();
  check("abortFpgaAir бампает поколение", peekFpgaAirGen() === airBeforeAbort + 1);
  const armBeforeAbort = peekFpgaArmGen();
  useLegion.getState().abortFpgaArm();
  check("abortFpgaArm бампает поколение", peekFpgaArmGen() === armBeforeAbort + 1);
  const genBeforeCinema = peekFpgaSoloGen();
  const airBeforeCinema = peekFpgaAirGen();
  const armBeforeCinema = peekFpgaArmGen();
  check("кино СТОП при !armed не требует DISARM чтобы бампнуть", useLegion.getState().fpgaArmed === false);
  await runCinemaStop();
  check("cinema СТОП бампает solo gen без ARM", peekFpgaSoloGen() === genBeforeCinema + 1);
  check("cinema СТОП бампает air gen без ARM", peekFpgaAirGen() === airBeforeCinema + 1);
  check("cinema СТОП бампает arm gen без ARM", peekFpgaArmGen() === armBeforeCinema + 1);
  check("cinema СТОП без ARM не ставит armed", useLegion.getState().fpgaArmed === false);

  const here = dirname(fileURLToPath(import.meta.url));
  const storeSrc = readFileSync(join(here, "../src/state/store.ts"), "utf8");
  const gateSrc = readFileSync(join(here, "../src/components/cinema/StartGate.tsx"), "utf8");
  const dockSrc = readFileSync(join(here, "../src/components/cinema/CinemaDock.tsx"), "utf8");
  const nuandHdr = readFileSync(join(here, "../../fpga/vendor/bladerf/fpga_common/include/bladerf2_common.h"), "utf8");
  check("эфирный тракт по полосе оператора (airTractParams)", storeSrc.includes("airTractParams(parseFloat(get().fpgaAirBwMhz)"));
  const airBlock = storeSrc.slice(storeSrc.indexOf('set({ fpgaMode: "lb_gated" })'), storeSrc.indexOf("const kind = get().txWaveKind"));
  check("air start шлёт fs_hz/bw_mhz в ARM (NIOS поднимает тракт под канал)",
    airBlock.includes("fs_hz: tract.fsHz") && airBlock.includes("bw_mhz: tract.bwMhz"));
  check("air start сверяет поколение после park/ARM", airBlock.includes("abortAirIfRevoked"));
  check("handoff паркует канал оператора, не зашитые 2 МГц",
    storeSrc.includes("hostPark(mhz, tract.bwMhz, tract.fsHz, true, true)"));
  check("handoff ARM несёт fs/bw канала", storeSrc.includes("fsHz: tract.fsHz,") && storeSrc.includes("bwMhz: tract.bwMhz,"));
  // Аудит P1-3: handoff обязан спросить шлюз ДО парковки — FAKE/мёртвый шлюз
  // = честный отказ, ARM в эмулятор не уходит (раньше проверки не было —
  // UI показал бы «РЕТРАНСЛЯЦИЮ» без тракта). Ветка fake:true покрыта
  // юнитом fpgaGatewayRefused выше; здесь — факт и порядок врезки.
  const handoffHead = storeSrc.slice(
    storeSrc.indexOf("const fpgaHandoff = async"),
    storeSrc.indexOf("park захвата"),
  );
  check("handoff: ping шлюза до парковки", handoffHead.includes('gw({ op: "ping" })'));
  check("handoff: FAKE/мёртвый шлюз → fail до stopScan",
    handoffHead.includes("fpgaGatewayRefused(ping)") &&
    handoffHead.indexOf("fpgaGatewayRefused(ping)") < handoffHead.indexOf("get().stopScan()"));
  check("handoff: отказ шлюза уходит в fail() (страйк/возврат к скану)",
    handoffHead.includes("await fail(gwNo)"));
  // Аудит P1-4: отзыв эфира обязан гасить сам интервал обхода (как solo),
  // а тик — сверять поколение: между abort и disarm fpgaArmed ещё true.
  const abortAirBody = storeSrc.slice(
    storeSrc.indexOf("abortFpgaAir: () =>"),
    storeSrc.indexOf("abortFpgaArm: () =>"),
  );
  check("abortFpgaAir гасит интервал обхода (не только поколение)",
    abortAirBody.includes("stopAirWalk()"));
  const airWalkBody = storeSrc.slice(
    storeSrc.indexOf("const beginAirWalk ="),
    storeSrc.indexOf("const beginFpgaKick"),
  );
  check("air-обход: тик и ответ tune сверяют поколение",
    airWalkBody.split("gen !== gFpgaAirGen").length - 1 >= 2);
  check("захват полки по окну детектора оператора",
    storeSrc.includes("hostDetCapture(1 << tract.detShift, detCaptureWindows(tract.detShift))"));
  check("захват полки с отстройкой под ширину канала",
    storeSrc.includes("captureParkMhz(mhz, row?.rxMhz?.[1] ?? 6000, row?.rxMhz?.[0] ?? 70, tract.bwMhz)"));
  check("air-обход: калибровочная таблица порогов", storeSrc.includes("airThrTable(medians)"));
  check("air-обход: таймер beginAirWalk после ARM",
    storeSrc.includes("beginAirWalk(walker, walk, tract, thrTable, walk.centers, gw)"));
  check("air-обход: порог стоянки едет внутри tune", storeSrc.includes("det_thr: thr,"));
  check("air-обход: стартовый порог по индексу первой стоянки (hop ≠ centers[0])",
    storeSrc.includes("walk.centers.indexOf(first)") && storeSrc.includes("detThr: thrTable[firstIdx]"));
  check("air-обход: время калибровки логируется", storeSrc.includes("мс/стоянка"));
  check("air-обход: micro-only честно", storeSrc.includes("airHopBlockedReason(get().sdrId, walk.hop)"));
  check("автовозврат в скан — только авто-цикл сканера (fpgaAutoCycle в сторе)",
    storeSrc.includes("fpgaAutoCycle: true") && storeSrc.includes("&& get().fpgaAutoCycle"));
  check("нет устаревшего «чип видит центр, не обход» (air-обход существует)",
    !storeSrc.includes("не обход F1–F2"));
  const appSrc = readFileSync(join(here, "../src/App.tsx"), "utf8");
  const statusSrc = readFileSync(join(here, "../src/components/cinema/status.ts"), "utf8");
  check("hero: статус считается чистой функцией heroStatusLine",
    appSrc.includes("heroStatusLine(") && statusSrc.includes("export function heroStatusLine"));
  check("hero idle: частота по контексту режима (SDR — центр коридора, не поле ESP32)",
    appSrc.includes("idleFreqMhz") && appSrc.includes('mode === "sdr"'));
  check("hero: состояния ОЖИДАНИЕ/ПОИСК/РЕТРАНСЛЯЦИЯ/ОШИБКА",
    ["ОЖИДАНИЕ", "ПОИСК", "РЕТРАНСЛЯЦИЯ", "ОШИБКА"].every((t) => statusSrc.includes(t)));
  check("hero: гейт открыт/закрыт различён",
    statusSrc.includes("гейт открыт") && statusSrc.includes("гейт закрыт"));
  check("hero: watchdog = ОШИБКА с понятным текстом",
    statusSrc.includes("wd_fired") && statusSrc.includes("сторожевой таймер погасил TX"));
  const heroBase = {
    scanRunning: false, transmitArmed: false, corridorRunning: false, signalTxActive: false,
    fpgaArmed: false, fpgaBusy: false, fpgaMode: "player", fpgaStatus: null,
    lastForwardMhz: null, lastInterceptMhz: null, scanCenterMhz: null, telemFreq: null, freqMhz: "2475.000",
  } as const;
  const heroIdle = heroStatusLine(heroBase);
  check("hero: idle → ОЖИДАНИЕ с частотой", heroIdle.kind === "idle" && heroIdle.text === "ОЖИДАНИЕ" && heroIdle.detail.includes("2475"));
  const heroSearch = heroStatusLine({ ...heroBase, scanRunning: true, scanCenterMhz: 2450 });
  check("hero: сканер → ПОИСК", heroSearch.kind === "search" && heroSearch.text === "ПОИСК" && heroSearch.detail.includes("2450"));
  const heroRelay = heroStatusLine({
    ...heroBase, fpgaArmed: true, fpgaMode: "lb_gated",
    fpgaStatus: { ok: true, det_active: true }, lastForwardMhz: 2442.5,
  });
  check("hero: гейт открыт → РЕТРАНСЛЯЦИЯ зелёная",
    heroRelay.kind === "relay" && heroRelay.detail.includes("гейт открыт") && heroRelay.detail.includes("2442.500"));
  const heroRelayWait = heroStatusLine({
    ...heroBase, fpgaArmed: true, fpgaMode: "lb_gated",
    fpgaStatus: { ok: true, det_active: false }, lastForwardMhz: 2442.5,
  });
  check("hero: гейт закрыт → РЕТРАНСЛЯЦИЯ жёлтая (ждём сигнал)",
    heroRelayWait.kind === "relay-wait" && heroRelayWait.detail.includes("гейт закрыт"));
  const heroWd = heroStatusLine({
    ...heroBase, fpgaArmed: true, fpgaMode: "lb_gated",
    fpgaStatus: { ok: true, wd_fired: true },
  });
  check("hero: watchdog → ОШИБКА", heroWd.kind === "error" && heroWd.detail.includes("сторожевой"));
  const heroWarn = heroStatusLine({
    ...heroBase, fpgaArmed: true, fpgaMode: "lb_gated",
    fpgaStatus: { ok: true, det_active: true, warn: "непрерывная работа 6 мин — проверьте охлаждение" },
    lastForwardMhz: 2442.5,
  });
  check("hero: warn шлюза (длительная работа) виден в статусе ретрансляции",
    heroWarn.kind === "relay" && heroWarn.detail.includes("охлаждение"));
  // Регрессия: ОШИБКА обязана переживать снятие ARM стором (стор делает
  // fpgaDisarm сразу — ветка «только при fpgaArmed» была недостижима).
  const heroWdLatched = heroStatusLine({
    ...heroBase, fpgaArmed: false, scanRunning: false,
    fpgaStatus: { ok: true, wd_fired: true },
  });
  check("hero: watchdog → ОШИБКА держится и после снятия ARM",
    heroWdLatched.kind === "error" && heroWdLatched.detail.includes("сторожевой"));
  const heroWdRecovered = heroStatusLine({
    ...heroBase, fpgaArmed: false, scanRunning: true, scanCenterMhz: 2450,
    fpgaStatus: { ok: true, wd_fired: true },
  });
  check("hero: авто-цикл восстановился (скан) — не пугаем ОШИБКОЙ",
    heroWdRecovered.kind === "search");
  // Stale-тревога не маскирует живой соседний тракт (ESP32-коридор после
  // остановки FPGA с wd_fired в последнем статусе).
  const heroWdCorridor = heroStatusLine({
    ...heroBase, corridorRunning: true, telemFreq: 2442,
    fpgaStatus: { ok: true, wd_fired: true },
  });
  check("hero: stale wd_fired уступает живому коридору ESP32",
    heroWdCorridor.kind === "tx" && heroWdCorridor.text === "КОРИДОР");
  const heroWdTx = heroStatusLine({
    ...heroBase, transmitArmed: true, lastForwardMhz: 2450,
    fpgaStatus: { ok: true, wd_fired: true },
  });
  check("hero: stale wd_fired уступает живой передаче", heroWdTx.kind === "tx" && heroWdTx.text === "ПЕРЕДАЧА");
  const heroWdBusy = heroStatusLine({
    ...heroBase, fpgaBusy: true, fpgaStatus: { ok: true, wd_fired: true },
  });
  check("hero: stale wd_fired уступает handoff в полёте (busy → ПОИСК)",
    heroWdBusy.kind === "search");
  const heroDeadBusy = heroStatusLine({
    ...heroBase, fpgaBusy: true, fpgaStatus: { ok: false, reason: "нет ответа шлюза" },
  });
  check("hero: шлюз умер в полёте (busy) → ОШИБКА", heroDeadBusy.kind === "error");
  const heroDeadIdle = heroStatusLine({ ...heroBase, fpgaStatus: { ok: false, reason: "x" } });
  check("hero: лабораторный СТАТУС без шлюза в idle — без ложной тревоги",
    heroDeadIdle.kind === "idle");
  const heroGenWarn = heroStatusLine({
    ...heroBase, fpgaArmed: true, fpgaMode: "player",
    fpgaStatus: { ok: true, warn: "непрерывная работа 6 мин — проверьте охлаждение" },
    lastForwardMhz: 2450,
  });
  check("hero: warn виден и в генерации (player), не только в ретрансляции",
    heroGenWarn.kind === "tx" && heroGenWarn.detail.includes("охлаждение"));
  // Плашка охлаждения на главном кадре (P1.1): warn шлюза дублируется
  // заметно — в hero-detail он тонул; термометра в NIOS-сборке нет.
  const cool = coolingWarn({
    fpgaArmed: true,
    fpgaStatus: { ok: true, warn: "непрерывная работа 6 мин — проверьте охлаждение" },
  });
  check("охлаждение: warn при живом ARM даёт плашку", cool !== null && cool.includes("охлаждение"));
  check("охлаждение: без ARM плашки нет (СТОП/DISARM сняли вопрос)",
    coolingWarn({ fpgaArmed: false, fpgaStatus: { ok: true, warn: "непрерывная работа 6 мин" } }) === null);
  check("охлаждение: без warn плашки нет",
    coolingWarn({ fpgaArmed: true, fpgaStatus: { ok: true } }) === null);
  check("охлаждение: плашка рендерится на главном кадре",
    appSrc.includes("coolingWarn(") && appSrc.includes("cinema-warn"));
  const heroCorr = heroStatusLine({ ...heroBase, corridorRunning: true, telemFreq: 2442 });
  check("hero: коридор ESP32 → КОРИДОР", heroCorr.kind === "tx" && heroCorr.text === "КОРИДОР");
  check("air start бампает gFpgaAirGen", storeSrc.includes("if (path === \"air\") {\n        gFpgaAirGen += 1"));
  const startFn = storeSrc.slice(storeSrc.indexOf("startFpgaPath: async"), storeSrc.indexOf("abortFpgaSolo:"));
  check("air gen после ensureSdrBand, не до валидации",
    startFn.indexOf('if (path === "air" && !ensureSdrBand())') < startFn.indexOf("gFpgaAirGen += 1")
    && startFn.indexOf("gFpgaAirGen += 1") < startFn.indexOf("get().stopScan()"));
  check("отзыв после ARM снимает TX до set(fpgaArmed)", storeSrc.includes("abortAirIfRevoked(!!r.ok)") && storeSrc.includes("abortSoloIfRevoked(!!r.ok)"));
  check("solo park берёт soloParkOpts", storeSrc.includes("soloParkOpts(walk)"));
  check("player capture один раз на walk.fsHz", storeSrc.includes("hostTxWave(mhz, kind, get().signalParams, walk.fsHz)"));
  check("прыжок только soloTuneCmd", storeSrc.includes("soloTuneCmd(step.centerMhz, plan, get().fpgaToken)"));
  check("DISARM стопает solo walk", storeSrc.includes("stopSoloWalk()"));
  const wdSolo = storeSrc.slice(storeSrc.indexOf("FPGA: watchdog погасил TX"), storeSrc.indexOf("Автовозврат «энергия"));
  check("watchdog solo зовёт fpgaDisarm (стопает hop)", wdSolo.includes("fpgaDisarm()") && !wdSolo.includes("hostFpga({ op: \"disarm\""));
  const disarmBlock = storeSrc.slice(storeSrc.indexOf("fpgaDisarm: async ()"), storeSrc.indexOf("stopFpgaAir: async ()"));
  check("DISARM отдаёт USB хосту", disarmBlock.includes('action: "release"'));
  check("DISARM стопает walk до первого await", disarmBlock.indexOf("stopSoloWalk()") < disarmBlock.indexOf("await hostFpga"));
  check("DISARM отзывает in-flight эфир и ручной ARM",
    disarmBlock.includes("gFpgaAirGen += 1") && disarmBlock.includes("gFpgaArmGen += 1")
    && disarmBlock.indexOf("gFpgaAirGen += 1") < disarmBlock.indexOf("await hostFpga"));
  const hopBlock = storeSrc.slice(storeSrc.indexOf("beginSoloWalk"), storeSrc.indexOf("const beginFpgaKick"));
  check("таймер hop не зовёт hostTxWave", hopBlock.includes("soloTuneCmd") && !hopBlock.includes("hostTxWave"));
  check("cinema: шаг walk после solo", gateSrc.includes('setStep("walk")') && gateSrc.includes("Окно, МГц"));
  check("cinema: air проходит шаг walk (канал/выдержка/порядок)",
    gateSrc.includes("Канал, МГц") && gateSrc.includes("airHopBlockedReason") && gateSrc.includes("airWalkReason"));
  check("cinema: туда-сюда и случайно", gateSrc.includes("Туда-сюда") && gateSrc.includes("Случайно"));
  check("cinema walk режет hops на x40 до старта", gateSrc.includes("soloHopBlockedReason") && gateSrc.includes("if (hopNo)"));
  check("cinema эфир не врёт 28 MSPS", !gateSrc.includes("28 MSPS") && !gateSrc.includes("0.57"));
  check("cinema эфир не «только x40»", !gateSrc.includes("Только bladeRF 1 x40"));
  check("cinema эфир: 2 МГц и micro", gateSrc.includes("LEGION_FPGA_FS_HZ") && gateSrc.includes("fpgaAirSupported"));
  check("store hops x40 через soloHopBlockedReason", storeSrc.includes("soloHopBlockedReason(get().sdrId, walk.hop)"));
  const gwSrc = readFileSync(join(here, "../../fpga/host/legion_gateway.py"), "utf8");
  check("шлюз ARM с fs пишет WD_LIMIT", gwSrc.includes("watchdog_limit_for_fs") && gwSrc.includes("set_watchdog"));
  check("шлюз tune без ARM отказывает", gwSrc.includes('tune: нет ARM'));
  const runSrc = readFileSync(join(here, "../src/components/cinema/run.ts"), "utf8");
  check("cinema стоп зовёт fpgaDisarm (тот стопает walk)", runSrc.includes("fpgaDisarm"));
  check("cinema air: окно шага → канал подавления", runSrc.includes("setFpgaAirBwMhz(opts.windowMhz)"));
  check("cinema: путь автоматического перехвата в мастере",
    gateSrc.includes("Автоматический перехват") && gateSrc.includes('path === "auto"'));
  check("мастер: предупреждение о самовозбуде в режимах с ретрансляцией (аудит P1-7)",
    gateSrc.includes("cinema-gate-warn") && gateSrc.includes("утечка собственного сигнала"));
  check("cinema перехват: стратегии приоритет/очередь на шаге walk",
    gateSrc.includes("autoDispatchOptionRu") && gateSrc.includes('setDispatch("turn")') && gateSrc.includes('setDispatch("priority")'));
  const autoBlock = runSrc.slice(runSrc.indexOf('opts.path === "auto"'), runSrc.indexOf("s.armTxWave"));
  check("cinema auto: startScan, не startFpgaPath",
    autoBlock.includes("s.startScan()") && !autoBlock.includes("startFpgaPath"));
  check("cinema auto: эмуляция не ждёт scanRunning",
    autoBlock.includes("sdrEmulation") && autoBlock.includes("return true"));
  check("cinema auto: канал и выдержка очереди пишутся в стор",
    runSrc.includes("setFpgaAirBwMhz(opts.windowMhz)") && runSrc.includes("setFpgaTurnDwellMs(opts.dwellMs)"));
  check("cinema air: ручной порог из мастера пишется в стор",
    gateSrc.includes("Порог чувствительности") && runSrc.includes("setFpgaDetThr(parseFloat(opts.detThr))"));
  // Регрессия: окно детектора в мастере — от реального канала (fs следует за
  // полосой), а не фиксированные 8 мкс при любом канале.
  check("cinema перехват: окно детектора от канала (airTractParams), не константа",
    gateSrc.includes("airTractParams(parseFloat(windowMhz), analogMax, detShift)"));
  const navSrc = readFileSync(join(here, "../src/components/WorkspaceNav.tsx"), "utf8");
  const scanSrc = readFileSync(join(here, "../src/components/ScanPanel.tsx"), "utf8");
  const fastpathSrc = readFileSync(join(here, "../src/sense/fpgaFastpath.ts"), "utf8");
  check("жаргон убран: WorkspaceNav без «FPGA+сканер»", !navSrc.includes("FPGA+сканер"));
  check("жаргон убран: ScanPanel без «конвейер/КОНВЕЙЕР»",
    !scanSrc.includes("конвейер") && !scanSrc.includes("КОНВЕЙЕР"));
  check("жаргон убран: fpgaObserveLine без «конвейер»", !fastpathSrc.includes("конвейер"));
  check("жаргон убран: пользовательские строки стора без «конвейер на SDR»/«det_thr=»",
    !storeSrc.includes("конвейер на SDR, ноутбук") && !storeSrc.includes("det_thr=${detThr}"));
  check("док кино зовёт в перехват", dockSrc.includes("перехват"));
  const setupSrc = readFileSync(join(here, "../../setup.sh"), "utf8");
  check("setup.sh: модуль bladerf проверяется через --info (не --find без железа)",
    setupSrc.includes("SoapySDRUtil --info") && !setupSrc.includes("SoapySDRUtil --find"));
  const installSrc = readFileSync(join(here, "../../INSTALL.md"), "utf8");
  check("INSTALL.md: Quartus, приёмка, шлюз",
    installSrc.includes("Quartus Prime Lite 23.1.1") && installSrc.includes("run_acceptance.sh")
    && installSrc.includes("legion_gateway.py"));
  check("INSTALL.md: desktop Tauri требует Rust и webkit (иначе чистая Ubuntu упадёт)",
    installSrc.includes("rustup") && installSrc.includes("libwebkit2gtk-4.1-dev"));
  check("setup.sh: cargo проверяется как warn (desktop-only)",
    setupSrc.includes("cargo"));
  check("мастер без жаргона player/NCO в тексте для оператора",
    !gateSrc.includes("player/NCO"));
  const soakSrc = readFileSync(join(here, "../../fpga/test/soak_bench.py"), "utf8");
  check("soak: silent-loss только при наличии armed_s (совместимость со старым шлюзом)",
    soakSrc.includes('"armed_s" in st'));
  check("soak: x40 без --ssh — честный отказ (LO шлюзом не паркуется)",
    soakSrc.includes('board == "x40" and not fake') && soakSrc.includes("bladeRF-cli"));
  check("soak: x40 парковка LO между release и acquire",
    soakSrc.indexOf('"action": "release"') < soakSrc.indexOf("bladeRF-cli -e")
    && soakSrc.indexOf("bladeRF-cli -e") < soakSrc.indexOf('"action": "acquire"'));
  check("soak: PASS только за полный срок (ранний чистый прогон = НЕПОЛНЫЙ, код 2)",
    soakSrc.includes("НЕПОЛНЫЙ") && soakSrc.includes("full = elapsed >=") && soakSrc.includes("2 if clean"));
  const accSrc = readFileSync(join(here, "../../fpga/test/acceptance_bench.py"), "utf8");
  check("приёмка E6: размер FPGA явный (--size) — xA4/xA9 по USB PID не различить",
    accSrc.includes('"--size"') && accSrc.includes("legionx{size}.rbf"));
  check("INSTALL.md: pyusb на шлюзе системным пакетом (PEP 668), не голым pip",
    installSrc.includes("python3-usb"));
  const unitSrc = readFileSync(join(here, "../../fpga/systemd/legion-gateway.service"), "utf8");
  check("systemd unit: зависимость python3-usb и таймер охлаждения задокументированы",
    unitSrc.includes("python3-usb") && unitSrc.includes("LEGION_ARM_WARN_S"));
  const runnerSrc = readFileSync(join(here, "../../fpga/test/run_acceptance.sh"), "utf8");
  check("раннер приёмки уважает .venv (INSTALL.md §2)",
    runnerSrc.includes(".venv/bin/python"));
  check("cinema air: выдержка/порядок — свои поля",
    runSrc.includes("setFpgaAirDwellMs(opts.dwellMs)") && runSrc.includes("setFpgaAirWalkPattern(opts.pattern)"));
  check("шлюз: tune несёт det_thr в той же операции (без лишнего round-trip)",
    gwSrc.includes('thr = msg.get("det_thr")') && gwSrc.includes("tune: запись DET_THR не удалась"));
  check("cinema стоп бампает solo до проверки armed", runSrc.includes("abortFpgaSolo()") && runSrc.indexOf("abortFpgaSolo()") < runSrc.indexOf("if (s.fpgaArmed)"));
  check("cinema стоп бампает air до проверки armed", runSrc.includes("abortFpgaAir()") && runSrc.indexOf("abortFpgaAir()") < runSrc.indexOf("if (s.fpgaArmed)"));
  check("cinema стоп бампает arm до проверки armed", runSrc.includes("abortFpgaArm()") && runSrc.indexOf("abortFpgaArm()") < runSrc.indexOf("if (s.fpgaArmed)"));
  check("cinema live считает fpgaBusy", runSrc.includes("s.fpgaBusy") && dockSrc.includes("fpgaBusy"));
  const fpgaStatusClears = (storeSrc.match(/set\(\{ fpgaBusy: true[^}]*fpgaStatus: null \}\)/g) || []).length;
  check("все входа ARM (handoff/fpgaArm/startFpgaPath) чистят уставший fpgaStatus",
    fpgaStatusClears >= 3);
  check("solo start сверяет поколение после await", storeSrc.includes("abortSoloIfRevoked") && storeSrc.includes("gFpgaSoloGen"));
  check("hop-таймер не стартует после revoke", storeSrc.includes("if (await abortSoloIfRevoked()) return false;\n          beginSoloWalk"));
  check("Nuand header: sample-rate min 520834", /bladerf2_sample_rate_range = \{[\s\S]*?520834/.test(nuandHdr));
  check("Nuand header: bandwidth min 200000", /bladerf2_bandwidth_range = \{[\s\S]*?200000/.test(nuandHdr));
  check("solo start не зовёт ensureSdrBand", storeSrc.includes('if (path === "air" && !ensureSdrBand())'));
  const soloSrc = readFileSync(join(here, "../src/sense/fpgaSoloWalk.ts"), "utf8");
  check("solo-модуль без дубля WD (limit считает только шлюз)", !soloSrc.includes("FPGA_WD") && !soloSrc.includes("65536"));
  check("хост sweep не назван туда-сюда", patternLabelRu("sweep") === "КАЧАНИЕ" && !patternLabelRu("sweep").includes("туда"));
  const armBlock = storeSrc.slice(storeSrc.indexOf("fpgaArm: async"), storeSrc.indexOf("startFpgaPath: async"));
  check("ручной fpgaArm не зовёт beginSoloWalk (таймер только из startFpgaPath)", !armBlock.includes("beginSoloWalk"));
  check("ручной fpgaArm держит метку fpgaPath solo в UI", armBlock.includes('fpgaPath: air ? "air" : "solo"'));
  check("fpgaArm busy до первого await (кино-старт откажет)",
    armBlock.indexOf("set({ fpgaBusy: true, fpgaStatus: null })") > 0
    && armBlock.indexOf("set({ fpgaBusy: true, fpgaStatus: null })") < armBlock.indexOf("await get().stopTransmit()"));
  check("fpgaArm сверяет поколение после park/ARM", armBlock.includes("armRevoked()") && armBlock.includes("gFpgaArmGen += 1"));
  check("fpgaArm после отзыва снимает прошедший ARM",
    armBlock.includes("if (r.ok) {") && armBlock.includes('await gw({ op: "disarm" })'));
  check("кино-старт отказывает при живом ARM", startFn.includes("if (s0.fpgaArmed)"));
  check("онбордовый старт: startOnboardIntercept, USB не отдаём хост-сканеру",
    storeSrc.includes("const startOnboardIntercept") &&
    storeSrc.includes("await startOnboardIntercept()") &&
    storeSrc.includes("scanEnable: true") &&
    !storeSrc.includes("USB release перед сканом"));
  {
    const onboard = storeSrc.slice(
      storeSrc.indexOf("const startOnboardIntercept"),
      storeSrc.indexOf("const fpgaReturnToScan"),
    );
    check("онбордовый старт глушит хост-FFT и Soapy до USB платы",
      onboard.includes("get().stopScan()") &&
      onboard.includes("releaseSoapyForFpga") &&
      onboard.includes("if (!acq.ok)"));
  }
  {
    const tickFn = storeSrc.slice(
      storeSrc.indexOf("const tickScan = async"),
      storeSrc.indexOf("const armTick ="),
    );
    const fpgaTick = tickFn.slice(
      tickFn.indexOf("isFpgaAirPattern(cur.scanPattern)"),
      tickFn.indexOf("if (!cur.transmitArmed"),
    );
    check("tickScan: паттерн fpga fail-closed, не USB-handoff",
      fpgaTick.includes("get().stopScan()") && !fpgaTick.includes("fpgaHandoff"));
  }
  check("живой автоперехват не подписывается «автономный эфир без сканера»",
    scanSrc.indexOf("fpgaAir") < scanSrc.indexOf("АВТОНОМНЫЙ ЭФИР") &&
    !scanSrc.includes("airLive && !s.fpgaAutoCycle") &&
    !scanSrc.includes("парковка пика"));
  check("handoff commit помнит частоту очереди", storeSrc.includes("gFpgaTurnLastMhz = mhz;"));
  check("fpgaDisarm сбрасывает очередь (новый цикл после СТОП)",
    storeSrc.slice(storeSrc.indexOf("fpgaDisarm: async"), storeSrc.indexOf("stopFpgaAir: async")).includes("gFpgaTurnLastMhz = null"));
  check("fpgaPollStatus: ротация ОБЫЧНОГО по выдержке до стагнации",
    storeSrc.includes("fpgaTurnDwellClamp(parseFloat(get().fpgaTurnDwellMs))") &&
    storeSrc.indexOf("fpgaTurnDwellClamp(parseFloat(get().fpgaTurnDwellMs))") < storeSrc.indexOf("gDetStagnantPolls += 1"));
  check("автовозврат по стагнации работает в обоих dispatch",
    storeSrc.includes("await fpgaReturnToScan(mhz);"));

  // --- КАСТОМ FPGA (ревизия legion): сборка + запись, отдельно от hosted ---
  check("legion: три платы", LEGION_BOARDS.length === 3);
  check("legion: xA4 → micro/A4", legionBoardFor("bladerf-micro-xa4")?.board === "bladeRF-micro"
    && legionBoardFor("bladerf-micro-xa4")?.size === "A4");
  check("legion: x40 → bladeRF/40", legionBoardFor("bladerf-x40")?.rbf === "legionx40.rbf");
  check("legion: hackrf вне таблицы", legionBoardFor("hackrf-one") === null);
  check("legion build xA4", planLegionBuild("bladerf-micro-xa4").reason.includes("-b bladeRF-micro -s A4 -r legion"));
  check("legion build x40", planLegionBuild("bladerf-x40").rbf === "legionx40.rbf");
  check("legion build pluto отказ", planLegionBuild("plutosdr").ok === false);
  check("legion rbf legionxA4", classifyLegionRbf("legionxA4.rbf") === "xa4");
  check("legion rbf legion_x40 (алиас docs)", classifyLegionRbf("legion_x40.rbf") === "x40");
  check("legion rbf по абсолютному пути", classifyLegionRbf("/tmp/fw/legionxA9.rbf") === "xa9");
  check("legion rbf hosted не принимает", classifyLegionRbf("hostedxA4.rbf") === null);
  check("legion rbf fx3 не принимает", classifyLegionRbf("bladeRF_fw_latest.img") === null);
  check("legion rbf esp32 не принимает", classifyLegionRbf("firmware.bin") === null);
  check("legion rbf похожее имя не принимает", classifyLegionRbf("legionxA40.rbf") === null);
  const legionLocalOk = planLegionFlashLocal({
    sdrId: "bladerf-micro-xa4", path: "/tmp/fw/legionxA4.rbf", action: "load", confirmed: true,
  });
  check("legion flash local argv", legionLocalOk.ok && legionLocalOk.argv.join(" ") === "bladeRF-cli -l /tmp/fw/legionxA4.rbf");
  check("legion flash store = -L", planLegionFlashLocal({
    sdrId: "bladerf-x40", path: "/tmp/fw/legionx40.rbf", action: "store", confirmed: true,
  }).argv[1] === "-L");
  check("legion flash без галочки отказ", planLegionFlashLocal({
    sdrId: "bladerf-micro-xa4", path: "/tmp/fw/legionxA4.rbf", action: "load", confirmed: false,
  }).ok === false);
  check("legion flash A9 на A4 отказ", planLegionFlashLocal({
    sdrId: "bladerf-micro-xa4", path: "/tmp/fw/legionxA9.rbf", action: "load", confirmed: true,
  }).ok === false);
  check("legion flash hosted отказ", planLegionFlashLocal({
    sdrId: "bladerf-micro-xa4", path: "/tmp/fw/hostedxA4.rbf", action: "load", confirmed: true,
  }).ok === false);
  check("legion flash имя без пути отказ", planLegionFlashLocal({
    sdrId: "bladerf-micro-xa4", path: "legionxA4.rbf", action: "load", confirmed: true,
  }).ok === false);
  check("legion flash на hackrf отказ", planLegionFlashLocal({
    sdrId: "hackrf-one", path: "/tmp/fw/legionxA4.rbf", action: "load", confirmed: true,
  }).ok === false);
  const legionGwOk = planLegionFlashGateway({
    sdrId: "bladerf-micro-xa9", path: "/home/gw/legionxA9.rbf", action: "store", confirmed: true,
  });
  check("legion flash gateway ok", legionGwOk.ok && legionGwOk.file === "/home/gw/legionxA9.rbf");
  check("legion flash gateway относительный отказ", planLegionFlashGateway({
    sdrId: "bladerf-micro-xa9", path: "home/gw/legionxA9.rbf", action: "store", confirmed: true,
  }).ok === false);
  check("legion flash gateway чужая плата отказ", planLegionFlashGateway({
    sdrId: "bladerf-x40", path: "/home/gw/legionxA4.rbf", action: "load", confirmed: true,
  }).ok === false);
  check("legion: hosted-валидатор по-прежнему режет legion-имена", validateFlashJob({
    deviceId: "bladerf-micro-xa4", filename: "legionxA4.rbf", byteLength: 1000, action: "load-fpga",
  }).ok === false);
  check("legion: вкладка в режиме SDR", modeOf("sdrCustom") === "sdr");
  const sdrRs = readFileSync(join(here, "../src-tauri/src/sdr.rs"), "utf8");
  check("legion: sdr_flash allowlist без скрипта сборки", !sdrRs.includes("build_bladerf"));
  const legionRust = readFileSync(join(here, "../src-tauri/src/legion_build.rs"), "utf8");
  check("rust: таблица плат как в TS", legionRust.includes('("bladeRF", "40")') && legionRust.includes('("bladeRF-micro", "A9")'));
  check("rust: сборка через nios shell + build_bladerf.sh", legionRust.includes("nios2_command_shell.sh") && legionRust.includes("./build_bladerf.sh -b {board} -s {size} -r legion"));
  check("rust: setsid для отмены группой", legionRust.includes("setsid"));
  check("rust: артефакт legionx<size>", legionRust.includes('format!("legionx{size}")'));
  check("store: flash legion отдаёт USB шлюза до CLI", storeSrc.includes('op: "usb", action: "release", token: get().fpgaToken }, get().sdrGateway)')
    && storeSrc.includes("planLegionFlashLocal"));
  check("store: flash legion при ARM отказ", storeSrc.includes("прошивка legion: сначала ОСТАНОВИТЬ FPGA"));
  check("store: опрос сборки по поколению", storeSrc.includes("gLegionBuildGen"));
  check("legion missing: hosted → причина", fpgaLegionMissing({ ok: true, legion: false }) !== null);
  check("legion missing: legion → null", fpgaLegionMissing({ ok: true, legion: true }) === null);
  check("legion missing: неизвестно → null (не режем)", fpgaLegionMissing({ ok: true }) === null
    && fpgaLegionMissing({ ok: true, legion: null }) === null);
  check("legion missing: шлюз мёртв → null (это зона fpgaGatewayRefused)", fpgaLegionMissing({ ok: false }) === null);
  check("шлюз: детект legion на acquire и в ping", gwSrc.includes("_detect_legion") && gwSrc.includes('"legion": self._legion'));
  check("шлюз: ARM на hosted отказ", gwSrc.includes("в FPGA нет ревизии legion"));
  check("шлюз: release обнуляет знание ревизии на всех путях (op usb, flash, сторож, сбой детекта)",
    (gwSrc.match(/self\._legion = None/g) ?? []).length === 4);
  check("шлюз: сбой старта flash-потока откатывает running",
    gwSrc.includes("flash: поток не стартовал"));
  const toolchainSrc = readFileSync(join(here, "../../fpga/check_toolchain.sh"), "utf8");
  check("preflight и сборка выбирают shell одинаково (пин 23.1 сначала)",
    toolchainSrc.includes("intelFPGA_lite/23.1*/nios2eds") && legionRust.includes('contains("intelFPGA_lite/23.1")'));
  check("store: ARM проверяет legion до парковки", storeSrc.includes("fpgaLegionMissing(ping)"));
  check("store: статус обновляет fpgaLegion", storeSrc.includes("fpgaLegion: r.legion"));
  check("store: fpgaLegion из ping на всех трёх точках ARM/скан",
    (storeSrc.match(/if \(ping\.legion !== undefined\) set\(\{ fpgaLegion/g) ?? []).length === 3);
  const legionFlashBlock = storeSrc.slice(storeSrc.indexOf("legionFlash: async"), storeSrc.indexOf("probeEsp32Chip: async"));
  check("прошивка через шлюз без IP — отказ ДО closeSdr",
    legionFlashBlock.includes("укажите IP шлюза")
    && legionFlashBlock.indexOf("укажите IP шлюза") < legionFlashBlock.indexOf("closeSdr()"));
  check("сборка legion: успех = артефакт на диске, не exit код (build_bladerf.sh без set -e)",
    !storeSrc.includes("st.exit === 0 && art?.path") && storeSrc.includes("if (art?.path)"));
  check("rust: сборка — wrapper-скрипт одним аргументом (handbook auto-executing, безопасно при exec $@)",
    legionRust.includes("legion-build-{size}-{ts}.sh") && legionRust.includes(".arg(&wrapper)")
    && legionRust.includes(".stdin(Stdio::null())") && !legionRust.includes('.arg("-c")'));
  check("rust: артефакт только этой сборки (mtime ≥ старт, не файл прошлого прогона)",
    legionRust.includes("artifact_fresh") && legionRust.includes("find_artifact(&st.quartus_dir, &st.size, st.started)"));
  check("сборка legion: причина сбоя опроса статуса не теряется",
    storeSrc.includes("st.reason ?? `exit ${st.exit"));
  check("шлюз: flash ok=CLI, warn=возврат USB (раздельные исходы)",
    gwSrc.includes('"warn": warn') && gwSrc.includes("ВНИМАНИЕ"));
  check("store: подсказка «перезанял USB» только без warn шлюза",
    storeSrc.includes("!st.ok || st.warn"));
  const buildDone = storeSrc.slice(storeSrc.indexOf('legionBuildPhase: "done"'), storeSrc.indexOf('legionBuildPhase: "done"') + 700);
  check("сборка legion: новый артефакт сбрасывает галочку (паттерн setSdrFlashName)",
    buildDone.includes("legionFlashPath: art.path") && buildDone.includes("legionFlashConfirm: false"));
  check("rust: один лок на проверку+spawn (нет TOCTOU двойного старта)",
    legionRust.includes("Один лок на проверку «уже идёт» + spawn + запись"));

  // --- КАСТОМ FPGA: действия стора без Tauri — честные отказы, не фантазии ---
  const L = () => useLegion.getState();
  useLegion.setState({
    sdrId: "bladerf-micro-xa4", legionFlashTarget: "local", legionFlashPath: "",
    legionFlashConfirm: false, legionArtifactPath: "", lastLegionFlash: null,
    sdrOpened: null, scanRunning: false, transmitArmed: false, fpgaArmed: false, flashBusy: false,
  });
  await L().legionFlash();
  check("store legionFlash: без галочки — отказ до любых команд",
    L().lastLegionFlash?.ok === false && (L().lastLegionFlash?.reason ?? "").includes("подтвердите"));
  useLegion.setState({ legionFlashPath: "/tmp/hostedxA4.rbf", legionFlashConfirm: true });
  await L().legionFlash();
  check("store legionFlash: hosted-имя — отказ",
    L().lastLegionFlash?.ok === false && (L().lastLegionFlash?.reason ?? "").includes("не артефакт ревизии legion"));
  useLegion.setState({ legionFlashPath: "/tmp/fw/legionxA9.rbf", legionFlashConfirm: true });
  await L().legionFlash();
  check("store legionFlash: A9 на xA4 — отказ",
    L().lastLegionFlash?.ok === false && (L().lastLegionFlash?.reason ?? "").includes("несовместим"));
  useLegion.setState({ legionFlashTarget: "gateway", sdrGateway: "", legionFlashPath: "/abs/legionxA4.rbf", legionFlashConfirm: true });
  await L().legionFlash();
  check("store legionFlash: шлюз без IP — отказ",
    L().lastLegionFlash?.ok === false && (L().lastLegionFlash?.reason ?? "").includes("IP шлюза"));
  useLegion.setState({ legionFlashTarget: "local", legionFlashPath: "/tmp/fw/legionxA4.rbf", legionFlashConfirm: true });
  await L().legionFlash();
  check("store legionFlash: без desktop — команда не запущена",
    L().lastLegionFlash?.ok === false && (L().lastLegionFlash?.reason ?? "").includes("нет desktop LEGION"));
  useLegion.setState({ sdrId: "hackrf-one", legionBuildPhase: "idle" });
  await L().legionBuildStart();
  check("store legionBuildStart: hackrf — отказ, фаза не building", L().legionBuildPhase === "idle");
  useLegion.setState({ sdrId: "bladerf-micro-xa4" });
  await L().legionBuildStart();
  check("store legionBuildStart: без desktop — failed с причиной, не «собралось»",
    L().legionBuildPhase === "failed");
  useLegion.setState({ sdrId: "bladerf-micro-xa4", legionBuildPhase: "idle", legionFlashConfirm: false, lastLegionFlash: null });
  const buildFn = storeSrc.slice(storeSrc.indexOf("legionBuildStart: async"), storeSrc.indexOf("legionBuildCancel: async"));
  check("сборка legion НЕ занимает flashBusy (часовой синтез не глушит скан)",
    !buildFn.includes("flashBusy: true") && !buildFn.includes("flashBusy: false"));
  check("сборка legion: повторный старт отказ", buildFn.includes('legionBuildPhase === "building"'));
  const legionFlashFn = storeSrc.slice(storeSrc.indexOf("legionFlash: async"), storeSrc.indexOf("probeEsp32Chip: async"));
  check("прошивка legion под flashBusy (мьютекс записи)", legionFlashFn.includes("flashBusy: true"));
  check("прошивка legion: шлюз async flash + опрос", legionFlashFn.includes('op: "flash"') && legionFlashFn.includes('op: "flash_status"'));

  // --- Ревизия аудита 2026-08-28: находки 1/3/4/5 ---
  // Находка 1: abort-хелперы гасят observe вместе с kick (инвариант beginFpgaKick).
  const abortSoloFn = storeSrc.slice(storeSrc.indexOf("abortSoloIfRevoked"), storeSrc.indexOf("abortAirIfRevoked"));
  check("abort solo: observe умирает вместе с kick",
    abortSoloFn.includes("stopFpgaKick()") && abortSoloFn.includes("stopFpgaObserve()"));
  const airAbortAt = storeSrc.indexOf("const abortAirIfRevoked");
  const abortAirFn = storeSrc.slice(airAbortAt, storeSrc.indexOf("const ping = await gw", airAbortAt));
  check("abort air: observe умирает вместе с kick",
    abortAirFn.includes("stopFpgaKick()") && abortAirFn.includes("stopFpgaObserve()"));
  // Находка 3: сбой usb acquire после калибровки — честный отказ ДО ARM,
  // а не падение ARM в мёртвый транспорт с криптичной причиной.
  check("air-обход: сбой acquire — отказ до таблицы порогов",
    storeSrc.includes("FPGA эфир-обход: USB обратно не занят") &&
    storeSrc.indexOf("FPGA эфир-обход: USB обратно не занят") < storeSrc.indexOf("airThrTable(medians)"));
  check("air-обход: первопричина калибровки не маскируется сбоем acquire",
    storeSrc.indexOf('pushLog("sys", calibWhy)') < storeSrc.indexOf("FPGA эфир-обход: USB обратно не занят"));
  // Возврат к скану: сбой DISARM не прячется (состояние снимается по
  // deadman-дизайну цикла, но отказ обязан быть в логе).
  const retScanFn = storeSrc.slice(storeSrc.indexOf("const fpgaReturnToScan"), storeSrc.indexOf("const fpgaHandoff"));
  check("возврат к скану: сбой DISARM честно в логе", retScanFn.includes("FPGA DISARM при возврате к скану"));
  // Deadman-доказательство на монотонных часах: скачок NTP не подделывает тишину.
  check("deadman-доказательство на монотонных часах (performance.now)",
    storeSrc.includes("gLastKickOkMs = performance.now()") &&
    !storeSrc.includes("gLastKickOkMs = Date.now()"));
  // Ни один usb release не выбрасывается молча: каждый назначен в переменную
  // и залогирован при отказе (следующий openSdr иначе ловил бы «занятое
  // устройство» без причины). Считаем присвоенные вызовы против всех.
  const relAll = storeSrc.match(/action: "release"/g)?.length ?? 0;
  const relAssigned = storeSrc.match(/(?:const|let) \w+ = await (?:hostFpga|gw|opts\.gw)\(\{ op: "usb", action: "release"/g)?.length ?? 0;
  check("ни один usb release не выбрасывается молча", relAll > 0 && relAll === relAssigned);
  // Шире: ни один await вызова шлюза (disarm/set/release/…) не молчит —
  // каждый назначен в переменную, а отказ залогирован у места вызова.
  const gwAwaits = storeSrc.match(/await (?:hostFpga|gw)\(/g)?.length ?? 0;
  const gwAssigned = storeSrc.match(/(?:const|let) \w+ = await (?:hostFpga|gw)\(/g)?.length ?? 0;
  check("ни один вызов шлюза не выбрасывает ответ молча", gwAwaits > 0 && gwAwaits === gwAssigned);
  // Находка 4: оценка времени калибровки — в логе до прохода и в UI до старта.
  check("air-обход: лог перед калибровкой с ценой стоянки", storeSrc.includes("~0.1–0.3 с/стоянка"));
  check("air-обход: StartGate показывает оценку калибровки", gateSrc.includes("калибровка порогов при старте"));

  // Находка 5 (поведение, без Tauri — hostFpga честно падает «нет desktop»):
  // мёртвый шлюз не клинит fpgaArmed, когда deadman железа доказан временем.
  useLegion.setState({ fpgaArmed: true, fpgaPath: "air", fpgaToken: "", sdrGateway: "", lastForwardMhz: 2442 });
  pokeLastKickOkMs(performance.now()); // свежий kick — deadman НЕ доказан
  await L().fpgaDisarm();
  check("мёртвый шлюз, свежий kick → ARM честно держим", L().fpgaArmed === true);
  useLegion.setState({ fpgaArmed: true, fpgaPath: "air", lastForwardMhz: 2442 });
  pokeLastKickOkMs(performance.now() - 10_000); // тишина > 3 с: FPGA WD + сторож шлюза уже отработали
  await L().fpgaDisarm();
  check("мёртвый шлюз, deadman доказан → локальный ARM снят",
    L().fpgaArmed === false && L().fpgaPath === null && L().lastForwardMhz === null);
  check("лог честно называет собственный watchdog железа",
    (L().log.at(-1)?.text ?? "").includes("watchdog"));
  useLegion.setState({ fpgaArmed: true, fpgaPath: "air", lastForwardMhz: 2442 });
  pokeLastKickOkMs(null); // kick'ов не было вовсе — доказательства нет
  await L().fpgaDisarm();
  check("мёртвый шлюз без истории kick → ARM держим", L().fpgaArmed === true);
  // closeSdr при мёртвом шлюзе: force-clear по доказательству + сбой release
  // честно в логе (раньше release выбрасывался молча — следующий openSdr
  // ловил бы «занятое устройство» без причины).
  useLegion.setState({ fpgaArmed: true, fpgaPath: "air", lastForwardMhz: 2442, log: [] });
  pokeLastKickOkMs(performance.now() - 10_000);
  await L().closeSdr();
  check("closeSdr при мёртвом шлюзе: ARM снят по deadman-доказательству", L().fpgaArmed === false);
  check("closeSdr: сбой usb release честно в логе",
    L().log.some((e) => e.text.includes("FPGA USB release")));
  useLegion.setState({ fpgaArmed: false, fpgaPath: null, lastForwardMhz: null });
  pokeLastKickOkMs(null);

  console.log(failures === 0 ? "\nORCH: ALL PASS" : `\nORCH: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
