import puppeteer from "puppeteer-core";
async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE:", m.text()); });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 3000));
  const hasHero = await page.evaluate(() => !!document.querySelector(".hero"));
  console.log("hero present:", hasHero);
  await browser.close();
}
void main();
