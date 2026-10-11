"""Синтез I/Q всех протоколов лаборатории (шаг 5.3) + шум.

Сетка: fs = 20 МГц (лабораторный rx config шага 3), окно ±fs/2 относительно
LO. Протоколы шире окна (ELRS 2.4: 2.4–2.483 ГГц = 83 МГц FHSS) моделируются
честно: скачки вне окна приёмник не видит (тишина), meta помечает visible.

Каждый генератор возвращает dict(iq=complex64, meta={...}) — meta несёт
ground truth (времена/частоты скачков, класс) для проверки hop map (шаг 6)
и разметки датасета (шаг 5.6, отдельный этап).

Амплитуда: пиковая нормировка ≤ 0.9 (без клиппинга, как в эфире на ADC).
"""
from __future__ import annotations

import numpy as np

FS_DEFAULT = 20.0e6
PEAK = 0.9

CLASSES = [
    "noise", "elrs_24", "elrs_900", "crossfire_fsk", "crossfire_lora",
    "mavlink", "orangerx_dsmx", "orangerx_fhss", "ttlrs", "miller",
    "wifi_bt", "analog_fpv",
]

# Параметры — из таблицы ПРОТОКОЛЫ (ТЗ лаборатории).
PARAMS = {
    "elrs_24": dict(hop_rate=1000.0, band=(2400e6, 2483e6), n_hops=256,
                    mod="flrc", baud=1.3e6, dev=325e3, airtime=70e-6),
    "elrs_900": dict(hop_rate=200.0, band=(868e6, 915e6), n_hops=40,
                     mod="lora", sf=6, bw=500e3, airtime=3.0e-3),
    "crossfire_fsk": dict(hop_rate=150.0, band=(868e6, 915e6), n_hops=50,
                          mod="gfsk", baud=420e3, dev=210e3, airtime=350e-6),
    "crossfire_lora": dict(hop_rate=50.0, band=(868e6, 915e6), n_hops=50,
                           mod="lora", sf=6, bw=500e3, airtime=6.0e-3),
    "mavlink": dict(mod="gfsk", baud=57_600.0, dev=32e3,
                    baud_alt=460_800.0, dev_alt=250e3),
    "orangerx_dsmx": dict(period=(22e-3, 11e-3), airtime=1.2e-3,
                          chip_rate=1.25e6, n_ch=23, band=(2400e6, 2483e6)),
    "orangerx_fhss": dict(hop_rate=500.0, band=(2400e6, 2483e6), n_hops=47,
                          mod="gfsk", baud=100e3, dev=50e3),
    "ttlrs": dict(mod="uart_gfsk", baud=9600.0, dev=4.8e3),
    "miller": dict(blf=40e3, m=(2, 4, 8), mod="ask"),
    "wifi_bt": dict(wifi_srate=20e6, bt_hop=1600.0, bt_baud=1.0e6,
                    bt_dev=160e3, bt_band=(2402e6, 2480e6)),
    "analog_fpv": dict(dev=3.0e6, msg_bw=3.0e6),
}


def _rng(seed):
    return np.random.default_rng(seed)


def _n(fs: float, dur: float) -> int:
    return int(round(fs * dur))


def _visible_band(fs: float) -> float:
    return 0.4 * fs  # 80% окна: края режет аналоговый фильтр


