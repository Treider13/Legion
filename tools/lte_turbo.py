#!/usr/bin/env python3
"""LTE turbo + rate matching как в proto17/dji_droneid remove_turbo.cc.

Факты (3GPP TS 36.212 / turbofec / proto17):
  K=1408, D=K+4=1412, E=7200, rv=0
  interleaver f1=43 f2=88 (таблица 5.1.3-3, строка K=1408)
  RSC: G0=13₈ = 1+D+D³, G1=15₈ = 1+D+D²+D³
  CRC-24/LTE-A: poly 0x864CFB, init 0, refin/refout false, xorout 0
  (CRCpp CRC_24_LTEA — тот же, что remove_turbo.cc)
"""
from __future__ import annotations

import math
from typing import Iterable

TURBO_K = 1408
TURBO_D = 1412
TURBO_E = 7200
TURBO_F1 = 43
TURBO_F2 = 88
TURBO_ITERS = 4
C_TC = 32
P_COL = (
    0, 16, 8, 24, 4, 20, 12, 28, 2, 18, 10, 26, 6, 22, 14, 30,
    1, 17, 9, 25, 5, 21, 13, 29, 3, 19, 11, 27, 7, 23, 15, 31,
)
CRC24_LTEA_POLY = 0x864CFB
NULL = -128


def crc24_ltea(data: bytes) -> int:
    crc = 0
    for b in data:
        crc ^= b << 16
        for _ in range(8):
            if crc & 0x800000:
                crc = ((crc << 1) ^ CRC24_LTEA_POLY) & 0xFFFFFF
            else:
                crc = (crc << 1) & 0xFFFFFF
    return crc


def turbo_interleave_idx(k: int = TURBO_K, f1: int = TURBO_F1, f2: int = TURBO_F2) -> list[int]:
    return [((f1 * i + f2 * i * i) % k) for i in range(k)]


def _rsc_step(u: int, state: int) -> tuple[int, int]:
    """Один такт LTE RSC. state: bit0=D, bit1=D², bit2=D³."""
    d1 = state & 1
    d2 = (state >> 1) & 1
    d3 = (state >> 2) & 1
    fb = u ^ d1 ^ d3
    parity = fb ^ d1 ^ d2 ^ d3
    nxt = ((state << 1) | fb) & 7
    return parity, nxt


def _rsc_encode(bits: list[int]) -> tuple[list[int], list[int], list[int], list[int]]:
    state = 0
    sys: list[int] = []
    par: list[int] = []
    for u in bits:
        p, state = _rsc_step(u, state)
        sys.append(u)
        par.append(p)
    tail_sys: list[int] = []
    tail_par: list[int] = []
    for _ in range(3):
        d1 = state & 1
        d3 = (state >> 2) & 1
        u = d1 ^ d3
        p, state = _rsc_step(u, state)
        tail_sys.append(u)
        tail_par.append(p)
    return sys, par, tail_sys, tail_par


def turbo_encode(bits: list[int]) -> tuple[list[int], list[int], list[int]]:
    """Три потока d0/d1/d2 длины D=K+4 (36.212 5.1.3.2.2)."""
    if len(bits) != TURBO_K:
        raise ValueError(f"turbo_encode: нужно {TURBO_K} бит, дали {len(bits)}")
    pi = turbo_interleave_idx()
    x, z, xt, zt = _rsc_encode(bits)
    xp, zp, xpt, zpt = _rsc_encode([bits[pi[i]] for i in range(TURBO_K)])
    d0 = x + [xt[0], zt[1], xpt[0], zpt[1]]
    d1 = z + [zt[0], xt[2], zpt[0], xpt[2]]
    d2 = zp + [xt[1], zt[2], xpt[1], zpt[2]]
    return d0, d1, d2


def _subblock_rows(d: int) -> tuple[int, int, int]:
    rows = int(math.ceil(d / float(C_TC)))
    v = rows * C_TC
    shift = v - d
    return rows, v, shift


