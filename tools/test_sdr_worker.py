#!/usr/bin/env python3
"""Протокол sdr_worker без железа: FAKE + ping + Soapy-факты."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WORKER = ROOT / "sdr_worker.py"


def rpc(proc: subprocess.Popen[str], msg: dict) -> dict:
    proc.stdin.write(json.dumps(msg) + "\n")
    proc.stdin.flush()
    line = proc.stdout.readline()
    return json.loads(line)


def main() -> int:
    env = os.environ.copy()
    env["LEGION_SDR_FAKE"] = "1"
    env["LEGION_FPGA_PORT"] = "5599"  # порт FPGA-агента в этом тесте
    proc = subprocess.Popen(
        [sys.executable, str(WORKER)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
        env=env,
    )
    assert proc.stdin and proc.stdout
    fails = 0

    def check(name: str, cond: bool) -> None:
        nonlocal fails
        print(("  PASS  " if cond else "  FAIL  ") + name)
        if not cond:
            fails += 1

    sys.path.insert(0, str(ROOT))
    import sdr_worker as w

    check("подсказка Soapy про venv/deadsnakes",
          "LEGION_PYTHON" in w.soapy_missing_reason() and "system-site-packages" in w.soapy_missing_reason())
    check("SoapyRemote args", w.parse_args("driver=remote,remote=tcp://10.0.0.5:55132") == {
        "driver": "remote",
        "remote": "tcp://10.0.0.5:55132",
    })
    check("LO = RF − fs/8 (Deepwave)", abs(w.cw_lo_hz(2442e6) - (2442e6 - w.TX_FS / 8)) < 1)
    check("LO при fs окна 20 МГц", abs(w.cw_lo_hz(2442e6, 20e6) - (2442e6 - 20e6 / 8)) < 1)
    check("Radio._tx_fs старт = TX_FS", abs(w.Radio()._tx_fs - w.TX_FS) < 1)

    to = w.stream_timeout_us(w.TX_N, w.TX_FS)
    block_us = w.TX_N / w.TX_FS * 1e6
    check("timeout ≥ 1s (не дефолт Soapy 100ms)", to >= 1_000_000)
    check("timeout ≥ 4× блока", to >= 4 * block_us - 1)

    check("stream_ret объект", w.stream_ret(type("S", (), {"ret": 4096})()) == 4096)
    check("stream_ret int (старый биндинг)", w.stream_ret(-1) == -1)
    check("stream_kind timeout", w.stream_kind(-1) == "timeout")
    check("stream_kind overflow", w.stream_kind(-4) == "overflow")
    check("stream_kind underflow", w.stream_kind(-7) == "underflow")
    check("stream_kind error", w.stream_kind(-2) == "error")
    check("stream_kind ok", w.stream_kind(4096) == "ok")

    if not w.NUMPY:
        print("  FAIL  numpy обязателен (tools/requirements.txt) — без него скан DIO-sys не проверяется")
        fails += 1
    if w.NUMPY:
        import numpy as np

        tone = w.make_cw()
        check("CW не DC", abs(complex(tone[0]) - complex(tone[1])) > 1e-6)
        check("CW длина кратна 8", len(tone) % 8 == 0)
        check("CW пик ~amp", abs(abs(complex(tone[0])) - 0.25) < 0.02)
        freqs = np.linspace(2440, 2444, 1024)
        db = np.linspace(-90, -40, 1024)
        pooled = w._pool_bins(freqs, db, 64)
        check("pool 1024→64", len(pooled) == 64)
        check("pool берёт max", pooled[-1]["powerDbm"] > pooled[0]["powerDbm"])
        check("scan() не зовёт _read_fft", not hasattr(w, "_read_fft"))
        check("AGC в коде выкл", "setGainMode(SOAPY_SDR_RX, 0, False)" in open(WORKER).read())
        check("AGC True не пишем", "setGainMode(SOAPY_SDR_RX, 0, True)" not in open(WORKER).read())
        check("нет SCAN_FS_HZ — ось = DIO 40e6", not hasattr(w, "SCAN_FS_HZ") and w.DIO_SAMPLE_RATE_HZ == 40e6)
        check("нет scan_fs_hz(analog) — analog не задаёт ADC", not hasattr(w, "scan_fs_hz"))

        ring = w.IqRing(16)
        ring.push_block(np.arange(10, dtype=np.complex64))
        check("кольцо: available 10", ring.available() == 10)
        batch = ring.pop_batch(8)
        check("кольцо: pop 8", batch is not None and len(batch) == 8)
        check("кольцо: осталось 2", ring.available() == 2)
        ring.push_block(np.ones(20, dtype=np.complex64))
        check("кольцо: затирает при переполнении", ring.available() == 16)
        full = ring.pop_batch(16)
        check("кольцо: pop после overwrite", full is not None and float(np.max(np.abs(full))) == 1.0)
        keep = w.IqRing(32)
        keep.push_block(np.arange(32, dtype=np.complex64))
        check("drop_oldest", keep.drop_oldest(24) == 24 and keep.available() == 8)

        check("DIO rate = 40e6 (не analog BW)", w.dio_rx_rate(28) == 40e6)
        check("DIO rate micro тоже 40e6", w.dio_rx_rate(56) == 40e6)
        check("DIO BW 40e6", w.DIO_BANDWIDTH_HZ == 40_000_000)
        check("settle 40 MSPS = 32×4096 (время режет сильнее USB)", w.settle_samples(40e6) == 32 * 4096)
        check("settle 2 MSPS = 5 мс (10000), не 65.5 мс", w.settle_samples(2e6) == 10000)
        check("settle fs=0 → глубина USB (как раньше)", w.settle_samples(0) == 32 * 4096)
        check("settle 1 MSPS = 5000", w.settle_samples(1e6) == 5000)
        check(
            "parked: тот же LO не ретунит",
            w.rx_is_parked(True, 915e6, 40e6, 915e6, 40e6, 0, True) is True,
        )
        check(
            "hop: другой LO — не parked",
            w.rx_is_parked(True, 915e6, 40e6, 2442e6, 40e6, 0, True) is False,
        )
        check(
            "после hop discard — не parked",
            w.rx_is_parked(True, 2442e6, 40e6, 2442e6, 40e6, 100, True) is False,
        )

        frames_n = w.welch_need_samples(1024)
        src = (0.05 + 0.2 * np.exp(1j * 2 * np.pi * 80 * np.arange(frames_n) / 1024)).astype(np.complex64)
        live = w.IqRing(1 << 14)
        live.push_block(src)
        spec = w._psd_from_ring(live, 64, 40e6, 2442.0)
        check("overlap 0.5: need = N+(F-1)*N/2", w.welch_need_samples(1024) == 1024 + 7 * 512)
        check("soapy crop 0.5: 1024 → 512 бинов", len(spec) == 512)
        peak_i = max(range(len(spec)), key=lambda i: spec[i]["powerDbm"])
        check("PSD с кольца: пик не на LO", abs(spec[peak_i]["freqMhz"] - 2442.0) > 0.2)
        check("crop оставил центр: ось внутри ±10 МГц", spec[0]["freqMhz"] > 2442 - 10.1 and spec[-1]["freqMhz"] < 2442 + 10.1)
        step = spec[1]["freqMhz"] - spec[0]["freqMhz"]
        check("ось шаг = fs/N, не fs/(N−1)", abs(step - 40.0 / 1024) < 1e-12)
        check("после crop DC = center", abs(spec[len(spec) // 2]["freqMhz"] - 2442.0) < 1e-6)
        cropped = w.crop_psd_bins([{"freqMhz": i, "powerDbm": 0.0} for i in range(8)], 0.5)
        check("crop_psd_bins half=2 на 8", len(cropped) == 4 and cropped[0]["freqMhz"] == 2)

        hann = w._hann(1024)
        check("Hann DIO: края ≈ 0", abs(float(hann[0])) < 1e-6 and abs(float(hann[-1])) < 1e-6)
        check("Hann DIO: середина ≈ 1", abs(float(hann[512]) - 1.0) < 1e-5)
        check("FFT size 64→1024", w._pick_fft_size(64) == 1024)
        check("FFT size 2048", w._pick_fft_size(2048) == 2048)

        n = 1024
        t = np.arange(n)
        tone_bin = 80
        frames = np.stack([
            (0.25 + 0.2 * np.exp(1j * 2 * np.pi * tone_bin * t / n)).astype(np.complex64)
            for _ in range(w.WELCH_FRAMES)
        ])
        psd = w.welch_dbm(frames)
        half = n // 2
        check("Welch: DC-бин сглажен", abs(psd[half] - 0.5 * (psd[half - 1] + psd[half + 1])) < 1e-9)
        peak = int(np.argmax(psd))
        check("Welch: пик не на LO/DC", peak != half)
        # bin k → после fftshift индекс (k + N/2) % N
        expect = (tone_bin + half) % n
        check("Welch: пик на тоне", abs(peak - expect) <= 1)
        floor = w.estimate_noise_floor(psd)
        check("пол = медиана нижних 60%", psd[peak] - floor > 20)

        # Lockstep с DIO-sys/spectrum_analyzer python/psd_plot.py compute_psd_welch
        # (окно np.hanning ≡ 0.5*(1-cos(2πn/(N-1))), |X|²/N², fftshift, DC-бин).
        dio_win = np.hanning(n).astype(np.float32)
        check("Hann ≡ np.hanning DIO", np.allclose(hann, dio_win, atol=1e-6))
        accum = np.zeros(n, dtype=np.float64)
        for fr in frames:
            accum += np.abs(np.fft.fft(fr * dio_win)) ** 2
        dio_psd = 10.0 * np.log10(np.maximum((accum / w.WELCH_FRAMES) / (n * n), 1e-20))
        dio_psd = np.fft.fftshift(dio_psd)
        dio_psd[half] = 0.5 * (dio_psd[half - 1] + dio_psd[half + 1])
        check("welch_dbm ≡ DIO convert_to_dbm", np.allclose(psd, dio_psd, atol=1e-5, rtol=1e-5))
        dio_floor = float(np.median(np.sort(dio_psd)[: int(len(dio_psd) * 0.60)]))
        check("шум ≡ DIO estimate_noise_floor", abs(floor - dio_floor) < 1e-9)

        # --- ТИП СИГНАЛА: синтез всех волн ---
        all_ok = True
        for kind in w.WAVE_KINDS:
            buf = w.make_waveform(kind)
            if (
                len(buf) == 0
                or str(buf.dtype) != "complex64"
                or not np.isfinite(buf.real).all()
                or not np.isfinite(buf.imag).all()
                or float(np.max(np.abs(buf))) > 0.9 + 1e-6
            ):
                all_ok = False
                print(f"    … плохой буфер: {kind}")
        check("31 волна: complex64, finite, пик ≤ amp", all_ok)
        check("каталог: 31 тип", len(w.WAVE_KINDS) == 31)

        # Постоянная огибающая у CPM/чирп-волн (GMSK, Zadoff-Chu, P4)
        for kind in ("gmsk", "gfsk", "zadoffchu", "p4", "fsk4", "mfsk8"):
            env = np.abs(w.make_waveform(kind))
            ripple = float(np.max(env) - np.min(env[env > 0])) if np.any(env > 0) else 9.0
            if ripple > 0.05:
                all_ok = False
                print(f"    … огибающая не постоянна: {kind} ripple={ripple:.4f}")
        check("GMSK/GFSK/ZC/P4/xFSK: постоянная огибающая (±0.05)", all_ok)

        # 16-APSK: два кольца с отношением радиусов 2.73
        apsk = w._apsk16_symbols(4096, 7)
        rings = sorted(set(np.round(np.abs(apsk), 3)))
        check("16-APSK: два кольца", len(rings) == 2)
        if len(rings) == 2:
            check("16-APSK: γ ≈ 2.73", abs(rings[1] / rings[0] - 2.73) < 0.05)

        # Zadoff-Chu: идеальная периодическая АКФ (боковые ~0)
        zc = w.make_waveform("zadoffchu", n=631)
        ac = np.abs(np.fft.ifft(np.abs(np.fft.fft(zc)) ** 2))
        check("ZC: АКФ ≈ дельта (боковые < 1%)", float(np.max(ac[1:])) < 0.01 * float(ac[0]))

        tbuf = w.make_waveform("tone", pr={"fj": 0.1})
        fax = np.fft.fftfreq(len(tbuf), 1.0 / w.TX_FS)
        peak_hz = fax[int(np.argmax(np.abs(np.fft.fft(tbuf))))]
        check("тон Fj=0.1 → пик на +200 кГц", abs(peak_hz - 0.1 * w.TX_FS) < 2e3)
        t20 = w.make_waveform("tone", fs=20e6, pr={"fj": 0.1})
        fax20 = np.fft.fftfreq(len(t20), 1.0 / 20e6)
        peak20 = fax20[int(np.argmax(np.abs(np.fft.fft(t20))))]
        check("тон Fj=0.1 @ 20 MSPS → пик на +2 МГц", abs(peak20 - 2e6) < 20e3)

        ph4 = set(np.round(np.angle(w._psk_symbols(256, 4, 1)), 3))
        check("QPSK: 4 фазы (π/4 + k·π/2)", len(ph4) == 4)
        m = w._mseq31()
        check("m-seq Gp=31: длина и баланс ±1", len(m) == 31 and abs(int(m.sum())) == 1)

        # Циклический RRC: стык петли не хуже середины (нет скачка огибающей)
        q = w.make_waveform("qpsk")
        env = np.abs(q)
        edge = max(float(env[0]), float(env[-1]))
        mid = float(np.max(env[len(env) // 4 : 3 * len(env) // 4]))
        check("QPSK петля: край в пределах огибающей", edge <= mid + 1e-6)

        bad_params = w.make_waveform("qpsk", pr={"amp": 99, "alpha": -1})
        check("параметры клампятся (amp ≤ 0.9)", float(np.max(np.abs(bad_params))) <= 0.9 + 1e-6)

    check("hw bladerf1 → lms", w.classify_bladerf_hw("bladerf1") == "lms")
    check("hw bladerf2 → ad9361", w.classify_bladerf_hw("bladerf2") == "ad9361")
    check("hw пусто → unknown", w.classify_bladerf_hw("") == "unknown")
    check("hw HackRF → unknown", w.classify_bladerf_hw("HackRF One") == "unknown")

    ping = rpc(proc, {"op": "ping"})
    check("ping ok", ping.get("ok") is True)
    check("fake flag", ping.get("fake") is True)
    check("ping txLive false", ping.get("txLive") is False)

    opened = rpc(proc, {"op": "open", "args": "driver=fake", "analogBwMhz": 56, "canTx": True})
    check("fake open", opened.get("ok") is True)
    need = rpc(
        proc,
        {
            "op": "open",
            "args": "driver=fake",
            "analogBwMhz": 28,
            "canTx": True,
            "requireHw": "bladerf1",
        },
    )
    check("FAKE open + require bladerf1 → отказ", need.get("ok") is False and need.get("fake") is True)
    need2 = rpc(
        proc,
        {
            "op": "open",
            "args": "driver=fake",
            "analogBwMhz": 28,
            "canTx": True,
            "requireHw": "bladerf2",
        },
    )
    check("FAKE open + require bladerf2 → отказ", need2.get("ok") is False and need2.get("fake") is True)
    # requireHw проверяет класс для обеих плат (не только bladerf1) — факт кода
    check(
        "open(): requireHw bladerf2 реально сверяет класс (не вайб)",
        'want_class = {"bladerf1": "lms", "bladerf2": "ad9361"}.get(require_hw)' in open(WORKER).read(),
    )
    # Успешный open не падает на опечатке в имени атрибута (ревью 2026-08-28:
    # self.hardwareKey в f-строке — AttributeError на реальном железе после
    # удачного open; FAKE-путь это не ловил — возвращается раньше).
    check(
        "open(): успех читает self.hardware_key (не self.hardwareKey)",
        "self.hardwareKey}" not in open(WORKER).read(),
    )
    # вернуть FAKE-открытие для последующих park/tx тестов
    rpc(proc, {"op": "open", "args": "driver=fake", "analogBwMhz": 56, "canTx": True})

    scan = rpc(proc, {"op": "scan", "centerMhz": 2442, "bwMhz": 20, "bins": 32})
    check("scan bins after soapy crop", scan.get("ok") is True and len(scan.get("bins") or []) == 512)
    mid = len(scan["bins"]) // 2
    check("scan freqs", abs(scan["bins"][mid]["freqMhz"] - 2442) < 2)
    check("fake paint = 20 МГц (40 ADC × crop 0.5)", abs(scan["bins"][-1]["freqMhz"] - scan["bins"][0]["freqMhz"] - 20) < 1.5)
    check("attack crop 61.44/56", abs(w.attack_crop_factor(61.44e6, 56e6) - (1 - 56 / 61.44)) < 1e-6)
    check("attack crop 40/40 край", abs(w.attack_crop_factor(40e6, 40e6) - w.ATTACK_EDGE_CROP) < 1e-9)
    check("attack FFT мало сэмплов → 4096", w.attack_pick_fft_n(8192, 100) == 4096)
    check(
        "attack FFT хватает → 8192",
        w.attack_pick_fft_n(8192, w.welch_need_samples(8192)) == 8192,
    )
    check("attack FFT без available — ждём 8192", w.attack_pick_fft_n(8192) == 8192)
    check(
        "attack_scan не режет FFT по пустому кольцу после hop",
        "fft_n = attack_pick_fft_n(hint)" in open(WORKER).read()
        and "avail = self._ring.available() if self._ring is not None else 0" not in open(WORKER).read(),
    )
    atk = rpc(
        proc,
        {
            "op": "attack_scan",
            "centerMhz": 5800,
            "fsHz": 61.44e6,
            "bwMhz": 56,
            "bins": 8192,
            "cropFactor": 1 - 56 / 61.44,
        },
    )
    check("attack_scan fake ок", atk.get("ok") is True and atk.get("attack") is True)
    check("attack_scan не 512 soapy", len(atk.get("bins") or []) > 2000)
    atk_span = atk["bins"][-1]["freqMhz"] - atk["bins"][0]["freqMhz"]
    check("attack_scan окно ≈56", abs(atk_span - 56) < 1.5)
    scan2 = rpc(proc, {"op": "scan", "centerMhz": 2442, "bwMhz": 20, "bins": 32})
    check(
        "scan() изоляция: снова 20 МГц crop",
        scan2.get("ok") is True and abs(scan2["bins"][-1]["freqMhz"] - scan2["bins"][0]["freqMhz"] - 20) < 1.5,
    )

    # _wait_psd ждёт новое поколение кольца (_rx_gen), не крутит Welch на IQ до hop.
    check("wait_psd требует gen + кольцо", "self._rx_gen >= gen" in open(WORKER).read())

    check("FPGA park default = 2e6 (NCO)", w.FPGA_PARK_FS_HZ == 2e6)
    pk = rpc(proc, {"op": "park", "centerMhz": 2442, "bwMhz": 20, "fsHz": 2e6, "rx": True, "tx": True})
    check("park RX+TX fake", pk.get("ok") is True and pk.get("freqMhz") == 2442)
    check("park fake помечен (ARM это отвергнет)", pk.get("fake") is True)
    check("park fs 2 MSPS", pk.get("fsHz") == 2e6)
    air = rpc(proc, {"op": "park", "centerMhz": 2442, "bwMhz": 28, "fsHz": 28e6, "rx": True, "tx": True})
    check("park эфир 28 MSPS", air.get("ok") is True and air.get("fsHz") == 28e6)
    none = rpc(proc, {"op": "park", "centerMhz": 2442, "rx": False, "tx": False})
    check("park без RX/TX → отказ", none.get("ok") is False)

    # park() без FAKE: readback LO/fs. Иначе «ok» после set* — вайб.
    class _Dev:
        def __init__(self, rx_hz=None, tx_hz=None, rx_fs=None, tx_fs=None, deaf=False):
            self._set = {}
            self.rx_hz, self.tx_hz = rx_hz, tx_hz
            self.rx_fs, self.tx_fs = rx_fs, tx_fs
            self.deaf = deaf
            self.gain_mode = None

        def setSampleRate(self, d, _ch, fs):
            self._set[(d, "fs")] = fs

        def setFrequency(self, d, _ch, hz):
            self._set[(d, "hz")] = hz

        def setBandwidth(self, d, _ch, bw):
            if getattr(self, "bw_fail", False):
                raise RuntimeError("setBandwidth нет")
            self._set[(d, "bw")] = bw

        def getBandwidth(self, d, _ch):
            if getattr(self, "bw_read", None) is not None:
                return self.bw_read
            return self._set.get((d, "bw"), 0)

        def getSampleRate(self, d, _ch):
            if d == w.SOAPY_SDR_RX and self.rx_fs is not None:
                return self.rx_fs
            if d == w.SOAPY_SDR_TX and self.tx_fs is not None:
                return self.tx_fs
            return self._set.get((d, "fs"), 0)

        def getFrequency(self, d, _ch):
            if self.deaf:
                raise RuntimeError("getFrequency нет")
            if d == w.SOAPY_SDR_RX and self.rx_hz is not None:
                return self.rx_hz
            if d == w.SOAPY_SDR_TX and self.tx_hz is not None:
                return self.tx_hz
            return self._set.get((d, "hz"), 0)

        def getHardwareKey(self):
            return getattr(self, "hw", "bladerf1")

        def setGainMode(self, d, ch, automatic):
            if getattr(self, "gm_fail", False):
                raise RuntimeError("setGainMode нет")
            self.gain_mode = (d, ch, automatic)

        def getGainMode(self, d, ch):
            if getattr(self, "gm_read_fail", False):
                raise RuntimeError("getGainMode нет")
            return getattr(self, "gm_agc", False)

        def getGain(self, d, ch):
            return 42.0

        def setupStream(self, d, f):
            return object()

        def activateStream(self, s):
            pass

        def deactivateStream(self, s):
            pass

    def _radio(dev):
        r = w.Radio()
        r.fake = False
        r.dev = dev
        return r

    pk_ok = _radio(_Dev()).park(2442, 28, 28e6, True, True)
    check(
        "park readback RX+TX",
        pk_ok.get("ok") is True
        and pk_ok.get("rxLo") == 2442e6
        and pk_ok.get("txLo") == 2442e6
        and pk_ok.get("rxFs") == 28e6
        and pk_ok.get("txFs") == 28e6,
    )
    pk_lo = _radio(_Dev(rx_hz=300e6)).park(2442, 28, 28e6, True, True)
    check("park RX LO чужой → отказ", pk_lo.get("ok") is False)
    pk_fs = _radio(_Dev(rx_fs=28e6, tx_fs=27e6)).park(2442, 28, 28e6, True, True)
    check("park RX/TX fs разъехались → отказ", pk_fs.get("ok") is False)
    pk_deaf = _radio(_Dev(deaf=True)).park(2442, 28, 28e6, True, True)
    check("park без getFrequency → отказ", pk_deaf.get("ok") is False)
    micro = _Dev()
    micro.hw = "bladerf2"
    pk_micro = _radio(micro).park(2442, 28, 28e6, True, True)
    check("park micro/AD9361 → ok (без подмены на x40)", pk_micro.get("ok") is True)
    check(
        "park micro: AGC выкл (ручной gain) + gain readback для ARM",
        micro.gain_mode == (w.SOAPY_SDR_RX, 0, False) and pk_micro.get("rxGainDb") == 42.0,
    )
    micro_gm = _Dev()
    micro_gm.hw = "bladerf2"
    micro_gm.gm_fail = True
    pk_gm = _radio(micro_gm).park(2442, 28, 28e6, True, True)
    check("park micro: AGC не выключается → отказ (порог уплыл бы)", pk_gm.get("ok") is False)
    # Readback режима: «записал MGC» без подтверждения — вайб. AGC жив → отказ.
    micro_agc = _Dev()
    micro_agc.hw = "bladerf2"
    micro_agc.gm_agc = True
    pk_agc = _radio(micro_agc).park(2442, 28, 28e6, True, True)
    check("park micro: getGainMode=True после setGainMode(False) → отказ", pk_agc.get("ok") is False)
    micro_gmr = _Dev()
    micro_gmr.hw = "bladerf2"
    micro_gmr.gm_read_fail = True
    pk_gmr = _radio(micro_gmr).park(2442, 28, 28e6, True, True)
    check("park micro: getGainMode не ответил → отказ", pk_gmr.get("ok") is False)
    unknown = _Dev()
    unknown.hw = ""
    pk_unk = _radio(unknown).park(2442, 28, 28e6, True, True)
    check("park без hardwareKey → отказ", pk_unk.get("ok") is False)
    narrow = _Dev()
    narrow.bw_read = 1.5e6
    pk_bw = _radio(narrow).park(2442, 28, 28e6, True, True)
    check("park RX BW 1.5 МГц при запросе 28 → отказ", pk_bw.get("ok") is False)
    nobw = _Dev()
    nobw.bw_fail = True
    pk_nobw = _radio(nobw).park(2442, 28, 28e6, True, True)
    check("park без setBandwidth на эфире → отказ", pk_nobw.get("ok") is False)

    # --- det_capture: порог детектора из шумовой полки (handoff скан→FPGA) ---
    if w.NUMPY:
        import numpy as np

        rng = np.random.default_rng(42)
        noise = (
            (rng.standard_normal(512 * 16) + 1j * rng.standard_normal(512 * 16)) * 0.01
        ).astype(np.complex64)
        med_noise = w.window_energy_median(noise, 16)
        # E ≈ 2·(0.01·2048)² ≈ 839 в единицах SC16Q11 (шкала SoapyBladeRF: /2048)
        check("det_capture: медиана шума в единицах SC16Q11", 400 < med_noise < 2000)
        hot = noise.copy().reshape(512, 16)
        hot[: 512 // 4] *= 50.0  # четверть окон с сильным сигналом
        med_hot = w.window_energy_median(hot.reshape(-1), 16)
        check(
            "det_capture: сигнал в 25% окон не поднимает полку (нижние 60%)",
            abs(med_hot - med_noise) / med_noise < 0.5,
        )
        # Локстеп с legion_detector_tb.vhd: константная энергия проходит
        # нижние 60% без изменений → avg окна в единицах шины (SC16Q11)
        # численно равен avg HDL (Σ(I²+Q²)>>shift): I=100,Q=0 → 10000
        # (в TB ≥ порога 1000 = детект), I=20,Q=20 → 800 (в TB — тишина).
        tb1 = np.full(16 * 64, complex(100 / w.CF32_FULL_SCALE, 0), dtype=np.complex64)
        check(
            "det_capture ≡ TB детектора: I=100,Q=0 → avg 10000",
            abs(w.window_energy_median(tb1, 16) - 10000) < 1e-6,
        )
        tb2 = np.full(
            16 * 64,
            complex(20 / w.CF32_FULL_SCALE, 20 / w.CF32_FULL_SCALE),
            dtype=np.complex64,
        )
        check(
            "det_capture ≡ TB детектора: I=20,Q=20 → avg 800",
            abs(w.window_energy_median(tb2, 16) - 800) < 1e-6,
        )
    else:
        check("det_capture: numpy есть (CI ставит tools/requirements.txt)", False)

    no_rx = w.Radio()
    no_rx.fake = False
    cap_none = no_rx.det_capture(16, 512)
    check("det_capture без park → честный отказ", cap_none.get("ok") is False)
    cap_fake = rpc(proc, {"op": "det_capture", "win": 16, "windows": 512})
    check("det_capture на FAKE → отказ (не эфир)", cap_fake.get("ok") is False)

    # --- Калибровочный проход air-hop (сторона воркера): серия det_capture
    # подряд — полка каждой стоянки обхода. Между точками перестройки нет
    # (тот же LO/fs → дискард 0, поколение не растёт): повторные захваты
    # обязаны читать свежие данные кольца и не течь по состоянию. ---
    if w.NUMPY:
        import numpy as np_cal  # локальный алиас: np выше связан условно

        cal = w.Radio()
        cal.fake = False
        cal.dev = object()  # не None — det_capture смотрит только наличие
        cal._rx_on = True
        cal._rx_fs = 2e6
        cal._ring = w.IqRing(w.RING_CAP)
        rng_cal = np_cal.random.default_rng(7)
        meds = []
        for _stop in range(4):  # четыре стоянки обхода
            noise = (
                (rng_cal.standard_normal(16 * 512) + 1j * rng_cal.standard_normal(16 * 512)) * 0.01
            ).astype(np_cal.complex64)
            cal._ring.push_block(noise)
            r_cap = cal.det_capture(16, 512)
            if r_cap.get("ok"):
                meds.append(float(r_cap["medianEnergy"]))
        check("калибровка: 4/4 захвата подряд успешны", len(meds) == 4)
        check(
            "калибровка: полки стоянок в разумных пределах и повторяемы",
            len(meds) == 4 and all(400 < m < 2000 for m in meds)
            and max(meds) / min(meds) < 2.0,
        )
        check("калибровка: кольцо отдало ровно 4 кадра (остаток пуст)",
              cal._ring.available() == 0)

    hd = w.Radio()
    hd.fake = True
    hd.full_duplex = False
    hd.tx_mhz = 2442.0
    paused = hd.scan(2442, 20, 16)
    check("half-duplex RX пауза при TX", paused.get("ok") is True and paused.get("bins") == [])

    # --- _ensure_rx: кэш rate/bw/center, deactivate только при смене rate ---
    class _MockDev:
        def __init__(self):
            self.calls = {"rate": 0, "bw": 0, "freq": 0, "setup": 0, "act": 0, "deact": 0}
        def setSampleRate(self, d, c, v): self.calls["rate"] += 1
        def setBandwidth(self, d, c, v): self.calls["bw"] += 1
        def setFrequency(self, d, c, v): self.calls["freq"] += 1
        def setupStream(self, d, f): self.calls["setup"] += 1; return object()
        def activateStream(self, s): self.calls["act"] += 1
        def deactivateStream(self, s): self.calls["deact"] += 1

    md = w.Radio()
    md.dev = _MockDev()
    md._ensure_rx(4e6, 2454e6)
    md._ensure_rx(4e6, 2454e6)  # тот же тик — без перестройки
    check("кэш rate: 2-й тик без setSampleRate", md.dev.calls["rate"] == 1)
    check("кэш center: 2-й тик без setFrequency", md.dev.calls["freq"] == 1)
    md._ensure_rx(4e6, 2455e6)  # смена center — только LO, поток жив
    check("смена center: setFrequency снова", md.dev.calls["freq"] == 2)
    check("смена center: rate не тронут", md.dev.calls["rate"] == 1)
    check("смена center: поток не останавливался", md.dev.calls["deact"] == 0)
    md._ensure_rx(1e6, 2455e6)  # смена fs — deactivate → перестройка → activate
    check("смена fs: deactivate перед перестройкой", md.dev.calls["deact"] == 1)
    check("смена fs: setSampleRate снова", md.dev.calls["rate"] == 2)
    check("смена fs: activate после", md.dev.calls["act"] == 2)

    tx = rpc(proc, {"op": "tx", "freqMhz": 2442.5})
    check("tx ok", tx.get("ok") is True and tx.get("freqMhz") == 2442.5)
    check("tx latency число", isinstance(tx.get("latencyUs"), int))

    wave = rpc(proc, {"op": "tx_wave", "freqMhz": 2442.0, "wave": "qpsk", "params": {"amp": 0.2}})
    check("tx_wave qpsk ok (fake)", wave.get("ok") is True and wave.get("freqMhz") == 2442.0)
    check("tx_wave fake помечен (player ARM это отвергнет)", wave.get("fake") is True)
    check("tx_wave без fsHz → 2 МГц", wave.get("fsHz") == w.TX_FS)

    wide = rpc(proc, {"op": "tx_wave", "freqMhz": 2425.0, "wave": "awgn", "params": {}, "fsHz": 20e6})
    check("tx_wave fsHz=20e6 ok (fake)", wide.get("ok") is True and wide.get("fsHz") == 20e6)
    check("tx_wave 20e6 не подменяет tx_cue fs", "TX_FS" in open(WORKER).read())

    radio = w.Radio()
    radio.fake = True
    cue = radio.tx_cue(2442.0)
    check("tx_cue не меняет _tx_fs с 2 МГц", cue.get("ok") is True and abs(radio._tx_fs - w.TX_FS) < 1)
    solo = radio.tx_wave(2425.0, "awgn", {}, 20e6)
    check("tx_wave окно пишет _tx_fs=20e6", solo.get("ok") is True and abs(radio._tx_fs - 20e6) < 1)
    again = radio.tx_wave(2425.0, "qpsk", {"amp": 0.2})
    check("tx_wave без fs снова 2 МГц", again.get("ok") is True and abs(radio._tx_fs - w.TX_FS) < 1)

    bad_wave = rpc(proc, {"op": "tx_wave", "freqMhz": 2442.0, "wave": "nonsense"})
    check("tx_wave неизвестный тип → отказ", bad_wave.get("ok") is False)

    wave_live = rpc(proc, {"op": "ping"})
    check("tx_wave → txLive", wave_live.get("txLive") is True)

    live = rpc(proc, {"op": "scan", "centerMhz": 2442, "bwMhz": 20, "bins": 8})
    check("scan несёт txLive после TX", live.get("txLive") is True)

    off = rpc(proc, {"op": "tx_off"})
    check("tx_off", off.get("ok") is True)

    after = rpc(proc, {"op": "ping"})
    check("после tx_off не live", after.get("txLive") is False)

    bad = rpc(proc, {"op": "nope"})
    check("unknown op", bad.get("ok") is False)

    # --- FPGA-релей: воркер → legion_gateway (FAKE) по TCP ---
    import threading
    gw_env = os.environ.copy()
    gw_env["LEGION_FPGA_FAKE"] = "1"
    gw_env["LEGION_FPGA_PORT"] = "5599"
    gw = subprocess.Popen(
        [sys.executable, str(ROOT.parent / "fpga" / "host" / "legion_gateway.py")],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=gw_env,
    )
    try:
        time.sleep(1.0)  # агент поднимается
        pong = rpc(proc, {"op": "fpga", "cmd": {"op": "ping"}, "gw": "127.0.0.1"})
        check("fpga relay ping через шлюз", pong.get("ok") is True and pong.get("fake") is True)

        arm = rpc(proc, {"op": "fpga", "cmd": {"op": "arm", "mode": "player"}, "gw": "127.0.0.1"})
        check("fpga relay arm player", arm.get("ok") is True)

        st = rpc(proc, {"op": "fpga", "cmd": {"op": "status"}, "gw": "127.0.0.1"})
        check("fpga relay status playing", st.get("ok") is True and st.get("playing") is True)

        off = rpc(proc, {"op": "fpga", "cmd": {"op": "disarm"}, "gw": "127.0.0.1"})
        check("fpga relay disarm", off.get("ok") is True)
    finally:
        gw.terminate()
        gw.wait(timeout=5)

    # Агент остановлен → честный отказ (не молчание и не фейк-успех)
    nogw = rpc(proc, {"op": "fpga", "cmd": {"op": "ping"}, "gw": "127.0.0.1"})
    check("fpga relay без агента → честный отказ", nogw.get("ok") is False)

    rpc(proc, {"op": "close"})
    proc.stdin.close()
    proc.wait(timeout=5)
    print("WORKER: ALL PASS" if fails == 0 else f"WORKER: {fails} FAILURES")
    return 0 if fails == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
