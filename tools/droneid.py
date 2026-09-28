#!/usr/bin/env python3
"""DJI DroneID (OcuSync O2/O3 plaintext) по proto17 + NDSS 2023 + anarkiwi.

xA4: 61.44 MSPS / 4 = 15.36 MSPS ровно (FFT 1024, SCS 15 кГц).
ZC: root 600 (символ 4) и 147 (символ 6), длина 601, DC=0.
CP: long = fs/192000 = 80, short = 4.6875 мкс · fs = 72 @ 15.36e6
    (proto17 / LTE normal CP 4.69 мкс, extended 5.21 мкс ≈ 1/192000).
Скремблер: LTE Gold 36.211 7.2, x2 = bit-reverse 0x12345678 (31 бит, MSB→x2[0]).
Данные: символы 2,3,5,7,8,9 → 7200 бит → turbo D=1412 E=7200 → 176 байт.
Распаковка 91 байт: anarkiwi/samples2djidroneid decode_djidroneid.py.
Эквалайзер: H = среднее(Y4/X600, Y6/X147) на 600 несущих (proto17).
CFO: угол CP-корреляции / (2π N_fft) · fs (coarse, proto17; fine skipped).
O3+/O4: ZC есть, CRC/кадр не сходится — детект без plaintext (не decrypt).
"""
from __future__ import annotations

import math
import struct
from typing import Any

import numpy as np

from lte_turbo import TURBO_E, decode_droneid_coded, decode_droneid_soft, encode_droneid_coded

DRONEID_FS = 15_360_000.0
DRONEID_SCS = 15_000.0
DRONEID_CARRIERS = 600
DRONEID_CORR = 0.45
LATLON_SCALE = 174533.0
DATA_SYMS = (1, 2, 4, 6, 7, 8)  # 0-based: 2,3,5,7,8,9
X2_INIT_BITS = [
    0, 0, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 0, 0, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 0, 0, 0,
]


def fft_size(fs: float) -> int:
    return int(round(float(fs) / DRONEID_SCS))


def cyclic_prefix_lengths(fs: float) -> tuple[int, int]:
    return int(round((1.0 / 192000.0) * fs)), int(round(0.0000046875 * fs))


def data_carrier_indices(fs: float) -> np.ndarray:
    n = fft_size(fs)
    dc = n // 2
    half = DRONEID_CARRIERS // 2
    idx = np.concatenate([np.arange(dc - half, dc), np.arange(dc + 1, dc + 1 + half)])
    return idx.astype(np.int64)


def zc_freq(fs: float, symbol_index: int) -> np.ndarray:
    """600 несущих ZC в частоте (DC выколот). proto17 create_zc."""
    if symbol_index == 4:
        root = 600
    elif symbol_index == 6:
        root = 147
    else:
        raise ValueError("ZC только символы 4 и 6")
    zc = np.exp(-1j * math.pi * root * np.arange(0, 601) * np.arange(1, 602) / 601.0)
    return np.delete(zc, 300)


def create_zc(fs: float, symbol_index: int) -> np.ndarray:
    n = fft_size(fs)
    freq = np.zeros(n, dtype=np.complex128)
    freq[data_carrier_indices(fs)] = zc_freq(fs, symbol_index)
    # freq — сетка fftshift (DC в центре). ifft(ifftshift) ↔ extract fftshift(fft).
    return np.fft.ifft(np.fft.ifftshift(freq))


def gold_scrambler(num_bits: int, x2_init: list[int] | None = None) -> np.ndarray:
    """LTE 36.211 7.2. x2_init — 31 бит, bit-reverse 0x12345678 как у proto17."""
    init = list(X2_INIT_BITS if x2_init is None else x2_init)
    if len(init) != 31:
        raise ValueError("x2_init должен быть 31 бит")
    nc = 1600
    x1 = np.zeros(nc + num_bits + 31, dtype=np.uint8)
    x2 = np.zeros(nc + num_bits + 31, dtype=np.uint8)
    x1[0] = 1
    x2[:31] = init
    for n in range(num_bits + nc):
        x1[n + 31] = (int(x1[n + 3]) + int(x1[n])) & 1
        x2[n + 31] = (int(x2[n + 3]) + int(x2[n + 2]) + int(x2[n + 1]) + int(x2[n])) & 1
    return (x1[nc : nc + num_bits] ^ x2[nc : nc + num_bits]).astype(np.uint8)


