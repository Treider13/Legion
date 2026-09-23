// LEGION — ручная проверка вкладки КАСТОМ FPGA в живом UI (dev-server :5173).
// Не часть CI: gui_test.ts старее cinema-перестройки (падает и на main).
import puppeteer from "puppeteer-core";

const BASE = process.env.LEGION_URL ?? "http://localhost:5173";

async function waitFor(page: any, fn: string, timeoutMs = 15000): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const ok = await page.evaluate(fn);
    if (ok) return;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout: ${fn}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

const browser = await puppeteer.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.evaluateOnNewDocument(() => {
  sessionStorage.setItem("legion_booted", "1");
  sessionStorage.setItem("legion_contour", "live");
});
await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 25000 });
await waitFor(page, `!!document.querySelector(".hero")`);
await new Promise((r) => setTimeout(r, 1500));

// Настройки (шестерёнка в доке)
await page.evaluate(() => {
  const btns = Array.from(document.querySelectorAll("button"));
  (btns.find((b) => /настрой/i.test(b.textContent ?? "")) as HTMLButtonElement | undefined)?.click();
});
await waitFor(page, `!!document.querySelector('[data-workspace="sdrCustom"]')`);

// Вкладка КАСТОМ FPGA
await page.evaluate(() => {
  (document.querySelector('[data-workspace="sdrCustom"]') as HTMLButtonElement)?.click();
});
await waitFor(page, `Array.from(document.querySelectorAll(".panel-title")).some(e => e.textContent.includes("КАСТОМ FPGA"))`);
await new Promise((r) => setTimeout(r, 800));

const facts = await page.evaluate(() => {
  const text = document.body.innerText;
  const titles = Array.from(document.querySelectorAll(".panel-title")).map((e) => e.textContent);
  const buttons = Array.from(document.querySelectorAll("button")).map((b) => b.textContent?.trim());
  return {
    titles,
    hasBuild: buttons.some((b) => b === "СОБРАТЬ"),
    hasFlash: buttons.some((b) => b === "ПРОШИТЬ"),
    hasToolchain: buttons.some((b) => b === "ПРОВЕРИТЬ ТУЛЧЕЙН"),
    mentionsBoards: text.includes("x40") && text.includes("xA4"),
    envLine: text.includes("среда не проверена") || text.includes("стенд") || text.includes("не найден") || text.includes("desktop LEGION"),
    navCount: document.querySelectorAll(".ws-group")[1]?.querySelectorAll(".ws-tab").length ?? 0,
  };
});
console.log(JSON.stringify(facts, null, 2));
await page.screenshot({ path: "/tmp/legion_shots/custom_fpga_tab.png" });

const ok =
  facts.hasBuild &&
  facts.hasFlash &&
  facts.hasToolchain &&
  facts.mentionsBoards &&
  facts.navCount === 5;
console.log(ok ? "CUSTOM TAB GUI: PASS" : "CUSTOM TAB GUI: FAIL");
await browser.close();
process.exit(ok ? 0 : 1);
