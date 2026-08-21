// Рендер 5 вариантов дизайна в PNG (ручной инструмент, не CI).
// Запуск из app/: npx tsx ../docs/design/variants/shoot.mts
import puppeteer from "puppeteer-core";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Пути: по умолчанию — рядом со скриптом; переопределяются env
// (модуль puppeteer-core резолвится только из app/: запускать копией
// из app/scripts или с NODE_PATH — см. README папки).
const here = process.env.OUT_DIR ?? dirname(fileURLToPath(import.meta.url));
const htmlPath = process.env.HTML_PATH ?? join(here, "index.html");

async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1440,900"],
  });
  const names = ["", "v1-aurora-pro", "v2-lab-instrument", "v3-tactical-hud", "v4-mission-control", "v5-minimal-pro"];
  for (let v = 1; v <= 5; v++) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`file://${htmlPath}`, { waitUntil: "load" });
    await page.evaluate(`document.body.className = "v${v}"`);
    await new Promise((r) => setTimeout(r, 600));
    await page.screenshot({ path: join(here, `${names[v]}.png`) });
    await page.close();
    console.log("OK", names[v]);
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