def resample_to_droneid(x: np.ndarray, fs: float) -> tuple[np.ndarray, float]:
    """xA4 61.44 → 15.36 ровно /4. 30.72 → /2. Иначе не выдумываем ресэмплер."""
    z = np.asarray(x, dtype=np.complex64).ravel()
    rate = float(fs)
    if rate <= 0 or z.size < 64:
        return np.zeros(0, dtype=np.complex64), 0.0
    ratio = rate / DRONEID_FS
    if abs(ratio - 4.0) < 1e-6:
        return z[::4], DRONEID_FS
    if abs(ratio - 2.0) < 1e-6:
        return z[::2], DRONEID_FS
    if abs(ratio - 1.0) < 1e-6:
        return z, DRONEID_FS
    return np.zeros(0, dtype=np.complex64), 0.0


def _norm_xcorr(x: np.ndarray, ref: np.ndarray) -> np.ndarray:
    n = int(x.size)
    m = int(ref.size)
    if n < m:
        return np.zeros(0, dtype=np.float64)
    nfft = 1 << int(math.ceil(math.log2(n + m)))
    xf = np.fft.fft(x, nfft)
    rf = np.fft.fft(np.conj(ref[::-1]), nfft)
    corr = np.fft.ifft(xf * rf)[: n - m + 1]
    p = np.convolve(np.abs(x) ** 2, np.ones(m), mode="valid")
    den = np.sqrt(p * float(np.sum(np.abs(ref) ** 2))) + 1e-20
    return np.abs(corr) / den


def find_zc(x: np.ndarray, fs: float, threshold: float = DRONEID_CORR) -> list[dict[str, Any]]:
    zc4 = create_zc(fs, 4)
    score = _norm_xcorr(np.asarray(x, dtype=np.complex128), zc4)
    if score.size == 0:
        return []
    hits: list[dict[str, Any]] = []
    nfft = fft_size(fs)
    _long_cp, short_cp = cyclic_prefix_lengths(fs)
    min_gap = nfft + short_cp
    i = 0
    while i < score.size:
        if score[i] >= threshold:
            j = int(i + np.argmax(score[i : min(i + min_gap, score.size)]))
            hits.append({"offset": j, "score": float(score[j]), "root": 600, "symbol": 4})
            i = j + min_gap
        else:
            i += 1
    return hits


def _qpsk_bits(carriers: np.ndarray) -> np.ndarray:
    """1+j→00, 1−j→01, −1+j→10, −1−j→11 (proto17 / LTE QPSK)."""
    bits = np.zeros(int(carriers.size) * 2, dtype=np.uint8)
    bits[0::2] = (np.real(carriers) < 0).astype(np.uint8)
    bits[1::2] = (np.imag(carriers) < 0).astype(np.uint8)
    return bits


def _qpsk_llr(carriers: np.ndarray) -> np.ndarray:
    """Soft: плюс = бит 1. bit0 = 1 при Re<0 → LLR = −Re."""
    llr = np.empty(int(carriers.size) * 2, dtype=np.float64)
    llr[0::2] = -np.real(carriers)
    llr[1::2] = -np.imag(carriers)
    peak = float(np.max(np.abs(llr))) + 1e-12
    return llr * (63.0 / peak)


