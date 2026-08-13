// ============================================================================
// LEGION — LegionClient: протокольный слой поверх Transport.
// cmd(): отправка команды, сбор ответа до OK/ERR/JSON, таймаут.
// Сырой поток строк пробрасывается в журнал.
// ============================================================================
import type { Transport } from "../transport/types";

export interface CmdResult {
  ok: boolean;
  lines: string[];
  /** Первая строка OK/ERR */
  statusLine: string;
}

const RESP_TIMEOUT_MS = 2000;

export class LegionClient {
  private waiters: Array<{
    resolve: (r: CmdResult) => void;
    lines: string[];
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.setEvents({
      onLine: (line) => {
        this.onRawLine?.(line);
        this.dispatch(line);
      },
      onState: (st, detail) => this.onStateChange?.(st, detail),
    });
  }

  /** Сырой поток (для журнала) */
  onRawLine: ((line: string) => void) | null = null;
  /** Состояние транспорта */
  onStateChange:
    | ((state: import("../transport/types").TransportState, detail?: string) => void)
    | null = null;

  private dispatch(line: string): void {
    this.onRawLine?.(line);
    const w = this.waiters[0];
    if (!w) return;
    w.lines.push(line);
    // Завершение ответа: строка OK/ERR или JSON-объект
    if (line.startsWith("OK") || line.startsWith("ERR") || line.startsWith("{")) {
      clearTimeout(w.timer);
      this.waiters.shift();
      w.resolve({
        ok: line.startsWith("OK") || line.startsWith("{"),
        lines: w.lines,
        statusLine: line,
      });
    }
  }

  async cmd(command: string, timeoutMs = RESP_TIMEOUT_MS): Promise<CmdResult> {
    const p = new Promise<CmdResult>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        resolve({ ok: false, lines: [], statusLine: "ERR TIMEOUT" });
      }, timeoutMs);
      this.waiters.push({ resolve, lines: [], timer });
    });
    await this.transport.writeLine(command);
    return p;
  }

  /** Удобные обёртки фазы 1 */
  hello() { return this.cmd("HELLO"); }
  setFreq(mhz: number) { return this.cmd(`SET FREQ ${mhz.toFixed(6)}`); }
  setPower(dbm: number) { return this.cmd(`SET POWER ${dbm}`); }
  rf(on: boolean) { return this.cmd(on ? "RF ON" : "RF OFF"); }
  status() { return this.cmd("STATUS?"); }
  regs() { return this.cmd("REGS?"); }
  selftest() { return this.cmd("SELFTEST", 5000); }
  calRef(ppm: number) { return this.cmd(`CAL REF ${ppm}`); }
}
