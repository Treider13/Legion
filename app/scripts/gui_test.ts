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

  // Puppeteer click авто-скроллит к кнопке (console ниже hero) — наверх к дайлу
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await new Promise((r) => setTimeout(r, 400));

  // Wheel на дайле → перестройка → коммит через ~300 мс
  const dial = await page.$(".freq-dial");
  const box = await dial!.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel({ deltaY: -120 }); // +0.1 MHz
  await new Promise((r) => setTimeout(r, 900));

  // LOCK-скобки: TARGET LOCKED
  await waitFor(page, `!!document.querySelector(".lock-frame.locked")`);
  await page.screenshot({ path: `${SHOTS}/11_design_locked.png` });

  // Коридор: START SWEEP
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    (btns.find((b) => b.textContent?.includes("START")) as HTMLButtonElement)?.click();
  });
  await waitFor(page, `!!document.querySelector(".range-marker")`);
  const marker1 = await page.$eval(".range-marker", (el) => (el as HTMLElement).style.left);
  await waitFor(
    page,
    `(() => { const m = document.querySelector(".range-marker"); return m && m.style.left !== ${JSON.stringify(marker1)}; })()`,
  );
  const marker2 = await page.$eval(".range-marker", (el) => (el as HTMLElement).style.left);
  await page.screenshot({ path: `${SHOTS}/12_design_corridor.png` });

  // STOP
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    (btns.find((b) => b.textContent === "STOP") as HTMLButtonElement)?.click();
  });

  // Проверки
  const lockCaption = await page.$eval(".lock-caption", (el) => el.textContent);
  const logText = await page.$eval(".log-scroll", (el) => el.textContent ?? "");
  const heroCorr = await page.$eval(".hero-corr", (el) => el.textContent ?? "");

  const checks: Array<[string, boolean]> = [
    ["lock caption = TARGET LOCKED", lockCaption === "TARGET LOCKED"],
    ["log has SET FREQ (wheel→commit)", /SET FREQ 2475\.1/.test(logText)],
    ["log has LOCK=1", logText.includes("LOCK=1")],
    ["log has SWEEP RUNNING", logText.includes("OK SWEEP RUNNING")],
    ["telemetry flows", logText.includes("\"mode\":\"SWEEP\"")],
    ["маркер движется", marker1 !== marker2],
    ["hero corr показывал активность", heroCorr.includes("CORRIDOR")],
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
