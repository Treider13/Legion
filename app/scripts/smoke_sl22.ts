// LEGION — smoke переводчика HTOOL SL22 (без прибора).
import { mapLegionToSl22, sl22StatusJson, stepKhzToMhz, sweepNextMhz } from "../src/sl22/map";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures++;
  }
}

function main(): void {
  check("1000 кГц → 1 МГц", stepKhzToMhz(1000) === 1);

  // firmware test_engine_math: 2400,2401,2402,2403, wrap → 2400 (шаг 1 МГц)
  {
    let f = 2400;
    const seq: number[] = [];
    for (let i = 0; i < 4; i++) {
      f = sweepNextMhz(f, 2400, 2403, 1);
      seq.push(f);
    }
    check("sweep wrap как engine_sweep_next", seq.join(",") === "2401,2402,2403,2400", seq.join(","));
  }

  let m = mapLegionToSl22("HELLO");
  check("HELLO → *IDN?", m.scpi[0] === "*IDN?" && m.reply.includes("SL22"));

  m = mapLegionToSl22("SET FREQ 2475.000");
  check(
    "SET FREQ → POINt, без выдуманного LOCK",
    m.scpi[0] === "GENErator:POINt 2475.000" && !m.reply.includes("LOCK"),
    m.reply,
  );

  m = mapLegionToSl22("SET FREQ 20");
  check("20 МГц → ERR RANGE (ниже 45)", m.reply.startsWith("ERR RANGE"));

  m = mapLegionToSl22("SET FREQ 5000");
  check("5000 МГц на SL22 в полосе", m.reply.startsWith("OK") && m.scpi[0] === "GENErator:POINt 5000.000");

  m = mapLegionToSl22("SET POWER 5");
  check("SET POWER +5 → LOPW 3 (не дБм)", m.scpi[0] === "FREQuency:LOPW 3", m.scpi.join());

  m = mapLegionToSl22("SET POWER -4");
  check("SET POWER -4 → LOPW 0", m.scpi[0] === "FREQuency:LOPW 0");

  m = mapLegionToSl22("RF ON");
  check("RF ON → STATus ON", m.scpi[0] === "GENErator:STATus ON");

  m = mapLegionToSl22("SWEEP START 2300 2500 STEP 1000 DWELL 10");
  check("SWEEP не шлёт выдуманный CYCLe с 4 полями", !m.scpi.some((s) => s.includes("CYCLe")));
  check("SWEEP сначала POINt f1 (гайд: частота, потом RF)", m.scpi[0] === "GENErator:POINt 2300.000", m.scpi.join(" | "));
  check("SWEEP затем STATus ON", m.scpi[1] === "GENErator:STATus ON");
  check(
    "план коридора 1 МГц / 10 мс",
    m.sweep?.f1 === 2300 && m.sweep?.f2 === 2500 && m.sweep?.stepMhz === 1 && m.sweep?.dwellMs === 10,
    JSON.stringify(m.sweep),
  );

  m = mapLegionToSl22("SWEEP START 2500 2400 STEP 1000 DWELL 10");
  check("f1>f2 → ERR RANGE (как прошивка)", m.reply.startsWith("ERR RANGE"));

  m = mapLegionToSl22("SWEEP START 2400 2500 STEP 1000 DWELL 0");
  check("dwell 0 → ERR DWELL", m.reply.startsWith("ERR DWELL"));

  m = mapLegionToSl22("HOP START 2400 2500 RATE 10 SEED 1 STEP 1000");
  check("HOP → ERR STATE", m.reply.startsWith("ERR STATE"));

  m = mapLegionToSl22("SET ATT 3");
  check("SET ATT → ERR STATE", m.reply.startsWith("ERR STATE"));

  const j = JSON.parse(
    sl22StatusJson({ freqMhz: 2475, rfOn: true, powerDbm: 5, mode: "SWEEP" }),
  );
  check("STATUS lock=0 (нет LD)", j.lock === 0 && j.board === "htool-sl22");

  console.log(failures === 0 ? "\nSL22 SMOKE: ALL PASS" : `\nSL22 SMOKE: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
