// ============================================================================
// LEGION — GUI-тест фазы 2: реальный Chrome (puppeteer-core) + vite dev.
// Сценарий: открыть приложение → выбрать MOCK → CONNECT → SET FREQ 2475 →
// проверить LOCK ✓ и журнал → скриншоты в /tmp/legion_shots/.
// ============================================================================
import puppeteer from "puppeteer-core";

const BASE = process.env.LEGION_URL ?? "http://localhost:5173";
const SHOTS = "/tmp/legion_shots";

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1280,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  await page.goto(BASE, { waitUntil: "networkidle0", timeout: 20000 });

  // Выбрать MOCK-транспорт
  await page.select("section.connect-bar select", "mock");
  await page.screenshot({ path: `${SHOTS}/01_initial.png` });

  // CONNECT
  await page.click("section.connect-bar button.btn-primary");
  await page.waitForFunction(
    () => document.querySelector(".state-connected") !== null,
    { timeout: 5000 },
  );
  await page.screenshot({ path: `${SHOTS}/02_connected.png` });

  // SET FREQ 2475 (пресет)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".preset-row button"));
    (btns.find((b) => b.textContent === "2475") as HTMLButtonElement).click();
  });
  await page.waitForFunction(
    () => document.querySelector(".lock-yes") !== null,
    { timeout: 5000 },
  );

  // RF ON
  const rfClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".power-row button"));
    const rf = btns.find((b) => b.textContent === "RF ON") as HTMLButtonElement | undefined;
    rf?.click();
    return !!rf;
  });
  await new Promise((r) => setTimeout(r, 400));

  // SELFTEST
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll(".power-row button"));
    (btns.find((b) => b.textContent === "SELFTEST") as HTMLButtonElement)?.click();
  });
  await new Promise((r) => setTimeout(r, 600));

  await page.screenshot({ path: `${SHOTS}/03_freq_lock.png` });

  // --- Коридор (фаза 3): START SWEEP → маркер движется → телеметрия в логе ---
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    (btns.find((b) => b.textContent === "START SWEEP") as HTMLButtonElement)?.click();
  });
  await new Promise((r) => setTimeout(r, 700));
  const marker1 = await page.$eval(".range-marker", (el) => (el as HTMLElement).style.left);
  await new Promise((r) => setTimeout(r, 900));
  const marker2 = await page.$eval(".range-marker", (el) => (el as HTMLElement).style.left);
  await page.screenshot({ path: `${SHOTS}/04_corridor.png` });

  // STOP
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    (btns.find((b) => b.textContent === "STOP") as HTMLButtonElement)?.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  // Проверки содержимого
  const lockText = await page.$eval(".lock-badge", (el) => el.textContent);
  const logText = await page.$eval(".log-scroll", (el) => el.textContent ?? "");
  const stateText = await page.$eval(".state-badge", (el) => el.textContent);

  const checks = [
    ["LOCK badge = LOCK ✓", lockText === "LOCK ✓"],
    ["state = CONNECTED", stateText === "CONNECTED"],
    ["log has SET FREQ 2475", logText.includes("SET FREQ 2475.000000")],
    ["log has LOCK=1 reply", logText.includes("FREQ=2475.000000 LOCK=1")],
    ["log has RF ON", logText.includes("OK RF ON")],
    ["log has SELFTEST pass", logText.includes("selftest pass=1")],
    ["RF button clicked", rfClicked],
    ["log has SWEEP START", logText.includes("SWEEP START 2400 2500")],
    ["log has SWEEP RUNNING", logText.includes("OK SWEEP RUNNING")],
    ["log has telemetry", logText.includes("\"mode\":\"SWEEP\"")],
    ["маркер движется", marker1 !== marker2],
    ["log has STOP→IDLE", logText.includes("OK IDLE")],
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed++;
  }

  await browser.close();
  console.log(failed === 0 ? "\nGUI: ALL PASS" : `\nGUI: ${failed} FAILURES`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
