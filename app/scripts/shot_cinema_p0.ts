import puppeteer from "puppeteer-core";

async function main(): Promise<void> {
  const b = await puppeteer.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 900 });
  await p.evaluateOnNewDocument(() => sessionStorage.setItem("legion_booted", "1"));
  await p.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 2500));
  await p.screenshot({ path: "/tmp/legion_shots/p0_hero_status.png" });
  const click = async (text: string, exact = false) => {
    await p.evaluate((t, ex) => {
      const btns = Array.from(document.querySelectorAll("button"));
      const el = btns.find((x) => (ex ? x.textContent?.trim() === t : x.textContent?.includes(t)));
      (el as HTMLButtonElement | undefined)?.click();
    }, text, exact);
  };
  await click("Умный");
  await new Promise((r) => setTimeout(r, 300));
  await click("Запустить", true);
  await new Promise((r) => setTimeout(r, 500));
  await click("Продолжить");
  await new Promise((r) => setTimeout(r, 500));
  await p.screenshot({ path: "/tmp/legion_shots/p0_gate_paths.png" });
  await click("Автоматический перехват");
  await click("Продолжить");
  await new Promise((r) => setTimeout(r, 400));
  await p.screenshot({ path: "/tmp/legion_shots/p0_gate_auto.png" });
  await b.close();
  console.log("shots ok");
}

void main();
