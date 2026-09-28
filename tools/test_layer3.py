#!/usr/bin/env python3
"""Layer 3 + ELRS/mLRS + turbo: живые круглые пути, не заглушки."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

import droneid as dji
import lte_turbo as tb
import opendroneid as od
import rc_spectrum as rc

fail = 0


def check(name: str, cond: bool, detail: str = "") -> None:
    global fail
    if cond:
        print(f"  PASS  {name}")
    else:
        fail += 1
        print(f"  FAIL  {name} {detail}")


def main() -> int:
    raw = b"LEGION-DRONEID-TEST" + bytes(range(40))
    raw = raw[:173].ljust(173, b"\x00")
    coded = tb.encode_droneid_coded(raw)
    check("turbo E=7200", len(coded) == tb.TURBO_E, str(len(coded)))
    dec = tb.decode_droneid_coded(coded)
    check("turbo CRC=0", dec.get("ok") is True, str(dec.get("reason")))
    check("turbo 173 байт", dec.get("bytes", b"")[:173] == raw, str(dec.get("bytes", b"")[:20]))

    frame = dji.pack_droneid_91("1581F5YHD228Q00A", 47.1, 8.2, 120, 540, 63, "legion-lab")
    check("91 байт", len(frame) == 91, str(len(frame)))
    plain = dji.unpack_droneid_91(frame)
    check("serial", plain is not None and plain["serial"] == "1581F5YHD228Q00A", str(plain))
    check("lat", plain is not None and abs(plain["latitude"] - 47.1) < 1e-4, str(plain))

    burst = dji.synth_droneid_burst(frame, dji.DRONEID_FS)
    check("burst длина 9 символов", burst.size == dji.burst_len(dji.DRONEID_FS, False), str(burst.size))
    got = dji.analyze_droneid(burst, dji.DRONEID_FS)
    check("ZC hit", got.get("hit") is True, str(got))
    check("plaintext ok", got.get("ok") is True, str(got.get("reason")))
    check(
        "serial с эфира",
        (got.get("plain") or {}).get("serial") == "1581F5YHD228Q00A",
        str(got.get("plain")),
    )

    x61 = np.zeros(burst.size * 4, dtype=np.complex64)
    x61[::4] = burst
    got61 = dji.analyze_droneid(x61, 61.44e6)
    check("xA4 61.44/4 plaintext", got61.get("ok") is True, str(got61.get("reason")))

    basic = od.encode_basic_id("TEST-UAS-001", 1, 2)
    loc = od.encode_location(55.75, 37.62, 150.0, 40.0, 2)
    check("basic 25", len(basic) == 25)
    check("loc 25", len(loc) == 25)
    db = od.decode_basic_id(basic)
    dl = od.decode_location(loc)
    check("basic id", db is not None and db["uasId"] == "TEST-UAS-001", str(db))
    check("loc lat", dl is not None and abs(dl["latitude"] - 55.75) < 1e-6, str(dl))
    pack = od.encode_message_pack([basic, loc])
    parsed = od.parse_opendroneid(pack)
    check("pack hit", parsed["hit"] is True, str(parsed))
    check("pack uasId", parsed["uas"].get("uasId") == "TEST-UAS-001", str(parsed["uas"]))

    ie = bytes(12) + od.encode_wifi_beacon_ie(basic)
    pie = od.parse_opendroneid(ie)
    check("IE 221 FA:0B:BC", pie["hit"] is True and pie["uas"].get("uasId") == "TEST-UAS-001", str(pie))

    ble = od.encode_ble_ad(basic)
    pble = od.parse_opendroneid(ble)
    check("BLE 0xFFFA", pble["hit"] is True and pble["uas"].get("uasId") == "TEST-UAS-001", str(pble))

    fs = 2.0e6
    n = int(fs * 0.12)
    elrs = rc.synth_rc_train(fs, 250.0, n, css=True, pkt_s=0.0012)
    a250 = rc.analyze_rc(elrs, fs, 2442.0)
    check("ELRS 250 CSS id", a250["id"] == "elrs", str(a250))
    check("ELRS 250 css", a250["css"] is True, str(a250))

    mlrs = rc.synth_rc_train(fs, 31.0, int(fs * 0.14), css=True, pkt_s=0.002)
    a31 = rc.analyze_rc(mlrs, fs, 2442.0)
    check("mLRS 31 CSS id", a31["id"] == "mlrs", str(a31))

    dual = rc.synth_rc_train(fs, 50.0, int(fs * 0.12), css=True, pkt_s=0.002)
    a50 = rc.analyze_rc(dual, fs, 2442.0)
    check("50 Гц CSS dual", a50["id"] == "elrs-mlrs-50", str(a50))

    flrc = rc.synth_rc_train(fs, 1000.0, int(fs * 0.06), css=False, pkt_s=0.0004)
    a1k = rc.analyze_rc(flrc, fs, 2442.0)
    check("ELRS FLRC 1000", a1k["id"] == "elrs", str(a1k))

    mflrc = rc.synth_rc_train(fs, 111.0, int(fs * 0.08), css=False, pkt_s=0.0008)
    a111 = rc.analyze_rc(mflrc, fs, 2442.0)
    check("mLRS FLRC 111", a111["id"] == "mlrs", str(a111))

    cls19 = rc.classify_rc(19.0, True, "s24")
    check("19 Гц таблица = mLRS", cls19["id"] == "mlrs", str(cls19))
    cls500 = rc.classify_rc(500.0, True, "s24")
    check("500 Гц таблица = ELRS", cls500["id"] == "elrs", str(cls500))

    return fail


if __name__ == "__main__":
    n = main()
    print(f"{'FAIL' if n else 'PASS'} layer3 {n}")
    raise SystemExit(1 if n else 0)
