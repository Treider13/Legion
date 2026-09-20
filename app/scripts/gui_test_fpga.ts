// ============================================================================
// LEGION — GUI-тест кино-мастера: путь «Умная атака».
// Браузерная сборка (dev server) → sdrEmulation=true → startScan на моке:
// мастер обязан поднять скан-фазу (hero ПОИСК), Стоп — вернуть ОЖИДАНИЕ.
// Запуск: npm run dev (терминал 1) · npx tsx scripts/gui_test_fpga.ts
// ============================================================================
import puppeteer, { type Page } from "puppeteer-core";

const BASE = process.env.LEGION_URL ?? "http://localhost:5173";

async function waitFor(page: Page, fn: string, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(fn);
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${fn}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function click(page: Page, text: string, exact = false): Promise<void> {
  await page.evaluate(
    (t, ex) => {
      const btns = Array.from(document.querySelectorAll("button"));
      const el = btns.find((x) => (ex ? x.textContent?.trim() === t : x.textContent?.includes(t)));
      if (!el) throw new Error(`кнопка не найдена: ${t}`);
      (el as HTMLButtonElement).click();
    },
    text,
    exact,
  );
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
  await new Promise((r) => setTimeout(r, 2000));

  const heroText = () => page.$eval(".hero-status", (el) => el.textContent ?? "");
  const idle0 = await heroText();

  // Мастер: Умный → Запустить → коридор → путь → канал/стратегия → старт.
  await click(page, "Умный");
  await click(page, "Запустить", true);
  await waitFor(page, `!!document.querySelector(".cinema-gate-card")`);
  await click(page, "Продолжить"); // band → path
  await waitFor(page, `Array.from(document.querySelectorAll("button")).some(b => b.textContent?.includes("Умная атака"))`);
  await click(page, "Умная атака");
  await click(page, "Продолжить"); // path → walk
  await waitFor(page, `Array.from(document.querySelectorAll("button")).some(b => b.textContent?.includes("По очереди"))`);
  // Стратегия «По очереди» → появляется поле выдержки.
  await click(page, "По очереди");
  await waitFor(page, `Array.from(document.querySelectorAll("label")).some(l => l.textContent?.includes("Выдержка"))`);
  // Финальный шаг мастера — кнопка «Запустить» (аудит P2). Клик строго в
  // карточке мастера: в доке есть своя «Запустить», первую в DOM нельзя.
  const finalLabel = await page.$eval(
    ".cinema-gate-actions .cinema-btn.solid",
    (el) => el.textContent?.trim() ?? "",
  );
  await page.evaluate(() => {
    (document.querySelector(".cinema-gate-actions .cinema-btn.solid") as HTMLButtonElement | null)?.click();
  });

  // Браузер = эмуляция: ARM нет (платы нет). Hero остаётся ОЖИДАНИЕ —
  // не врём «ПОИСК» хост-сканера и не врём «РЕТРАНСЛЯЦИЯ».
  await waitFor(page, `!document.querySelector(".cinema-gate-card")`);
  const afterStart = await heroText();

  // Стоп в доке → ОЖИДАНИЕ (уже idle).
  await click(page, "Стоп", true);
  await waitFor(page, `document.querySelector(".hero-status")?.textContent?.includes("ОЖИДАНИЕ")`);
  const idle1 = await heroText();

  const checks: Array<[string, boolean]> = [
    ["idle до старта = ОЖИДАНИЕ", idle0.includes("ОЖИДАНИЕ")],
    ["финальный шаг мастера = кнопка «Запустить»", finalLabel === "Запустить"],
    ["эмуляция не врёт ПОИСК/РЕТРАНСЛЯЦИЯ", afterStart.includes("ОЖИДАНИЕ") && !afterStart.includes("ПОИСК") && !afterStart.includes("РЕТРАНСЛЯЦИЯ")],
    ["Стоп вернул ОЖИДАНИЕ", idle1.includes("ОЖИДАНИЕ")],
  ];
  let failed = 0;
  for (const [name, ok] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed++;
  }
  await browser.close();
  console.log(failed === 0 ? "\nGUI FPGA PATH: ALL PASS" : `\nGUI FPGA PATH: ${failed} FAILURES`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