def _finish(iq: np.ndarray, fs: float, rng, snr_db: float,
            meta: dict) -> dict:
    """Пиковая нормировка + AWGN до SNR. Шум всегда присутствует (эфир)."""
    iq = iq.astype(np.complex64)
    peak = float(np.max(np.abs(iq))) if iq.size else 0.0
    if peak > 0:
        iq = (iq / peak * PEAK).astype(np.complex64)
    rms = float(np.sqrt(np.mean(np.abs(iq) ** 2))) if iq.size else 0.0
    if snr_db < 90 and rms > 0:
        n_rms = rms * 10.0 ** (-snr_db / 20.0) / np.sqrt(2.0)
        noise = (rng.standard_normal(iq.size) +
                 1j * rng.standard_normal(iq.size)).astype(np.complex64)
        iq = (iq + noise * n_rms).astype(np.complex64)
        # AGC ADC: шумовые выбросы не дают уйти за полную шкалу (клиппинг
        # модуляции недопустим, а делитель после шума — честная физика).
        p = float(np.max(np.abs(iq)))
        if p > 1.0:
            iq = (iq / p).astype(np.complex64)
    meta.setdefault("fs", fs)
    meta.setdefault("snr_db", snr_db)
    return {"iq": iq, "meta": meta}


def _gfsk(bits: np.ndarray, baud: float, dev: float, fs: float,
          bt: float = 0.5, sps_min: int = 8) -> np.ndarray:
    """GFSK NRZ: биты → уровни ±1 → Гауссово сглаживание (BT) → ЧМ.
    phase = 2π·dev·∫lvl dt — непрерывная фаза, спектр FSK."""
    sps = max(sps_min, int(round(fs / baud)))
    lvl = np.repeat(2.0 * bits.astype(np.float64) - 1.0, sps)
    span = 4 * sps
    t = np.arange(-span, span + 1) / sps
    g = np.exp(-2.0 * (np.pi ** 2) * (bt ** 2) * (t ** 2) / np.log(2.0))
    g /= g.sum()
    lvl = np.convolve(lvl, g, mode="same")
    ph = 2.0 * np.pi * dev * np.cumsum(lvl) / fs
    return np.exp(1j * ph).astype(np.complex64)


def _uart_8n1(data: bytes, baud: float, rng) -> np.ndarray:
    bits = [1, 1]  # idle
    for b in data:
        bits.append(0)  # start
        bits += [(b >> i) & 1 for i in range(8)]
        bits.append(1)  # stop
    bits += [1, 1]
    return np.asarray(bits, dtype=np.int8)


def _lora_packet(sf: int, bw: float, n_payload: int, fs: float,
                 rng) -> np.ndarray:
    """LoRa-пакет: преамбула 6 up-chirp + 2 down + полезные символы.
    Мгновенная частота символа k: -bw/2 + bw·((t/T + k/2^sf) mod 1)."""
    nsym = 2 ** sf
    tsym = nsym / bw
    n_per = max(8, _n(fs, tsym))
    t = np.arange(n_per) / fs / tsym  # 0..1 в долях символа
    syms = [0] * 6 + list(rng.integers(0, nsym, size=n_payload))
    out = np.empty(n_per * (len(syms) + 2), dtype=np.complex64)
    phase = 0.0
    pos = 0
    for i, k in enumerate(syms + [0, 0]):
        down = i >= len(syms)  # 2 down-chirp в конце
        f = (-bw / 2 + bw * ((t + k / nsym) % 1.0)) * (-1.0 if down else 1.0)
        seg = np.exp(1j * (phase + 2 * np.pi * np.cumsum(f) / fs))
        phase = float(np.angle(seg[-1]))
        out[pos: pos + n_per] = seg
        pos += n_per
    return out[:pos]


