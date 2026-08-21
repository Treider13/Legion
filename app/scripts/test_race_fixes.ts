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

  console.log(failures === 0 ? "\nRACE FIXES: ALL PASS" : `\nRACE FIXES: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
