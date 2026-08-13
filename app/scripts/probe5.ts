import puppeteer from "puppeteer-core";
async function main(): Promise<void> {
  const browser = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  page.on("pageerror", (e) => console.log("PAGEERROR:", e.message));
  await page.evaluateOnNewDocument(() => sessionStorage.setItem("legion_booted", "1"));
  await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".hero", { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 2000));
  await page.select("section.connect-bar select", "mock");
  await page.click("section.connect-bar button.btn-primary");
  await page.waitForFunction(() => document.querySelector(".state-connected") !== null, { timeout: 5000, polling: 200 });
  // START SWEEP
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    (btns.find((b) => b.textContent?.includes("START")) as HTMLButtonElement)?.click();
  });
  await new Promise((r) => setTimeout(r, 1000));
  const dump = await page.evaluate(() => ({
    runningBadge: document.querySelector(".state-connected")?.textContent,
    marker: !!document.querySelector(".range-marker"),
    markerLeft: (document.querySelector(".range-marker") as HTMLElement)?.style.left,
    logTail: document.querySelector(".log-scroll")?.textContent?.slice(-300),
  }));
  console.log(JSON.stringify(dump, null, 1));
  await browser.close();
}
void main();
