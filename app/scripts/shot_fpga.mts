import puppeteer from "puppeteer-core";
async function main() {
  const b = await puppeteer.launch({ executablePath: "/usr/local/bin/google-chrome", headless: true, args: ["--no-sandbox","--disable-dev-shm-usage"] });
  const p = await b.newPage();
  await p.setViewport({ width: 1440, height: 1100 });
  await p.evaluateOnNewDocument(() => sessionStorage.setItem("legion_booted", "1"));
  await p.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
  await new Promise(r => setTimeout(r, 3500));
  await p.evaluate(`document.querySelector('[data-workspace="signal"]').click()`);
  await new Promise(r => setTimeout(r, 800));
  await p.evaluate(`(() => { const el = document.querySelector('.fpga-block'); if (el) el.scrollIntoView(); })()`);
  await new Promise(r => setTimeout(r, 400));
  // СТАТУС в браузере без Tauri → честный отказ
  await p.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent?.trim() === 'СТАТУС'); if (b) b.click(); })()`);
  await new Promise(r => setTimeout(r, 700));
  const txt = String(await p.evaluate(`document.querySelector('.fpga-block')?.textContent ?? ""`));
  console.log("FPGA block present:", txt.length > 50);
  console.log("FPGA honest no-Tauri status:", txt.includes("нужен desktop LEGION"));
  await p.screenshot({ path: "/tmp/legion_fpga_panel.png" });
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