def _bits_to_qpsk(bits: np.ndarray) -> np.ndarray:
    b = np.asarray(bits, dtype=np.uint8).ravel()
    if b.size % 2:
        b = np.concatenate([b, np.zeros(1, dtype=np.uint8)])
    re = np.where(b[0::2] == 0, 1.0, -1.0)
    im = np.where(b[1::2] == 0, 1.0, -1.0)
    return (re + 1j * im) / math.sqrt(2.0)


def symbol_schedule(fs: float, eight: bool = False) -> list[int]:
    long_cp, short_cp = cyclic_prefix_lengths(fs)
    if eight:
        return [short_cp] * 8
    return [long_cp, short_cp, short_cp, short_cp, short_cp, short_cp, short_cp, short_cp, long_cp]


def burst_len(fs: float, eight: bool = False) -> int:
    nfft = fft_size(fs)
    return int(sum(symbol_schedule(fs, eight)) + nfft * (8 if eight else 9))


def extract_ofdm(burst: np.ndarray, fs: float, eight: bool = False) -> np.ndarray:
    nfft = fft_size(fs)
    sched = symbol_schedule(fs, eight)
    out = np.zeros((len(sched), nfft), dtype=np.complex128)
    off = 0
    for i, cp in enumerate(sched):
        start = off + cp
        end = start + nfft
        if end > burst.size:
            break
        out[i] = np.fft.fftshift(np.fft.fft(burst[start:end]))
        off = end
    return out


def coarse_cfo(burst: np.ndarray, fs: float, eight: bool = False) -> float:
    """Угол CP × конец символа. proto17 coarse FOC, fine skipped."""
    nfft = fft_size(fs)
    acc = 0j
    off = 0
    for cp in symbol_schedule(fs, eight):
        a = off
        b = off + cp
        c = off + nfft
        d = off + nfft + cp
        if d > burst.size:
            break
        acc += complex(np.vdot(burst[c:d], burst[a:b]))
        off = d
    if acc == 0:
        return 0.0
    return float(np.angle(acc) / (2.0 * math.pi) * fs / nfft)


def apply_cfo(x: np.ndarray, fs: float, hz: float) -> np.ndarray:
    if abs(hz) < 1.0:
        return np.asarray(x, dtype=np.complex64)
    t = np.arange(int(x.size), dtype=np.float64) / float(fs)
    return (np.asarray(x, dtype=np.complex128) * np.exp(-1j * 2.0 * math.pi * hz * t)).astype(np.complex64)


def equalize(freq: np.ndarray, fs: float, eight: bool = False) -> np.ndarray:
    """H по ZC символов 4 и 6 (1-based). 8-символьный кадр: те же индексы −1."""
    carriers = data_carrier_indices(fs)
    i4 = 2 if eight else 3
    i6 = 4 if eight else 5
    if freq.shape[0] <= i6:
        return freq
    h4 = freq[i4, carriers] / (zc_freq(fs, 4) + 1e-12)
    h6 = freq[i6, carriers] / (zc_freq(fs, 6) + 1e-12)
    h = 0.5 * (h4 + h6)
    h = np.where(np.abs(h) < 1e-6, 1.0 + 0j, h)
    out = freq.copy()
    for i in range(out.shape[0]):
        out[i, carriers] = freq[i, carriers] / h
    return out


