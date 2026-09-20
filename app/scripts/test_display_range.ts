import assert from "node:assert/strict";
import { test } from "node:test";
import { displayRange, displayRangeNotice, formatDisplayRange, formatFrequency, frequencyTicks } from "../src/components/displayRange";

const state = {
  workspace: "scan",
  sdrBands: [] as { f1Mhz: number; f2Mhz: number }[],
  sdrF1: "2000",
  sdrF2: "2100",
  corrF1: "430.125",
  corrF2: "440.875",
};

test("all SDR workspaces use the same arbitrary corridor", () => {
  for (const workspace of ["sdr", "scan", "signal", "sdrFlash", "sdrCustom"]) {
    for (const [sdrF1, sdrF2] of [["2000", "2100"], ["2200", "2400"], ["2037.125", "2089.875"], ["0", "0.001"]]) {
      const range = displayRange({ ...state, workspace, sdrF1, sdrF2 });
      assert.deepEqual(range, { f1: Number(sdrF1), f2: Number(sdrF2) });
      assert.equal(formatDisplayRange(range), `${sdrF1}–${sdrF2} МГц`);
    }
  }
});

test("configured bands take precedence without borrowing another mode's settings", () => {
  const settings = { ...state, sdrBands: [{ f1Mhz: 2300.125, f2Mhz: 2310.875 }, { f1Mhz: 2000.5, f2Mhz: 2010.25 }] };
  assert.deepEqual(displayRange(settings), { f1: 2000.5, f2: 2310.875 });
  assert.deepEqual(displayRange({ ...settings, workspace: "corridor" }), { f1: 430.125, f2: 440.875 });
  assert.equal(displayRange({ ...settings, sdrBands: [...settings.sdrBands, { f1Mhz: NaN, f2Mhz: 2400 }] }), null);
});

test("invalid or incomplete input never becomes a default corridor", () => {
  for (const [sdrF1, sdrF2] of [["", "2100"], [" ", "2100"], ["2000", ""], ["2000MHz", "2100"], ["0x10", "2100"], ["NaN", "2100"], ["2000", "Infinity"], ["-1", "2100"], ["2100", "2000"]]) {
    const range = displayRange({ ...state, sdrF1, sdrF2 });
    assert.equal(range, null, `${sdrF1} / ${sdrF2}`);
    assert.equal(formatDisplayRange(range), "Коридор не задан");
  }
  assert.equal(formatFrequency(null), "—");
  assert.equal(formatFrequency(NaN), "—");
});

test("a supported single-frequency entry does not invalidate other bands", () => {
  const point = { f1Mhz: 2037.125, f2Mhz: 2037.125 };
  const range = displayRange({ ...state, sdrBands: [point] });
  assert.deepEqual(range, { f1: 2037.125, f2: 2037.125 });
  assert.equal(formatDisplayRange(range), "2037.125 МГц");
  assert.equal(displayRangeNotice(range), "Одна частота · 2037.125 МГц");
  assert.deepEqual(frequencyTicks(range!, 800), []);
  const mixed = displayRange({ ...state, sdrBands: [point, { f1Mhz: 2200, f2Mhz: 2400 }] });
  assert.deepEqual(mixed, { f1: 2037.125, f2: 2400 });
  assert.equal(displayRangeNotice(mixed), null);
  assert.deepEqual(displayRange({ ...state, sdrF1: "2037.125", sdrF2: "2037.125" }), range);
});

test("fractional axis labels stay distinct at narrow and wide spans", () => {
  for (const range of [{ f1: 2000, f2: 2100 }, { f1: 2037.125, f2: 2037.875 }, { f1: 2037.12501, f2: 2037.12509 }, { f1: 0, f2: 6000 }]) {
    for (const width of [160, 320, 1280]) {
      const ticks = frequencyTicks(range, width);
      assert.ok(ticks.length >= 1 && ticks.length <= 10);
      assert.ok(ticks.every((f) => f >= range.f1 && f <= range.f2));
      assert.deepEqual([...ticks].sort((a, b) => a - b), ticks);
      const labels = ticks.map((f) => formatFrequency(f));
      assert.equal(new Set(labels).size, ticks.length);
      for (let i = 0; i < ticks.length; i++) assert.equal(Number(labels[i]), ticks[i]);
    }
    assert.equal(Number(formatFrequency(range.f1)), range.f1);
    assert.equal(Number(formatFrequency(range.f2)), range.f2);
  }
  assert.equal(formatFrequency(2037.12504, 0.00008 / 800), "2037.12504");
  assert.deepEqual(frequencyTicks({ f1: 2100, f2: 2000 }, 800), []);
});

test("changing a measured frequency does not move the configured display corridor", () => {
  for (const lastForwardMhz of [2000, 2007.125, 2099.875, 2100]) {
    const snapshot = { ...state, lastForwardMhz, scanCenterMhz: lastForwardMhz };
    assert.deepEqual(displayRange(snapshot), { f1: 2000, f2: 2100 });
  }
});
