#!/usr/bin/env python3
"""Layer 3 + ELRS/mLRS + turbo: живые круглые пути, не заглушки."""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import numpy as np

import droneid as dji
import fhss_detect as fh
import lte_turbo as tb
import opendroneid as od
import protocol_db as pdb
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
    check("ZC root 600", got61.get("zcRoot") == 600, str(got61.get("zcRoot")))

    t61 = np.arange(x61.size, dtype=np.float64) / 61.44e6
    xoff = (x61 * np.exp(1j * 2.0 * np.pi * 2.0e6 * t61)).astype(np.complex64)
    got_off = dji.analyze_droneid(xoff, 61.44e6, 2442.0, 2440.0)
    check("DC +2 МГц plaintext", got_off.get("ok") is True, str(got_off.get("reason")))

    pad = np.zeros(int(dji.DRONEID_FS * 0.02), dtype=np.complex64)
    buried = np.concatenate([pad, burst])
    got_b = dji.analyze_droneid(buried, dji.DRONEID_FS)
    check("вспышка не в начале окна", got_b.get("ok") is True, str(got_b.get("reason")))

    bad24, fs24 = dji.prepare_droneid_iq(np.ones(4096, dtype=np.complex64), 24e6)
    check("24 MSPS не DroneID fs", bad24.size == 0 and fs24 == 0.0)

    long_cp, short_cp = dji.cyclic_prefix_lengths(dji.DRONEID_FS)
    nfft = dji.fft_size(dji.DRONEID_FS)
    start147 = long_cp + nfft + 4 * (short_cp + nfft)
    tail147 = burst[start147:]
    hits147 = dji.find_zc(tail147, dji.DRONEID_FS)
    check("обрезанный кадр → root 147", bool(hits147) and hits147[0]["root"] == 147, str(hits147[:1]))

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
    check("250 CSS dual ELRS/Ghost Pure Race", a250["id"] == "elrs-ghost-250", str(a250))
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
    check("111 Гц без CSS dual mLRS/FrSky", a111["id"] == "mlrs-frsky-111", str(a111))

    a250f = rc.analyze_rc(rc.synth_rc_train(fs, 250.0, int(fs * 0.08), css=False, pkt_s=0.0005), fs, 2442.0)
    check("250 Гц без CSS dual ELRS/Tracer", a250f["id"] == "elrs-tracer-250", str(a250f))

    cls19 = rc.classify_rc(19.0, True, "s24")
    check("19 Гц таблица = mLRS", cls19["id"] == "mlrs", str(cls19))
    cls500 = rc.classify_rc(500.0, True, "s24")
    check("500 Гц CSS = ELRS", cls500["id"] == "elrs", str(cls500))
    cls333f = rc.classify_rc(333.0, False, "s24")
    check("333 Гц без CSS не FLRC", cls333f["id"] == "rc-unknown", str(cls333f))
    cls15 = rc.classify_rc(15.0, True, "s24")
    check("15 Гц CSS = Ghost", cls15["id"] == "ghost", str(cls15))
    cls160 = rc.classify_rc(160.0, True, "s24")
    check("160 Гц CSS dual ELRS/Ghost Race", cls160["id"] == "elrs-ghost-150", str(cls160))
    cls55 = rc.classify_rc(55.0, True, "s24")
    check("55 Гц CSS dual не Ghost-имя", cls55["id"] == "elrs-mlrs-50", str(cls55))
    cls500f = rc.classify_rc(500.0, False, "s24")
    check("500 Гц без CSS dual ELRS/Ghost", cls500f["id"] == "elrs-ghost-500", str(cls500f))
    cls_cf = rc.classify_rc(150.0, False, "p900", 0.26)
    check("150 Гц + 260 кГц = Crossfire", cls_cf["id"] == "crossfire", str(cls_cf))
    cls_150 = rc.classify_rc(150.0, False, "p900", 0.0)
    check("150 Гц 900 без шага не ELRS", cls_150["id"] == "crossfire-or-fsk-150", str(cls_150))
    cls150css900 = rc.classify_rc(150.0, True, "p900")
    check("150 Гц CSS на 900 не ELRS", cls150css900["id"] == "rc-unknown", str(cls150css900))
    cls25 = rc.classify_rc(25.0, True, "p900")
    check("25 Гц CSS 900 = ELRS", cls25["id"] == "elrs", str(cls25))
    cls433 = rc.classify_rc(100.0, True, "uhf", 0.0, 433.4)
    check("100 Гц CSS 433 = ELRS", cls433["id"] == "elrs", str(cls433))

    r5 = pdb.nearest_analog_channel(5806.0)
    check("канал R5", r5 is not None and r5["id"] == "R5", str(r5))
    a4 = pdb.nearest_analog_channel(5805.0)
    check("канал A4 ближе 5805 чем R5", a4 is not None and a4["id"] == "A4", str(a4))
    miss = pdb.nearest_analog_channel(2442.0)
    check("2.4 не analog-канал", miss is None)

    xf = pdb.classify_fhss_domain(0.26, 915.0)
    check("шаг 260 кГц = Crossfire", xf["family"] == "crossfire" and xf["unique"] is True, str(xf))
    ov = pdb.classify_fhss_domain(1.0, 2442.0)
    check("шаг 1 МГц 2.4 не уникален", ov["unique"] is False, str(ov))
    ov6 = pdb.classify_fhss_domain(0.6, 915.0)
    check("шаг 0.6 900 не уникален", ov6["unique"] is False, str(ov6))

    fs_h = 8.0e6
    hops = [902.165 + i * 0.260 for i in range(8)]
    lo_h = 903.2  # hop-set внутри Найквиста 4 МГц, не алиас 915−902
    xh = fh.synth_fhss(fs_h, lo_h, hops, 0.004)
    ah = fh.analyze_fhss(xh, fs_h, lo_h)
    check("FHSS hit", ah.get("hit") is True, str(ah))
    check("FHSS ≥5 hop", int(ah.get("unique") or 0) >= 5, str(ah.get("unique")))
    check(
        "FHSS шаг ~260 кГц",
        abs(float(ah.get("spacingMhz") or 0) - 0.26) < 0.06,
        str(ah.get("spacingMhz")),
    )
    check(
        "FHSS домен Crossfire",
        (ah.get("domain") or {}).get("family") == "crossfire",
        str(ah.get("domain")),
    )

    hops24 = [2440.0 + i * 1.0 for i in range(6)]
    x24 = fh.synth_fhss(fs_h, 2442.5, hops24, 0.003)
    a24 = fh.analyze_fhss(x24, fs_h, 2442.5)
    check("FHSS 2.4 hit", a24.get("hit") is True, str(a24))
    check(
        "FHSS 1 МГц не уникален",
        (a24.get("domain") or {}).get("unique") is False,
        str(a24.get("domain")),
    )

    tone = rc.synth_rc_train(fs, 250.0, int(fs * 0.04), css=True, pkt_s=0.001)
    sticky = fh.analyze_fhss(tone, fs, 2442.0)
    check("один канал не FHSS", sticky.get("hit") is False, str(sticky))

    cat = pdb.catalog()
    check("каталог не пуст", len(cat) >= 12, str(len(cat)))
    ids = {r["id"] for r in cat}
    check("каталог DroneID+ODID+Crossfire", {"droneid", "opendroneid", "crossfire"} <= ids, str(ids))
    check(
        "каталог IN866+US433W+70cm",
        {"elrs-in866", "elrs-us433w", "mlrs-70cm", "mlrs-in866"} <= ids,
        str(ids),
    )
    in866 = pdb.classify_fhss_domain(0.525, 866.0)
    check("шаг 0.525 на 866 не уникален", in866["unique"] is False, str(in866))
    check(
        "mode_delta 0.525 не 0.50",
        abs(fh._mode_delta([863.275 + i * 0.525 for i in range(8)]) - 0.525) < 1e-9,
        str(fh._mode_delta([863.275 + i * 0.525 for i in range(8)])),
    )
    hops868 = [863.275 + i * 0.525 for i in range(8)]
    x868 = fh.synth_fhss(8.0e6, 865.0, hops868, 0.004)
    a868 = fh.analyze_fhss(x868, 8.0e6, 865.0)
    check("FHSS 0.525 hit", a868.get("hit") is True, str(a868))
    check(
        "FHSS шаг 0.525 живой",
        abs(float(a868.get("spacingMhz") or 0) - 0.525) < 0.04,
        str(a868.get("spacingMhz")),
    )
    usw = next(d for d in pdb.FHSS_DOMAINS if d["id"] == "elrs-us433w")
    check("US433W 20 каналов", usw["n"] == 20 and abs(usw["spacing"] - (438.0 - 423.5) / 19) < 1e-9)

    return fail


if __name__ == "__main__":
    n = main()
    print(f"{'FAIL' if n else 'PASS'} layer3 {n}")
    raise SystemExit(1 if n else 0)
