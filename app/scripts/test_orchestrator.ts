// ============================================================================
// LEGION — хостовые тесты фазы 11: каталог SDR, прошивка, allowlist, скан, CUE.
// Запуск: npx tsx scripts/test_orchestrator.ts
// ============================================================================
import { cueFreqAllowed, hzInAllowlist, parseBand, paCurrentInRange } from "../src/policy/allowlist";
import { detectFromBins, MockSdrBackend, SDR_TX_US } from "../src/sdr/backend";
import { SDR_CATALOG, soapyRemoteArgs } from "../src/sdr/catalog";
import { classifyFirmware, validateFlashJob } from "../src/sdr/firmware";
import { planFlashCli } from "../src/sdr/flashcli";
import { flashFileRequired, hostOpenAllowed } from "../src/sdr/host";
import { defaultFlashName, defaultEthHost, planEthernet, sdrOpenArgs } from "../src/sdr/official";
import { firmwareDoesTask, firmwareFileDoesTask, rejectAlienFirmware } from "../src/sdr/task";
import { HandoffGate, planHandoff } from "../src/sense/fastpath";
import { bandListFor, modeConflict, modeOf } from "../src/sense/modes";
import {
  decideCue,
  decideForward,
  decideSdrTx,
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
  check("пустой host xA4 → локальный USB", sdrOpenArgs("bladerf-micro-xa4", "") === "");
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

  check("вкладка scan = режим SDR", modeOf("scan") === "sdr");
  check("вкладка corridor = режим ESP32", modeOf("corridor") === "esp32");
  check("вкладка pa = режим ESP32", modeOf("pa") === "esp32");
  check("скан пишет sdrBands, не allowBands", bandListFor("sdr") === "sdrBands");
  check("ESP32 пишет allowBands, не sdrBands", bandListFor("esp32") === "allowBands");
  check("конфликт: коридор при SDR TX", modeConflict("esp32", false, true) !== null);
  check("конфликт: SDR при коридоре", modeConflict("sdr", true, false) !== null);
  check("нет конфликта", modeConflict("sdr", false, false) === null);

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
    "Nuand autoload CLI",
    planFlashCli({
      deviceId: "bladerf-micro-xa4",
      filename: "hostedxA4.rbf",
      byteLength: 10,
      action: "flash-fpga",
    }).argv.includes("-L"),
  );
  check("без файла образа нельзя", flashFileRequired(0).ok === false);
  check("с файлом размер ок", flashFileRequired(2048).ok);
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

  const dry = new MockSdrBackend({ emulation: false });
  check("мок без эмуляции не present", dry.probe().every((d) => d.present === false));
  check("мок без эмуляции не open", dry.open("bladerf-micro-xa4").ok === false);

  console.log(failures === 0 ? "\nORCH: ALL PASS" : `\nORCH: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
