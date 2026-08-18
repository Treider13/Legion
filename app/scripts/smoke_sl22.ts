// LEGION — smoke переводчика HTOOL SL22 (без прибора).
// Запуск: npx tsx scripts/smoke_sl22.ts
import { mapLegionToSl22, sl22StatusJson, stepKhzToMhz } from "../src/sl22/map";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures++;
  }
}

function main(): void {
  check("1 МГц шаг: 1000 кГц → 1.000 МГц", stepKhzToMhz(1000) === 1);

  let m = mapLegionToSl22("HELLO");
  check("HELLO → *IDN?", m.scpi[0] === "*IDN?" && m.reply.includes("SL22"), m.reply);

  m = mapLegionToSl22("SET FREQ 2475.000");
  check(
    "SET FREQ 2475 → POINt",
    m.scpi[0] === "GENErator:POINt 2475.000" && m.reply.includes("LOCK=1"),
    m.scpi.join("|") + " " + m.reply,
  );

  m = mapLegionToSl22("SET FREQ 20");
  check("20 МГц → ERR RANGE", m.scpi.length === 0 && m.reply.startsWith("ERR RANGE"), m.reply);

  m = mapLegionToSl22("SET FREQ 23000");
  check("23 ГГц → ERR RANGE", m.reply.startsWith("ERR RANGE"), m.reply);

  m = mapLegionToSl22("SET POWER 5");
  check("SET POWER +5 → LOPW 6", m.scpi[0] === "FREQuency:LOPW 6", m.scpi.join());

  m = mapLegionToSl22("SET POWER -4");
  check("SET POWER -4 → LOPW 0", m.scpi[0] === "FREQuency:LOPW 0", m.scpi.join());

  m = mapLegionToSl22("RF ON");
  check("RF ON", m.scpi[0] === "GENErator:STATus ON", m.scpi.join());

  m = mapLegionToSl22("SWEEP START 2300 2500 STEP 1000 DWELL 10");
  check(
    "коридор 2300–2500 шаг 1 МГц",
    m.scpi[0] === "GENErator:CYCLe 2300.000,2500.000,1.000,10" &&
      m.scpi[1] === "GENErator:STATus ON" &&
      m.reply.includes("SWEEP RUNNING"),
    m.scpi.join(" ; "),
  );

  m = mapLegionToSl22("SWEEP START 2400 2500 STEP 1000 DWELL 0");
  check("dwell 0 → ERR DWELL", m.reply.startsWith("ERR DWELL"), m.reply);

  m = mapLegionToSl22("HOP START 2400 2500 RATE 10 SEED 1 STEP 1000");
  check("HOP → ERR STATE", m.reply.startsWith("ERR STATE"), m.reply);

  m = mapLegionToSl22("CHIRP START 2400 2500 STEP 1 DWELL 10");
  check("CHIRP → ERR STATE", m.reply.startsWith("ERR STATE"), m.reply);

  m = mapLegionToSl22("SET ATT 3");
  check("SET ATT → ERR STATE", m.reply.startsWith("ERR STATE"), m.reply);

  const j = JSON.parse(
    sl22StatusJson({ freqMhz: 2475, rfOn: true, powerDbm: 5, mode: "SWEEP" }),
  );
  check("STATUS board", j.board === "htool-sl22" && j.lock === 1 && j.rf === 1);

  console.log(failures === 0 ? "\nSL22 SMOKE: ALL PASS" : `\nSL22 SMOKE: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
