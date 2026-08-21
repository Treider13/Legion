// E2E (ручная проверка, не CI): зашитый сигнал идёт во все TX-режимы.
// 1) ТИП СИГНАЛА → ЗАШИТЬ → TX с волной. 2) СТОП. 3) СКАН: АВТО → ПЕРЕДАТЬ
//    → handoff использует зашитую волну (не CW). 4) КАЧАНИЕ (без сканера) → то же.
import puppeteer from "puppeteer-core";

const BASE = process.env.LEGION_URL ?? "http://localhost:5173";

async function poll(page: puppeteer.Page, fn: string, timeoutMs = 20000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    if (await page.evaluate(fn)) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${fn}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

async function clickButton(page: puppeteer.Page, text: string): Promise<void> {
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll("button")]
      .find((x) => x.textContent && x.textContent.trim().startsWith("${text}") && !x.disabled);
    if (b) b.click();
  })()`);
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
  await poll(page, `!!document.querySelector('[data-workspace="signal"]')`);

  // --- 1) вкладка ТИП СИГНАЛА: выбрать qpsk (дефолт), ЗАШИТЬ ---
  await page.evaluate(`document.querySelector('[data-workspace="signal"]').click()`);
  await new Promise((r) => setTimeout(r, 900));
  await page.evaluate(`document.querySelector('.console')?.scrollIntoView()`);
  await page.screenshot({ path: "/tmp/legion_sig_panel.png" });
  await clickButton(page, "ЗАШИТЬ НА SDR");
  await new Promise((r) => setTimeout(r, 900));
  let log = String(await page.evaluate(`document.querySelector('.console')?.textContent ?? ""`));
  console.log("1. ЗАШИТЬ qpsk → ЭМУЛЯЦИЯ TX qpsk:", log.includes("ЭМУЛЯЦИЯ TX qpsk"));
  console.log("1. зашит для всех TX-режимов:", log.includes("зашит для всех TX-режимов"));
  await page.screenshot({ path: "/tmp/legion_sig_armed.png" });

  // --- 2) СТОП TX ---
  await clickButton(page, "СТОП TX");
  await new Promise((r) => setTimeout(r, 500));

  // --- 3) СКАН: АВТО + демо-несущая + ПЕРЕДАТЬ → handoff с волной ---
  await page.evaluate(`document.querySelector('[data-workspace="scan"]').click()`);
  await new Promise((r) => setTimeout(r, 500));
  await clickButton(page, "ДЕМО-НЕСУЩАЯ");
  await new Promise((r) => setTimeout(r, 300));
  await clickButton(page, "ПЕРЕДАТЬ");
  // ждём handoff с зашитой волной (qpsk), не CW
  try {
    await poll(
      page,
      `(document.querySelector('.console')?.textContent ?? "").includes("ЭМУЛЯЦИЯ TX qpsk 2442")`,
      15000,
    );
    console.log("3. АВТО handoff использует зашитую волну qpsk: true");
  } catch {
    console.log("3. АВТО handoff использует зашитую волну qpsk: FALSE");
  }
  log = String(await page.evaluate(`document.querySelector('.console')?.textContent ?? ""`));
  const statusLine = String(await page.evaluate(`document.querySelector('.status-line')?.textContent ?? ""`));
  console.log("3. status-line:", JSON.stringify(statusLine));
  console.log("3. lastCueReason несёт волну:", statusLine.includes("qpsk"));
  await page.screenshot({ path: "/tmp/legion_sig_auto.png" });
  await clickButton(page, "СТОП ПЕРЕДАЧУ");
  await new Promise((r) => setTimeout(r, 400));

  // --- 4) КАЧАНИЕ (без сканера): ПЕРЕДАТЬ → open-loop TX с волной ---
  await page.evaluate(`(() => {
    const sel = document.querySelector('[aria-label="Режим работы SDR"]');
    sel.value = "sweep";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  await clickButton(page, "ПЕРЕДАТЬ");
  await new Promise((r) => setTimeout(r, 2500));
  log = String(await page.evaluate(`document.querySelector('.console')?.textContent ?? ""`));
  const sweepHits = (log.match(/ЭМУЛЯЦИЯ TX qpsk/g) || []).length;
  console.log("4. open-loop КАЧАНИЕ использует qpsk (число TX):", sweepHits);
  await page.screenshot({ path: "/tmp/legion_sig_sweep.png" });
  await clickButton(page, "СТОП ПЕРЕДАЧУ");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
