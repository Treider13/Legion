// Скриншот вкладки ТИП СИГНАЛА (ручная проверка, не CI).
import puppeteer from "puppeteer-core";

const BASE = process.env.LEGION_URL ?? "http://localhost:5173";

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

  // Ждём консоль и жмём вкладку ТИП СИГНАЛА
  for (;;) {
    const ok = await page.evaluate(
      `!!document.querySelector('[data-workspace="signal"]')`,
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  await page.evaluate(
    `document.querySelector('[data-workspace="signal"]').click()`,
  );
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(
    `document.querySelector('.console')?.scrollIntoView()`,
  );
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: "/tmp/legion_signal_qpsk.png" });

  // AWGN для контраста спектра
  await page.evaluate(`(() => {
    const sel = document.querySelector('[aria-label="Тип сигнала"]');
    sel.value = "awgn";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: "/tmp/legion_signal_awgn.png" });

  // Кнопка ЗАШИТЬ в эмуляции: должен появиться лог ЭМУЛЯЦИЯ TX
  await page.evaluate(`(() => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => x.textContent && x.textContent.includes("ЗАШИТЬ НА SDR"));
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));
  const log = await page.evaluate(
    `document.querySelector('.console')?.textContent ?? ""`,
  );
  console.log("LOG HAS ЭМУЛЯЦИЯ TX awgn:", String(log).includes("ЭМУЛЯЦИЯ TX awgn"));
  await page.screenshot({ path: "/tmp/legion_signal_tx.png" });
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
