// LEGION — финальные скриншоты: hero + console (полная страница)
import puppeteer from "puppeteer-core";
async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => sessionStorage.setItem("legion_booted", "1"));
  await page.goto("http://localhost:5173/?tier=high", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hero", { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 2500));

  // connect mock → коридор, чтобы консоль была «живой»
  await page.select("section.connect-bar select", "mock");
  await page.click("section.connect-bar button.btn-primary");
  await new Promise((r) => setTimeout(r, 1200));
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    (btns.find((b) => b.textContent?.includes("START")) as HTMLButtonElement)?.click();
  });
  await new Promise((r) => setTimeout(r, 1500));

  // hero
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: "/tmp/legion_shots/22_final_hero_live.png" });

  // console section
  await page.evaluate(() => window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }));
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: "/tmp/legion_shots/23_final_console_live.png" });
  await browser.close();
  console.log("done");
}
void main();