def _interlv(z: list[int], d: int) -> list[int]:
    rows, v, shift = _subblock_rows(d)
    pad = [NULL] * shift + list(z[:d])
    out = [0] * v
    for r in range(rows):
        row = pad[r * C_TC : (r + 1) * C_TC]
        perm = [row[P_COL[c]] for c in range(C_TC)]
        for c in range(C_TC):
            out[c * rows + r] = perm[c]
    return out


def _interlv_v2(z: list[int], d: int) -> tuple[list[int], list[int]]:
    rows, v, shift = _subblock_rows(d)
    pad = [NULL] * shift + list(z[:d])
    out = [0] * v
    pi = [0] * v
    for k in range(v):
        pik = (P_COL[k // rows] + 32 * (k % rows) + 1) % v
        out[k] = pad[pik]
        pi[k] = pik
    return out, pi


def _deinterlv(v_stream: list[int], d: int) -> list[int]:
    rows, v, shift = _subblock_rows(d)
    tmp = [0] * v
    for c in range(C_TC):
        for r in range(rows):
            tmp[r * C_TC + c] = v_stream[c * rows + r]
    zpad = [0] * v
    for r in range(rows):
        row = tmp[r * C_TC : (r + 1) * C_TC]
        unperm = [0] * C_TC
        for i in range(C_TC):
            unperm[P_COL[i]] = row[i]
        zpad[r * C_TC : (r + 1) * C_TC] = unperm
    return zpad[shift : shift + d]


def _deinterlv_v2(v_stream: list[int], d: int, pi: list[int]) -> list[int]:
    rows, v, shift = _subblock_rows(d)
    zpad = [0] * v
    for k in range(v):
        zpad[pi[k]] = v_stream[k]
    return zpad[shift : shift + d]


def rate_match_fw(d0: list[int], d1: list[int], d2: list[int], e_len: int = TURBO_E, rv: int = 0) -> list[int]:
    d = len(d0)
    rows, v, _ = _subblock_rows(d)
    v0 = _interlv(d0, d)
    v1 = _interlv(d1, d)
    v2, _pi = _interlv_v2(d2, d)
    w = list(v0) + [0] * (2 * v)
    for i in range(v):
        w[v + 2 * i] = v1[i]
        w[v + 2 * i + 1] = v2[i]
    n_cb = 3 * v
    k0 = rows * (2 * int(math.ceil(n_cb / (8.0 * rows))) * rv + 2)
    e: list[int] = []
    n = k0
    w_len = 3 * v
    while len(e) < e_len:
        n = n % w_len
        if w[n] != NULL:
            e.append(w[n])
        n += 1
    return e


def _dummy_w(d: int) -> tuple[list[int], list[int], int, int]:
    """w после sub-block interleave нулей: NULL (−128) стоят на dummy-паде."""
    dummy = [0] * d
    v0 = _interlv(dummy, d)
    v1 = _interlv(dummy, d)
    v2, pi = _interlv_v2(dummy, d)
    v = len(v0)
    w = list(v0) + [0] * (2 * v)
    for i in range(v):
        w[v + 2 * i] = v1[i]
        w[v + 2 * i + 1] = v2[i]
    return w, pi, v, len(w)


def rate_match_rv(e: list[int], d: int = TURBO_D, rv: int = 0) -> tuple[list[int], list[int], list[int]]:
    """Обратный rate match: soft bits E → три потока D (как lte_rate_match_rv)."""
    rows, _v, _ = _subblock_rows(d)
    w_probe, pi, v, w_len = _dummy_w(d)
    n_cb = w_len
    k0 = rows * (2 * int(math.ceil(n_cb / (8.0 * rows))) * rv + 2)
    w_null: list[int] = []
    n = k0
    seen = 0
    while seen < w_len:
        n = n % w_len
        if w_probe[n] == NULL and n not in w_null:
            w_null.append(n)
        n += 1
        seen += 1
    w = [0] * w_len
    for idx in w_null:
        w[idx] = NULL
    n = k0
    i = 0
    while i < len(e):
        n = n % w_len
        if w[n] == NULL:
            n += 1
            continue
        val = int(w[n]) + int(e[i])
        if val > 127:
            val = 127
        if val < -127:
            val = -127
        w[n] = val
        i += 1
        n += 1
    ov0 = w[:v]
    ov1 = [w[v + 2 * i] for i in range(v)]
    ov2 = [w[v + 2 * i + 1] for i in range(v)]
    return _deinterlv(ov0, d), _deinterlv(ov1, d), _deinterlv_v2(ov2, d, pi)


def _maxstar(a: float, b: float) -> float:
    return a if a > b else b


def _map_decode(
    sys_llr: list[float],
    par_llr: list[float],
    apriori: list[float],
    n: int,
) -> list[float]:
    """Max-log-MAP, 8 состояний, хвост 3 такта встроен в длину n (без хвоста — n=K)."""
    # Переходы: (state, u) → (next, parity)
    nxt = [[0, 0] for _ in range(8)]
    par = [[0, 0] for _ in range(8)]
    for s in range(8):
        for u in (0, 1):
            p, ns = _rsc_step(u, s)
            nxt[s][u] = ns
            par[s][u] = p
    prev: list[list[tuple[int, int]]] = [[] for _ in range(8)]
    for s in range(8):
        for u in (0, 1):
            prev[nxt[s][u]].append((s, u))

    alpha = [[-1e9] * 8 for _ in range(n + 1)]
    beta = [[-1e9] * 8 for _ in range(n + 1)]
    alpha[0][0] = 0.0
    for k in range(n):
        la = apriori[k] if k < len(apriori) else 0.0
        ys = sys_llr[k] if k < len(sys_llr) else 0.0
        yp = par_llr[k] if k < len(par_llr) else 0.0
        for s in range(8):
            if alpha[k][s] < -1e8:
                continue
            for u in (0, 1):
                sign_u = 1.0 if u else -1.0
                sign_p = 1.0 if par[s][u] else -1.0
                gamma = 0.5 * (la + ys) * sign_u + 0.5 * yp * sign_p
                ns = nxt[s][u]
                alpha[k + 1][ns] = _maxstar(alpha[k + 1][ns], alpha[k][s] + gamma)
        m = max(alpha[k + 1])
        for s in range(8):
            alpha[k + 1][s] -= m

    beta[n][0] = 0.0
    for s in range(1, 8):
        beta[n][s] = -1e9
    for k in range(n - 1, -1, -1):
        la = apriori[k] if k < len(apriori) else 0.0
        ys = sys_llr[k] if k < len(sys_llr) else 0.0
        yp = par_llr[k] if k < len(par_llr) else 0.0
        for s in range(8):
            for u in (0, 1):
                sign_u = 1.0 if u else -1.0
                sign_p = 1.0 if par[s][u] else -1.0
                gamma = 0.5 * (la + ys) * sign_u + 0.5 * yp * sign_p
                ns = nxt[s][u]
                beta[k][s] = _maxstar(beta[k][s], beta[k + 1][ns] + gamma)
        m = max(beta[k])
        for s in range(8):
            beta[k][s] -= m

    ext = [0.0] * n
    for k in range(n):
        ys = sys_llr[k] if k < len(sys_llr) else 0.0
        yp = par_llr[k] if k < len(par_llr) else 0.0
        la = apriori[k] if k < len(apriori) else 0.0
        m0 = m1 = -1e9
        for s in range(8):
            for u in (0, 1):
                sign_p = 1.0 if par[s][u] else -1.0
                gamma_p = 0.5 * yp * sign_p
                met = alpha[k][s] + gamma_p + beta[k + 1][nxt[s][u]]
                if u:
                    m1 = _maxstar(m1, met)
                else:
                    m0 = _maxstar(m0, met)
        ext[k] = (m1 - m0)
    return ext


def turbo_decode(
    d0: list[int],
    d1: list[int],
    d2: list[int],
    iterations: int = TURBO_ITERS,
) -> list[int]:
    """Декод K информационных бит. d* — soft int8, длина D."""
    k = TURBO_K
    pi = turbo_interleave_idx()
    inv = [0] * k
    for i, p in enumerate(pi):
        inv[p] = i
    sys = [float(x) for x in d0[:k]]
    par1 = [float(x) for x in d1[:k]]
    par2 = [float(x) for x in d2[:k]]
    ext = [0.0] * k
    hard = [0] * k
    for _ in range(iterations):
        ext1 = _map_decode(sys, par1, ext, k)
        ap2 = [0.0] * k
        sys2 = [0.0] * k
        for i in range(k):
            ap2[i] = ext1[pi[i]]
            sys2[i] = sys[pi[i]]
        ext2i = _map_decode(sys2, par2, ap2, k)
        for i in range(k):
            ext[pi[i]] = ext2i[i]
        for i in range(k):
            hard[i] = 1 if (sys[i] + ext1[i] + ext[i]) > 0 else 0
    return hard


def bits_to_bytes(bits: Iterable[int]) -> bytes:
    seq = list(bits)
    out = bytearray((len(seq) + 7) // 8)
    for i, b in enumerate(seq):
        if b:
            out[i // 8] |= 1 << (7 - (i % 8))
    return bytes(out)


def bytes_to_bits(data: bytes) -> list[int]:
    bits: list[int] = []
    for b in data:
        for i in range(7, -1, -1):
            bits.append((b >> i) & 1)
    return bits


def encode_droneid_coded(payload: bytes) -> list[int]:
    """173 байта + CRC-24/LTE-A → 7200 бит (как remove_turbo наоборот)."""
    raw = bytes(payload[:173]).ljust(173, b"\x00")
    crc = crc24_ltea(raw)
    block = raw + bytes([(crc >> 16) & 0xFF, (crc >> 8) & 0xFF, crc & 0xFF])
    bits = bytes_to_bits(block)
    if len(bits) != TURBO_K:
        raise ValueError(f"encode: {len(bits)} бит, нужно {TURBO_K}")
    d0, d1, d2 = turbo_encode(bits)
    return rate_match_fw(d0, d1, d2, TURBO_E, 0)


def decode_droneid_soft(e_llr: list[float] | list[int]) -> dict:
    """7200 soft LLR (плюс = бит 1) → 176 байт + CRC-24/LTE-A."""
    if len(e_llr) < TURBO_E:
        return {"ok": False, "reason": f"мало бит: {len(e_llr)} < {TURBO_E}"}
    soft = [max(-127, min(127, int(round(float(x))))) for x in e_llr[:TURBO_E]]
    if all(v == 0 for v in soft):
        return {"ok": False, "reason": "пустые LLR"}
    d0, d1, d2 = rate_match_rv(soft, TURBO_D, 0)
    hard = turbo_decode(d0, d1, d2, TURBO_ITERS)
    payload = bits_to_bytes(hard)
    if len(payload) < 176:
        payload = payload + bytes(176 - len(payload))
    payload = payload[:176]
    crc = crc24_ltea(payload)
    return {
        "ok": crc == 0,
        "crc": crc,
        "bytes": payload,
        "reason": None if crc == 0 else f"CRC-24/LTE-A не ноль ({crc:06x})",
    }


def decode_droneid_coded(e_bits: list[int]) -> dict:
    """7200 hard bits → 176 байт + CRC-24/LTE-A. Как remove_turbo.cc."""
    if len(e_bits) < TURBO_E:
        return {"ok": False, "reason": f"мало бит: {len(e_bits)} < {TURBO_E}"}
    return decode_droneid_soft([63.0 if b else -63.0 for b in e_bits[:TURBO_E]])
