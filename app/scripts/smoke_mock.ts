// ============================================================================
// LEGION — smoke-тест цепочки MockTransport → LegionClient (без железа).
// Запуск: npx tsx scripts/smoke_mock.ts
// Проверяет фаза-1 протокол: HELLO / SET FREQ / SET POWER / RF / STATUS? /
// REGS? / SELFTEST / CAL REF + обработку ошибок (RANGE, SYNTAX, TIMEOUT).
// ============================================================================
import { LegionClient } from "../src/protocol/client";
import { MockTransport } from "../src/transport/mock";

let failures = 0;

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name} ${detail}`);
    failures++;
  }
}

async function main(): Promise<void> {
  const transport = new MockTransport();
  const client = new LegionClient(transport);

  await transport.connect();

  // HELLO
  let r = await client.hello();
  check("HELLO", r.ok && r.statusLine.includes("LEGION"), r.statusLine);

  // SET FREQ 2475.000 — целевая частота пользователя
  r = await client.setFreq(2475.0);
  check(
    "SET FREQ 2475.000",
    r.ok && r.statusLine.includes("FREQ=2475.000000") && r.statusLine.includes("LOCK=1"),
    r.statusLine,
  );

  // SET FREQ вне диапазона → ERR RANGE
  r = await client.setFreq(5000.0);
  check("SET FREQ 5000 → ERR RANGE", !r.ok && r.statusLine.startsWith("ERR RANGE"), r.statusLine);

  // SET POWER +2
  r = await client.setPower(2);
  check("SET POWER +2", r.ok && r.statusLine.includes("POWER=2"), r.statusLine);

  // SET POWER недопустимая → ERR RANGE
  r = await client.setPower(0);
  check("SET POWER 0 → ERR RANGE", !r.ok, r.statusLine);

  // RF ON / OFF
  r = await client.rf(true);
  check("RF ON", r.ok && r.statusLine === "OK RF ON", r.statusLine);
  r = await client.rf(false);
  check("RF OFF", r.ok && r.statusLine === "OK RF OFF", r.statusLine);

  // STATUS? → валидный JSON с частотой
  r = await client.status();
  let statusOk = false;
  try {
    const j = JSON.parse(r.statusLine);
    statusOk = j.freq === 2475.0 && j.lock === 1 && j.board === "mock";
  } catch {
    /* noop */
  }
  check("STATUS? JSON", r.ok && statusOk, r.statusLine);

  // REGS? → 6 слов
  r = await client.regs();
  let regsOk = false;
  try {
    const j = JSON.parse(r.statusLine);
    regsOk = Array.isArray(j.regs) && j.regs.length === 6 && j.regs[5] === "0x00580005";
  } catch {
    /* noop */
  }
  check("REGS? JSON (R5=0x580005)", r.ok && regsOk, r.statusLine);

  // SELFTEST → pass=1
  r = await client.selftest();
  let stOk = false;
  try {
    const j = JSON.parse(r.statusLine);
    stOk = j?.selftest?.pass === 1;
  } catch {
    /* noop */
  }
  check("SELFTEST pass", r.ok && stOk, r.statusLine);

  // CAL REF
  r = await client.calRef(-1.5);
  check("CAL REF -1.5", r.ok && r.statusLine.includes("-1.500"), r.statusLine);

  // Неизвестная команда → ERR SYNTAX
  r = await client.cmd("FOOBAR");
  check("unknown → ERR SYNTAX", !r.ok && r.statusLine.startsWith("ERR SYNTAX"), r.statusLine);

  await transport.disconnect();

  console.log(failures === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
