// ============================================================================
// LEGION — GUI-тест фазы 5: дизайн-система LEGION.
// ВАЖНО: ожидания через Node-side poll (page.evaluate по CDP) — в headless
// Chrome с software-GL страничные rAF/таймеры голодают (проверено: waitFor-
// Function не срабатывал при живом DOM). Не использовать page.waitForFunction.
// ============================================================================
import puppeteer, { type Page } from "puppeteer-core";

const BASE = process.env.LEGION_URL ?? "http://localhost:5173";
const SHOTS = "/tmp/legion_shots";

/** Node-side poll: устойчив к голоданию таймеров страницы под software-GL */
async function waitFor(
  page: Page,
  fn: string,
  timeoutMs = 15000,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(fn);
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${fn}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.evaluateOnNewDocument(() => {
    sessionStorage.setItem("legion_booted", "1");
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 25000 });
  await waitFor(page, `!!document.querySelector(".hero")`);
  await new Promise((r) => setTimeout(r, 2500)); // 3D сцена + шрифты
  await page.screenshot({ path: `${SHOTS}/10_design_hero.png` });

  // MOCK connect
  await page.select("section.connect-bar select", "mock");
  await page.click("section.connect-bar button.btn-primary");
  await waitFor(page, `!!document.querySelector(".state-connected")`);

  // Panel-частота удалена — тест работает с коридором напрямую.
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await new Promise((r) => setTimeout(r, 400));

  // Коридор: старт (кнопка «ПОДАВИТЬ ЦЕЛЬ»)
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    (btns.find((b) => b.textContent?.includes("ПОДАВИТЬ")) as HTMLButtonElement)?.click();
  });
  await waitFor(page, `!!document.querySelector(".range-marker")`);
  const marker1 = await page.$eval(".range-marker", (el) => (el as HTMLElement).style.left);
  await waitFor(
    page,
    `(() => { const m = document.querySelector(".range-marker"); return m && m.style.left !== ${JSON.stringify(marker1)}; })()`,
  );
  const marker2 = await page.$eval(".range-marker", (el) => (el as HTMLElement).style.left);
  await page.screenshot({ path: `${SHOTS}/12_design_corridor.png` });

  // Hero-статус должен показать активное подавление
  const heroStatus = await page.$eval(".hero-status", (el) => el.textContent ?? "");
  // Live-показание коридора (телеметрия парсится в UI, в журнал не пишется —
  // это отдельный live-маркер, см. фикс подвисания). Частота в коридоре.
  const rangeCur = await page.$eval(".range-cur", (el) => el.textContent ?? "");
  const curNum = parseFloat(rangeCur);

  // STOP
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    (btns.find((b) => b.textContent === "СТОП") as HTMLButtonElement)?.click();
  });

  // Проверки
  const logText = await page.$eval(".log-scroll", (el) => el.textContent ?? "");

  const checks: Array<[string, boolean]> = [
    ["log has SWEEP RUNNING", logText.includes("OK SWEEP RUNNING")],
    ["telemetry flows (live readout)", rangeCur.includes("МГц") && curNum >= 2400 && curNum <= 2500],
    ["маркер движется", marker1 !== marker2],
    ["hero-статус = ПОДАВЛЕНИЕ ЦЕЛИ", heroStatus.includes("ПОДАВЛЕНИЕ")],
  ];

  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed++;
  }

  await browser.close();
  console.log(failed === 0 ? "\nGUI DESIGN: ALL PASS" : `\nGUI DESIGN: ${failed} FAILURES`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