def unpack_droneid_91(data: bytes) -> dict[str, Any] | None:
    """anarkiwi decode_djidroneid.py: 91 байт LE, lat/lon /174533."""
    if len(data) < 91:
        return None
    fmt = "<BBBH h 16s i i H H h h h h Q i i i i B B 19s B h"
    try:
        t = struct.unpack(fmt, data[:91])
    except struct.error:
        return None
    serial = t[5].split(b"\x00", 1)[0].decode("ascii", errors="ignore")
    uuid = t[21][: max(0, min(19, int(t[20])))].split(b"\x00", 1)[0].decode("ascii", errors="ignore")
    lat = t[7] / LATLON_SCALE
    lon = t[6] / LATLON_SCALE
    if abs(lat) > 90 or abs(lon) > 180:
        return None
    return {
        "framelen": int(t[0]),
        "msgtype": int(t[1]),
        "version": int(t[2]),
        "seqno": int(t[3]),
        "state_info": int(t[4]),
        "serial": serial,
        "longitude": lon,
        "latitude": lat,
        "height": int(t[8]),
        "altitude": int(t[9]),
        "velocity_north": int(t[10]),
        "velocity_east": int(t[11]),
        "velocity_up": int(t[12]),
        "yaw": float(t[13]) / 100.0 / 57.296,
        "phone_app_gps_time": int(t[14]),
        "phone_app_latitude": t[15] / LATLON_SCALE,
        "phone_app_longitude": t[16] / LATLON_SCALE,
        "home_latitude": t[17] / LATLON_SCALE,
        "home_longitude": t[18] / LATLON_SCALE,
        "product_type": int(t[19]),
        "uuid": uuid,
        "crc": int(t[23]),
    }


def _plain_from_tb(raw: bytes) -> dict[str, Any] | None:
    if not raw:
        return None
    return unpack_droneid_91(raw[:91] if len(raw) >= 91 else raw.ljust(91, b"\x00"))


def demod_burst(burst: np.ndarray, fs: float, eight: bool = False) -> dict[str, Any]:
    """Один burst: CFO → OFDM → EQ(ZC) → QPSK → Gold → turbo → 91 байт."""
    empty = {"ok": False, "zc": True, "plain": None, "reason": "demod"}
    cfo = coarse_cfo(burst, fs, eight)
    work = apply_cfo(burst, fs, cfo)
    freq = equalize(extract_ofdm(work, fs, eight), fs, eight)
    carriers = data_carrier_indices(fs)
    if freq.shape[0] < (8 if eight else 9):
        empty["reason"] = "мало символов"
        return empty
    data_idx = tuple(i - 1 for i in (2, 3, 5, 7, 8, 9)) if not eight else (0, 1, 3, 5, 6, 7)
    if max(data_idx) >= freq.shape[0]:
        empty["reason"] = "мало символов"
        return empty
    llr = np.concatenate([_qpsk_llr(freq[i, carriers]) for i in data_idx])
    hard = np.concatenate([_qpsk_bits(freq[i, carriers]) for i in data_idx])
    if hard.size != TURBO_E:
        empty["reason"] = f"бит {hard.size}, нужно {TURBO_E}"
        return empty
    scr = gold_scrambler(TURBO_E)
    xored = np.bitwise_xor(hard, scr)
    llr_x = llr * np.where(scr == 0, 1.0, -1.0)
    dec = decode_droneid_soft(llr_x.tolist())
    if not dec.get("ok"):
        dec = decode_droneid_coded([int(b) for b in xored])
    if not dec.get("ok"):
        return {
            "ok": False,
            "zc": True,
            "plain": None,
            "reason": dec.get("reason") or "turbo/CRC",
            "encrypted": True,
            "cfoHz": cfo,
        }
    raw = dec["bytes"]
    plain = _plain_from_tb(raw)
    if plain is None or not plain.get("serial"):
        return {
            "ok": False,
            "zc": True,
            "plain": None,
            "reason": "кадр не 91 байт",
            "encrypted": True,
            "cfoHz": cfo,
        }
    return {
        "ok": True,
        "zc": True,
        "plain": plain,
        "hex": raw[:176].hex(),
        "reason": None,
        "cfoHz": cfo,
        "encrypted": False,
    }


