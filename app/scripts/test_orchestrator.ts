// ============================================================================
// LEGION — хостовые тесты фазы 11: каталог SDR, прошивка, allowlist, скан, CUE.
// Запуск: npx tsx scripts/test_orchestrator.ts
// ============================================================================
import { cueFreqAllowed, hzInAllowlist, parseBand, paCurrentInRange } from "../src/policy/allowlist";
import { detectFromBins, MockSdrBackend, SDR_TX_US } from "../src/sdr/backend";
import { SDR_CATALOG, soapyRemoteArgs } from "../src/sdr/catalog";
import { classifyFirmware, validateFlashJob } from "../src/sdr/firmware";
import { HandoffGate, planHandoff } from "../src/sense/fastpath";
import {
  decideCue,
  decideForward,
  markForwarded,
  mergeDetections,
  pickStrongest,
  sameBin,
} from "../src/sense/orchestrator";
import { AllowlistScanner, clipToAllowlist, planCenters, scanHopMhz, scanTickMs } from "../src/sense/scan";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures++;
  }
}

function main(): void {
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

  check("hostedxA4.rbf → fpga-a4", classifyFirmware("hostedxA4.rbf") === "fpga-a4");
  check("bladeRF.img → fx3", classifyFirmware("bladeRF.img") === "fx3");
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
  check("flash mock A4", flash.ok);

  sdr.injectTone(2442, -35);
  const bins = sdr.scanWindow(2442, 20, 64);
  const dets = detectFromBins(bins, 12);
  check("energy detection ловит несущую", dets.some((d) => Math.abs(d.freqMhz - 2442) < 0.5));

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

  const det = { freqMhz: 2442, powerDbm: -40, noiseDbm: -90, snrDb: 50, ts: 1, forwarded: false };
  const live = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    autoCue: true,
    paMa: 250,
    paPrearmed: true,
    rfOn: true,
    lastCuedMhz: null,
    inflight: false,
    sdrCanTx: true,
  });
  check(
    "после взвода только SDR TX + CUE",
    live.skip === false && live.sdrTx && live.cue && !live.paSetI && !live.paOn && !live.rfOn,
  );
  const firstRf = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    autoCue: true,
    paMa: 250,
    paPrearmed: true,
    rfOn: false,
    lastCuedMhz: null,
    inflight: false,
    sdrCanTx: true,
  });
  check("первый улов включает RF один раз", firstRf.rfOn && !firstRf.paSetI);
  const onlyCue = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: false,
    autoCue: true,
    paMa: 0,
    paPrearmed: false,
    rfOn: false,
    lastCuedMhz: null,
    inflight: false,
    sdrCanTx: true,
  });
  check(
    "autoCue без ПЕРЕДАТЬ не включает RF/SDR TX",
    onlyCue.cue && !onlyCue.sdrTx && !onlyCue.rfOn && !onlyCue.paOn,
  );
  const same = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    autoCue: true,
    paMa: 250,
    paPrearmed: true,
    rfOn: true,
    lastCuedMhz: 2442.05,
    inflight: false,
    sdrCanTx: true,
  });
  check("тот же бин не шлёт повторный CUE", same.skip);
  const busy = planHandoff({
    det,
    bands: ism,
    loadOk: true,
    transmitArmed: true,
    autoCue: true,
    paMa: 250,
    paPrearmed: true,
    rfOn: true,
    lastCuedMhz: 2410,
    inflight: true,
    sdrCanTx: true,
  });
  check("inflight не плодит UART", busy.skip);
  const gate = new HandoffGate();
  gate.reserve(2442);
  check("queueIfBusy на другом бине", gate.queueIfBusy(2480) === true && gate.queuedMhz === 2480);
  check("release отдаёт очередь", gate.release() === 2480 && gate.inflight === false);

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

  console.log(failures === 0 ? "\nORCH: ALL PASS" : `\nORCH: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