def _ofdm_burst(n_sym: int, fs: float, rng, nfft: int = 64, cp: int = 16,
                used: int = 52) -> np.ndarray:
    """Wi-Fi-подобный OFDM: used поднесущих QPSK, srate = fs, шаг = fs/nfft."""
    sym = (2 * rng.integers(0, 2, (n_sym, used)) - 1 +
           1j * (2 * rng.integers(0, 2, (n_sym, used)) - 1)).astype(np.complex64)
    X = np.zeros((n_sym, nfft), dtype=np.complex64)
    idx = np.r_[1: used // 2 + 1, nfft - used // 2: nfft]
    X[:, idx] = sym
    x = np.fft.ifft(X, axis=1) * np.sqrt(nfft)
    x = np.concatenate([x[:, -cp:], x], axis=1)
    return x.reshape(-1)


def _miller_envelope(bits: np.ndarray, m: int, blf: float,
                     fs: float) -> np.ndarray:
    """Miller-2/4/8: '1' — переход в середине символа; '0' — переход на
    границе, если предыдущий бит 0. Символ = M циклов поднесущей BLF/2."""
    tsym = m / blf
    n_per = max(4, _n(fs, tsym))
    half = n_per // 2
    env = np.empty(n_per * len(bits), dtype=np.float64)
    lvl = 1.0
    pos = 0
    prev = 1
    for b in bits:
        seg = np.full(n_per, lvl)
        if b == 1:
            seg[half:] = -lvl
            lvl = -lvl
        elif prev == 0:
            lvl = -lvl
            seg[:] = lvl
        prev = int(b)
        env[pos: pos + n_per] = seg
        pos += n_per
    # Сглаживание фронтов поднесущей (реальный тег не меандр).
    k = np.hanning(max(3, n_per // 8))
    k /= k.sum()
    return np.convolve(env, k, mode="same")


def _fm(msg: np.ndarray, dev: float, fs: float) -> np.ndarray:
    ph = 2.0 * np.pi * dev * np.cumsum(msg) / fs
    return np.exp(1j * ph).astype(np.complex64)


def _hop_grid(rng, band: tuple, n_hops: int, fs: float,
              lo_hz: float) -> np.ndarray:
    """Таблица частот FHSS → смещения относительно LO, отсортированная
    случайная перестановка (как псевдослучайная таблица ELRS/OrangeRX)."""
    f1, f2 = band
    freqs = np.linspace(f1, f2, int(n_hops))
    freqs = rng.permutation(freqs)
    return freqs - float(lo_hz)


def _place_hops(fs: float, dur: float, hop_rate: float, offsets: np.ndarray,
                payload_fn, rng, airtime: "float | None"):
    """Разложить payload по сетке скачков; вне окна — тишина (невидимые).
    Возвращает (iq, hop_times, hop_freqs, visible)."""
    n = _n(fs, dur)
    iq = np.zeros(n, dtype=np.complex64)
    dwell = 1.0 / hop_rate
    t_hop = rng.uniform(0, dwell)  # случайная фаза сетки
    fb = _visible_band(fs)
    times, freqs, vis = [], [], []
    i = 0
    while t_hop < dur:
        off = float(offsets[i % len(offsets)])
        i += 1
        at = airtime if airtime else dwell * 0.9
        n_seg = _n(fs, min(at, dur - t_hop))
        if n_seg > 0:
            s0 = _n(fs, t_hop)
            if abs(off) <= fb:
                seg = payload_fn(n_seg, off, rng)
                iq[s0: s0 + len(seg)] += seg
                visible = True
            else:
                visible = False  # скачок вне 20 МГц окна — эфир «пустой»
            times.append(t_hop)
            freqs.append(off)
            vis.append(visible)
        t_hop += dwell
    return iq, np.asarray(times), np.asarray(freqs), np.asarray(vis, dtype=bool)


# ---------------------------------------------------------------- классы

def synth_noise(fs: float = FS_DEFAULT, dur: float = 0.005,
                lo_hz: float = 2400e6, seed=None, snr_db: float = 20.0) -> dict:
    rng = _rng(seed)
    n = _n(fs, dur)
    iq = ((rng.standard_normal(n) + 1j * rng.standard_normal(n))
          / np.sqrt(2.0)).astype(np.complex64)
    meta = {"class": "noise", "hop_rate_hz": 0.0}
    return _finish(iq, fs, rng, 60.0, meta)  # шум без сигнала: snr не применим


def _fhss_modulated(name: str, p: dict, fs: float, dur: float,
                    lo_hz: float, seed, snr_db: float) -> dict:
    """Общий каркас ELRS/Crossfire/OrangeRX-FHSS: FHSS-сетка + модем."""
    rng = _rng(seed)
    offsets = _hop_grid(rng, p["band"], p["n_hops"], fs, lo_hz)

    def payload(n_seg: int, off: float, r):
        mod = p["mod"]
        if mod == "gfsk" or mod == "flrc":
            bits = r.integers(0, 2, max(2, int(p["baud"] * n_seg / fs)))
            seg = _gfsk(bits, p["baud"], p["dev"], fs)
            seg = seg[:n_seg] if len(seg) >= n_seg else np.pad(seg, (0, n_seg - len(seg)))
        elif mod == "lora":
            seg = _lora_packet(p["sf"], p["bw"], max(2, int(n_seg * p["bw"] / (2 ** p["sf"]) / fs)), fs, r)
            seg = seg[:n_seg] if len(seg) >= n_seg else np.pad(seg, (0, n_seg - len(seg)))
        else:
            raise ValueError(mod)
        return seg * np.exp(2j * np.pi * off * np.arange(n_seg) / fs)

    iq, ht, hf, vis = _place_hops(fs, dur, p["hop_rate"], offsets,
                                  payload, rng, p.get("airtime"))
    meta = {"class": name, "hop_rate_hz": p["hop_rate"],
            "hop_times_s": ht, "hop_freqs_hz": hf, "hop_visible": vis,
            "band_hz": p["band"], "mod": p["mod"]}
    return _finish(iq, fs, rng, snr_db, meta)


def synth_elrs_24(fs: float = FS_DEFAULT, dur: float = 0.25,
                  lo_hz: float = 2440e6, seed=None, snr_db: float = 20.0) -> dict:
    """ELRS 2.4 ГГц: 1000 Гц FHSS 2.4–2.483, FLRC 1.3 Mbps (GFSK BT 0.5)."""
    return _fhss_modulated("elrs_24", PARAMS["elrs_24"], fs, dur, lo_hz,
                           seed, snr_db)


def synth_elrs_900(fs: float = FS_DEFAULT, dur: float = 0.25,
                   lo_hz: float = 868e6, seed=None, snr_db: float = 20.0) -> dict:
    """ELRS 900 МГц: 200 Гц FHSS, LoRa SF6/BW500."""
    return _fhss_modulated("elrs_900", PARAMS["elrs_900"], fs, dur, lo_hz,
                           seed, snr_db)


def synth_crossfire_fsk(fs: float = FS_DEFAULT, dur: float = 0.25,
                        lo_hz: float = 868e6, seed=None, snr_db: float = 20.0) -> dict:
    """TBS Crossfire 150 Гц FSK, CRSF UART 420 kbaud, 868/915 МГц."""
    return _fhss_modulated("crossfire_fsk", PARAMS["crossfire_fsk"], fs, dur,
                           lo_hz, seed, snr_db)


def synth_crossfire_lora(fs: float = FS_DEFAULT, dur: float = 0.5,
                         lo_hz: float = 868e6, seed=None, snr_db: float = 20.0) -> dict:
    """TBS Crossfire 50 Гц LoRa, 868/915 МГц."""
    return _fhss_modulated("crossfire_lora", PARAMS["crossfire_lora"], fs,
                           dur, lo_hz, seed, snr_db)


def synth_orangerx_fhss(fs: float = FS_DEFAULT, dur: float = 0.25,
                        lo_hz: float = 2440e6, seed=None, snr_db: float = 20.0) -> dict:
    """OrangeRX Futaba FHSS 2.4 ГГц: псевдослучайные скачки (SBus, 7ch)."""
    return _fhss_modulated("orangerx_fhss", PARAMS["orangerx_fhss"], fs, dur,
                           lo_hz, seed, snr_db)


def synth_mavlink(fs: float = FS_DEFAULT, dur: float = 0.25,
                  lo_hz: float = 868e6, seed=None, snr_db: float = 20.0) -> dict:
    """MAVLink по SiK radio: узкополосный GFSK 57600/460800 baud,
    телеметрийные пачки со случайным duty cycle. UART — транспорт,
    классифицируем по СПЕКТРУ (не RF-класс протокола)."""
    rng = _rng(seed)
    p = PARAMS["mavlink"]
    baud, dev = (p["baud"], p["dev"]) if rng.random() < 0.5 else (p["baud_alt"], p["dev_alt"])
    n = _n(fs, dur)
    iq = np.zeros(n, dtype=np.complex64)
    off = float(rng.uniform(-_visible_band(fs), _visible_band(fs)))
    t = rng.uniform(0, 0.02)
    while t < dur:
        pkt = int(rng.integers(6, 40))
        bits = _uart_8n1(rng.bytes(pkt), baud, rng)
        seg = _gfsk(bits, baud, dev, fs)
        s0 = _n(fs, t)
        m = min(len(seg), n - s0)
        if m > 0:
            iq[s0: s0 + m] += seg[:m] * np.exp(2j * np.pi * off * np.arange(m) / fs)
        t += len(bits) / baud + rng.uniform(0.005, 0.05)
    meta = {"class": "mavlink", "baud": baud, "offset_hz": off,
            "hop_rate_hz": 0.0}
    return _finish(iq, fs, rng, snr_db, meta)


def synth_orangerx_dsmx(fs: float = FS_DEFAULT, dur: float = 0.25,
                        lo_hz: float = 2440e6, seed=None, snr_db: float = 20.0) -> dict:
    """OrangeRX DSMX 2.4 ГГц: пакетные периоды 22/11 мс, DSSS BPSK
    1.25 Mcps на псевдослучайном канале из 23 (DSM2 — 2 канала)."""
    rng = _rng(seed)
    p = PARAMS["orangerx_dsmx"]
    period = float(p["period"][rng.integers(0, 2)])
    n = _n(fs, dur)
    iq = np.zeros(n, dtype=np.complex64)
    chans = np.linspace(p["band"][0], p["band"][1], p["n_ch"]) - lo_hz
    fb = _visible_band(fs)
    sps_chip = max(2, int(round(fs / p["chip_rate"])))
    times, freqs, vis = [], [], []
    t = rng.uniform(0, period)
    while t < dur:
        off = float(rng.choice(chans))
        n_seg = _n(fs, min(p["airtime"], dur - t))
        if n_seg > 0 and abs(off) <= fb:
            n_chip = max(1, n_seg // sps_chip)
            chips = (2 * rng.integers(0, 2, n_chip) - 1).astype(np.float64)
            bb = np.repeat(chips, sps_chip)[:n_seg]
            # rc-огибающая: короткое сглаживание фронтов чипов
            k = np.hanning(3 * sps_chip)
            bb = np.convolve(bb, k / k.sum(), mode="same")
            seg = (bb * np.exp(2j * np.pi * off * np.arange(len(bb)) / fs)).astype(np.complex64)
            s0 = _n(fs, t)
            iq[s0: s0 + len(seg)] += seg
            vis.append(True)
        else:
            vis.append(False)
        times.append(t)
        freqs.append(off)
        t += period
    meta = {"class": "orangerx_dsmx", "period_s": period,
            "hop_times_s": np.asarray(times),
            "hop_freqs_hz": np.asarray(freqs),
            "hop_visible": np.asarray(vis, dtype=bool),
            "hop_rate_hz": 1.0 / period}
    return _finish(iq, fs, rng, snr_db, meta)


def synth_ttlrs(fs: float = FS_DEFAULT, dur: float = 0.25,
                lo_hz: float = 868e6, seed=None, snr_db: float = 20.0) -> dict:
    """TTLRS 433/868/915 МГц: 9600 baud 8N1, узкополосный GFSK."""
    rng = _rng(seed)
    p = PARAMS["ttlrs"]
    n = _n(fs, dur)
    iq = np.zeros(n, dtype=np.complex64)
    off = float(rng.uniform(-_visible_band(fs), _visible_band(fs)))
    t = rng.uniform(0, 0.01)
    while t < dur:
        bits = _uart_8n1(rng.bytes(int(rng.integers(4, 20))), p["baud"], rng)
        seg = _gfsk(bits, p["baud"], p["dev"], fs)
        s0 = _n(fs, t)
        m = min(len(seg), n - s0)
        if m > 0:
            iq[s0: s0 + m] += seg[:m] * np.exp(2j * np.pi * off * np.arange(m) / fs)
        t += len(bits) / p["baud"] + rng.uniform(0.01, 0.1)
    meta = {"class": "ttlrs", "baud": p["baud"], "offset_hz": off,
            "hop_rate_hz": 0.0}
    return _finish(iq, fs, rng, snr_db, meta)


def synth_miller(fs: float = FS_DEFAULT, dur: float = 0.05,
                 lo_hz: float = 915e6, seed=None, snr_db: float = 20.0) -> dict:
    """Miller UHF RFID (860–960 МГц): Miller-2/4/8, ASK несущей
    (backscatter тега), BLF=40 кГц → BLF/8 = 5 кбит/с при M=8."""
    rng = _rng(seed)
    p = PARAMS["miller"]
    m = int(p["m"][rng.integers(0, 3)])
    blf = float(p["blf"])
    n = _n(fs, dur)
    iq = np.zeros(n, dtype=np.complex64)
    off = float(rng.uniform(-0.2 * fs, 0.2 * fs))
    bits = rng.integers(0, 2, max(8, int(dur * blf / m) - 2))
    env = _miller_envelope(bits, m, blf, fs)
    t = rng.uniform(0, 0.002)
    s0 = _n(fs, t)
    ln = min(len(env), n - s0)
    if ln > 0:
        carrier = np.exp(2j * np.pi * off * np.arange(ln) / fs)
        iq[s0: s0 + ln] += (0.3 + 0.7 * np.clip(env[:ln], 0, 1)) * carrier
    meta = {"class": "miller", "miller_m": m, "blf_hz": blf,
            "bitrate": blf / m, "offset_hz": off, "hop_rate_hz": 0.0}
    return _finish(iq, fs, rng, snr_db, meta)


def synth_wifi_bt(fs: float = FS_DEFAULT, dur: float = 0.25,
                  lo_hz: float = 2440e6, seed=None, snr_db: float = 20.0) -> dict:
    """Wi-Fi/BT 2.4 ГГц: OFDM-пачки 20 МГц + BT FHSS 1600 скачков/с
    GFSK 1 Мбит/с (видима только часть сетки 2402–2480 относительно LO)."""
    rng = _rng(seed)
    p = PARAMS["wifi_bt"]
    n = _n(fs, dur)
    iq = np.zeros(n, dtype=np.complex64)
    fb = _visible_band(fs)
    # Wi-Fi: пачки 8–64 OFDM-символов со случайным duty
    t = rng.uniform(0, 0.005)
    while t < dur:
        burst = _ofdm_burst(int(rng.integers(8, 64)), p["wifi_srate"], rng)
        off = float(rng.uniform(-0.25 * fs, 0.25 * fs))
        s0 = _n(fs, t)
        m = min(len(burst), n - s0)
        if m > 0:
            iq[s0: s0 + m] += burst[:m] * np.exp(2j * np.pi * off * np.arange(m) / fs)
        t += len(burst) / p["wifi_srate"] + rng.uniform(0.001, 0.02)
    # BT: FHSS 1600/с по 79 каналам × 1 МГц
    chans = (np.linspace(p["bt_band"][0], p["bt_band"][1], 79) - lo_hz)
    times, freqs, vis = [], [], []
    t = rng.uniform(0, 1 / p["bt_hop"])
    while t < dur:
        off = float(rng.choice(chans))
        if abs(off) <= fb:
            bits = rng.integers(0, 2, max(2, int(p["bt_baud"] * 0.0005)))
            seg = _gfsk(bits, p["bt_baud"], p["bt_dev"], fs)
            n_seg = min(len(seg), n - _n(fs, t))
            if n_seg > 0:
                s0 = _n(fs, t)
                iq[s0: s0 + n_seg] += seg[:n_seg] * np.exp(2j * np.pi * off * np.arange(n_seg) / fs)
            vis.append(True)
        else:
            vis.append(False)
        times.append(t)
        freqs.append(off)
        t += 1 / p["bt_hop"]
    # BT — AFH: псевдослучайная таблица из clock/address пейринга; слепое
    # наблюдение паттерн НЕ восстанавливает (криптографический выбор канала).
    # Критерий 6.4 (предсказание) к этому классу неприменим физически.
    meta = {"class": "wifi_bt", "hop_rate_hz": p["bt_hop"],
            "hop_times_s": np.asarray(times),
            "hop_freqs_hz": np.asarray(freqs),
            "hop_visible": np.asarray(vis, dtype=bool),
            "deterministic": False}
    return _finish(iq, fs, rng, snr_db, meta)


def synth_analog_fpv(fs: float = FS_DEFAULT, dur: float = 0.25,
                     lo_hz: float = 5800e6, seed=None, snr_db: float = 20.0) -> dict:
    """Аналоговый FPV 5.8 ГГц: ЧМ видеосигналом (полоса ~3 МГц, шумо-
    подобное сообщение) + строчная синхронизация ~15.6 кГц. Непрерывный."""
    rng = _rng(seed)
    p = PARAMS["analog_fpv"]
    n = _n(fs, dur)
    msg = rng.standard_normal(n)
    # Видеополоса: ФНЧ до msg_bw скользящим средним по спектру
    spec = np.fft.rfft(msg)
    f = np.fft.rfftfreq(n, 1 / fs)
    spec[f > p["msg_bw"]] = 0.0
    msg = np.fft.irfft(spec, n)
    msg /= np.max(np.abs(msg)) + 1e-12
    sync = 0.3 * signal_square(fs, n, 15_625.0)
    iq = _fm(msg + sync, p["dev"] * 0.6, fs)
    off = float(rng.uniform(-0.15 * fs, 0.15 * fs))
    iq = (iq * np.exp(2j * np.pi * off * np.arange(n) / fs)).astype(np.complex64)
    meta = {"class": "analog_fpv", "dev_hz": p["dev"], "offset_hz": off,
            "hop_rate_hz": 0.0}
    return _finish(iq, fs, rng, snr_db, meta)


def signal_square(fs: float, n: int, freq: float) -> np.ndarray:
    t = np.arange(n) / fs
    return (np.sin(2 * np.pi * freq * t) > 0).astype(np.float64) * 2 - 1


GENERATORS = {
    "noise": synth_noise,
    "elrs_24": synth_elrs_24,
    "elrs_900": synth_elrs_900,
    "crossfire_fsk": synth_crossfire_fsk,
    "crossfire_lora": synth_crossfire_lora,
    "mavlink": synth_mavlink,
    "orangerx_dsmx": synth_orangerx_dsmx,
    "orangerx_fhss": synth_orangerx_fhss,
    "ttlrs": synth_ttlrs,
    "miller": synth_miller,
    "wifi_bt": synth_wifi_bt,
    "analog_fpv": synth_analog_fpv,
}

# LO по умолчанию для класса (шаг 9.3: один LO на все протоколы не обещаем).
CLASS_LO_HZ = {
    "noise": 2400e6,
    "elrs_24": 2440e6, "orangerx_dsmx": 2440e6, "orangerx_fhss": 2440e6,
    "wifi_bt": 2440e6,
    "elrs_900": 868e6, "crossfire_fsk": 868e6, "crossfire_lora": 868e6,
    "mavlink": 868e6, "ttlrs": 868e6, "miller": 915e6,
    "analog_fpv": 5800e6,
}