def analyze_droneid(x: np.ndarray, fs: float) -> dict[str, Any]:
    """Поиск ZC и plaintext. fs родной; 61.44 режем /4."""
    none = {
        "hit": False,
        "zcScore": 0.0,
        "ok": False,
        "plain": None,
        "reason": "нет ZC",
        "encrypted": False,
    }
    work, work_fs = resample_to_droneid(x, fs)
    if work.size < 2048 or work_fs <= 0:
        none["reason"] = "нужен 15.36/30.72/61.44 MSPS (xA4 61.44/4)"
        return none
    hits = find_zc(work, work_fs)
    if not hits:
        return none
    best = max(hits, key=lambda h: h["score"])
    long_cp, short_cp = cyclic_prefix_lengths(work_fs)
    nfft = fft_size(work_fs)
    zc_start = int(best["offset"])
    start9 = max(0, zc_start - (long_cp + 3 * (short_cp + nfft)))
    need9 = burst_len(work_fs, False)
    burst9 = work[start9 : start9 + need9]
    dec = {"ok": False, "reason": "burst обрезан", "encrypted": False}
    if burst9.size >= need9:
        dec = demod_burst(burst9, work_fs, False)
    if not dec.get("ok"):
        start8 = max(0, zc_start - (2 * (short_cp + nfft) + short_cp))
        need8 = burst_len(work_fs, True)
        burst8 = work[start8 : start8 + need8]
        if burst8.size >= need8:
            dec8 = demod_burst(burst8, work_fs, True)
            if dec8.get("ok") or not dec.get("ok"):
                dec = dec8
    return {
        "hit": True,
        "zcScore": best["score"],
        "ok": bool(dec.get("ok")),
        "plain": dec.get("plain"),
        "reason": dec.get("reason"),
        "encrypted": bool(dec.get("encrypted")),
        "hex": dec.get("hex"),
        "cfoHz": dec.get("cfoHz"),
    }


def pack_droneid_91(
    serial: str = "1581F5YHD228Q00A",
    lat: float = 47.1,
    lon: float = 8.2,
    height: int = 120,
    altitude: int = 540,
    product_type: int = 63,
    uuid: str = "legion-lab",
) -> bytes:
    """Собрать 91 байт как anarkiwi — для тестов распаковки и OFDM-синтеза."""
    serial_b = serial.encode("ascii")[:16].ljust(16, b"\x00")
    uuid_b = uuid.encode("ascii")[:19].ljust(19, b"\x00")
    return struct.pack(
        "<BBBH h 16s i i H H h h h h Q i i i i B B 19s B h",
        91,
        0x10,
        1,
        1,
        0,
        serial_b,
        int(round(lon * LATLON_SCALE)),
        int(round(lat * LATLON_SCALE)),
        height,
        altitude,
        0,
        0,
        0,
        0,
        0,
        int(round(lat * LATLON_SCALE)),
        int(round(lon * LATLON_SCALE)),
        int(round(lat * LATLON_SCALE)),
        int(round(lon * LATLON_SCALE)),
        product_type,
        min(19, len(uuid.encode("ascii"))),
        uuid_b,
        0,
        0,
    )


def synth_droneid_burst(frame91: bytes | None = None, fs: float = DRONEID_FS) -> np.ndarray:
    """Один 9-символьный burst для тестов приёма. Не эфирный TX."""
    raw = frame91 if frame91 is not None else pack_droneid_91()
    coded = np.asarray(encode_droneid_coded(raw), dtype=np.uint8)
    if coded.size != TURBO_E:
        raise ValueError("turbo E")
    scr = gold_scrambler(TURBO_E)
    bits = np.bitwise_xor(coded, scr)
    chunks = bits.reshape(6, 1200)
    nfft = fft_size(fs)
    carriers = data_carrier_indices(fs)
    freq = np.zeros((9, nfft), dtype=np.complex128)
    data_pos = DATA_SYMS
    for k, si in enumerate(data_pos):
        freq[si, carriers] = _bits_to_qpsk(chunks[k])
    freq[3, carriers] = zc_freq(fs, 4)
    freq[5, carriers] = zc_freq(fs, 6)
    parts: list[np.ndarray] = []
    for i, cp in enumerate(symbol_schedule(fs, False)):
        td = np.fft.ifft(np.fft.ifftshift(freq[i]))
        parts.append(np.concatenate([td[-cp:], td]))
    return np.concatenate(parts).astype(np.complex64)
