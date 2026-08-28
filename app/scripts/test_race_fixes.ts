// ============================================================================
// LEGION — сценарный тест исправлений гонок (аудит, перепроверка D1/D2).
// Реальный zustand-store на mock-бэкенде, без железа и без Tauri.
// Запуск: npx tsx scripts/test_race_fixes.ts
// ============================================================================
import { useLegion } from "../src/state/store";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures++;
  }
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
  const s = () => useLegion.getState();

  // Скан на моке + демо-несущая + ПЕРЕДАТЬ → авто-handoff на тон
  s().addSdrBand();
  s().startScan();
  await waitFor("scan running", () => s().scanRunning);
  s().injectDemoTone();
  await s().startTransmit();
  check("TX armed", s().transmitArmed);
  const fwd = await waitFor("forward", () => s().lastForwardMhz != null);
  check("авто-handoff на демо-несущую", fwd, `lastForwardMhz=${s().lastForwardMhz}`);

  // D2/№11: снятие нагрузки гасит живой TX и НЕ заклинивает gate
  s().setSdrLoad(false);
  check("нагрузка снята → TX погашен", s().lastForwardMhz === null);
  s().setSdrLoad(true);
  const refwd = await waitFor(
    "re-forward",
    () => s().lastForwardMhz != null,
  );
  check(
    "после LOAD OK handoff снова работает (gate не застрял в inflight)",
    refwd,
  );

  // СБРОСИТЬ: замок снят, та же частота не хватается сразу
  await s().resetSdrLock();
  check("после СБРОСИТЬ замка нет", s().lastForwardMhz === null);

  // Стоп: всё чисто
  await s().stopTransmit();
  check("после СТОП armed снят", !s().transmitArmed);

  // №12: closeSdr при armed — disarm и закрытие
  await s().startTransmit();
  await waitFor("forward again", () => s().lastForwardMhz != null);
  await s().closeSdr();
  check("closeSdr сбрасывает transmitArmed", !s().transmitArmed);
  check("closeSdr закрывает устройство", s().sdrOpened === null);

  // №3: запоздалая телеметрия не воскрешает corridorRunning
  // (мок коридора: стартуем и стопаем ESP32-коридор на mock-транспорте)
  s().setTransportKind("mock");
  await s().connect();
  await s().corridorStart();
  check("коридор запущен", s().corridorRunning);
  await s().corridorStop();
  check("коридор остановлен", !s().corridorRunning);
  await new Promise((r) => setTimeout(r, 300)); // запоздалые строки мока
  check("после STOP телеметрия флаг не воскресила", !s().corridorRunning);
  await s().disconnect();

  // FPGA: HackRF/Pluto не подменяем на x40. micro xA4 — нативно (AD9361, RFIC).
  // Без Tauri шлюз честно мёртв — ARM не ставим.
  s().setSdrLoad(true);
  s().setSdrId("hackrf-one");
  const hack = await s().startFpgaPath("air");
  check("HackRF Эфир+FPGA отказан", hack === false);
  check("HackRF не подменён на x40", s().sdrId === "hackrf-one");
  check("HackRF не ARM", !s().fpgaArmed);

  s().setSdrId("plutosdr");
  await s().fpgaArm();
  check("Pluto ARM отказан, каталог тот же", s().sdrId === "plutosdr" && !s().fpgaArmed);

  s().setSdrId("bladerf-micro-xa4");
  const micro = await s().startFpgaPath("air");
  check("micro xA4 не подменяется на x40", s().sdrId === "bladerf-micro-xa4");
  check("micro без шлюза не ARM", micro === false && !s().fpgaArmed);

  // Конвейер скан→FPGA: СТАРТ запускает скан-фазу (не мгновенный ARM);
  // handoff без живого Soapy (Tauri) честно не дёргается, скан не ломается.
  s().setScanPattern("fpga");
  s().startScan();
  await waitFor("fpga-конвейер: скан-фаза пошла", () => s().scanRunning);
  check("fpga-конвейер: ARM только по детекту, не по кнопке", !s().fpgaArmed);
  s().injectDemoTone();
  await new Promise((r) => setTimeout(r, 400));
  check("fpga-конвейер: скан видит тон", s().detections.length > 0);
  check(
    "fpga-конвейер: без живого Soapy handoff не пытался ARM",
    !s().fpgaArmed && !s().fpgaBusy,
  );
  s().stopScan();
  check("fpga-конвейер: СТОП СКАН гасит скан-фазу", !s().scanRunning);

  // ПЕРЕДАТЬ в fpga-паттерне = старт конвейера со скан-фазы, не мгновенный ARM
  await s().startTransmit();
  await waitFor("fpga: ПЕРЕДАТЬ запустил скан-фазу", () => s().scanRunning);
  check("fpga: ПЕРЕДАТЬ не ARM без детекта", !s().fpgaArmed);
  check("fpga: хост-TX (transmitArmed) не взведён", !s().transmitArmed);
  s().stopScan();
  s().setScanPattern("auto");

  console.log(failures === 0 ? "\nRACE FIXES: ALL PASS" : `\nRACE FIXES: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
