#!/usr/bin/env python3
"""OpenDroneID / ASTM F3411-22a + ASD-STAN prEN 4709-002.

Порт упаковки opendroneid/opendroneid-core-c (Intel, Apache-2.0):
  25-байт сообщения, Message Pack, Wi-Fi Beacon IE 221 (OUI FA:0B:BC type 0x0D),
  DJI vendor OUI 26:37:12, BLE UUID 0xFFFA + app 0x0D.

xA4 / bladeRF не демодулирует 802.11 PHY — только разбор уже снятых кадров
(монитор, BLE advertisement, pcap, хост). Не выдумываем Wi-Fi demod.
"""
from __future__ import annotations

import struct
from typing import Any

ODID_MESSAGE_SIZE = 25
ODID_ID_SIZE = 20
ODID_STR_SIZE = 23
ODID_PACK_MAX = 9
LATLON_MULT = 10_000_000
ALT_DIV = 0.5
ALT_ADDER = 1000
SPEED_DIV = (0.25, 0.75)
VSPEED_DIV = 0.5
INV_DIR = 361.0
INV_SPEED_H = 255.0
INV_SPEED_V = 63.0
INV_ALT = -1000.0
INV_TS = 0xFFFF

ASTM_OUI = bytes((0xFA, 0x0B, 0xBC))
DJI_RID_OUI = bytes((0x26, 0x37, 0x12))
ASTM_OUI_TYPE = 0x0D
BLE_UUID = 0xFFFA

MSG_NAMES = {
    0x0: "basic_id",
    0x1: "location",
    0x2: "auth",
    0x3: "self_id",
    0x4: "system",
    0x5: "operator_id",
    0xF: "pack",
}
ID_TYPES = {0: "none", 1: "serial", 2: "caa", 3: "utm_uuid", 4: "session"}
UA_TYPES = {
    0: "none",
    1: "aeroplane",
    2: "multirotor",
    3: "gyroplane",
    4: "hybrid",
    5: "ornithopter",
    6: "glider",
    7: "kite",
    8: "free_balloon",
    9: "captive_balloon",
    10: "airship",
    11: "parachute",
    12: "rocket",
    13: "tethered",
    14: "obstacle",
    15: "other",
}
STATUS = {0: "undeclared", 1: "ground", 2: "airborne", 3: "emergency", 4: "rid_failure"}


def _i16(b: bytes, o: int) -> int:
    return struct.unpack_from("<h", b, o)[0]


def _u16(b: bytes, o: int) -> int:
    return struct.unpack_from("<H", b, o)[0]


def _i32(b: bytes, o: int) -> int:
    return struct.unpack_from("<i", b, o)[0]


def _u32(b: bytes, o: int) -> int:
    return struct.unpack_from("<I", b, o)[0]


def _ascii(raw: bytes) -> str:
    return raw.split(b"\x00", 1)[0].decode("utf-8", errors="replace").strip()


def decode_latlon(v: int) -> float:
    return float(v) / LATLON_MULT


def decode_alt(v: int) -> float:
    return float(v) * ALT_DIV - ALT_ADDER


def decode_direction(raw: int, ew: int) -> float:
    d = float(raw) + (180.0 if ew else 0.0)
    if raw == 0 and ew == 0:
        return 0.0
    return d


def decode_speed_h(raw: int, mult: int) -> float:
    if not mult:
        return float(raw) * SPEED_DIV[0]
    return 255.0 * SPEED_DIV[0] + float(raw) * SPEED_DIV[1]


def decode_speed_v(raw: int) -> float:
    if raw > 127:
        raw -= 256
    return float(raw) * VSPEED_DIV


def decode_ts(raw: int) -> float:
    if raw == INV_TS:
        return float(INV_TS)
    return float(raw) / 10.0


def encode_latlon(deg: float) -> int:
    return int(round(deg * LATLON_MULT))


def encode_alt(meters: float) -> int:
    return max(0, min(0xFFFF, int(round((meters + ALT_ADDER) / ALT_DIV))))


def encode_basic_id(
    uas_id: str,
    id_type: int = 1,
    ua_type: int = 2,
    proto: int = 2,
) -> bytes:
    uid = uas_id.encode("ascii", errors="ignore")[:ODID_ID_SIZE].ljust(ODID_ID_SIZE, b"\x00")
    return bytes(((0 << 4) | (proto & 0xF), ((id_type & 0xF) << 4) | (ua_type & 0xF))) + uid + bytes(3)


def encode_location(
    lat: float,
    lon: float,
    alt_geo: float = 120.0,
    height: float = 40.0,
    status: int = 2,
    proto: int = 2,
    direction: float = 90.0,
    speed_h: float = 5.0,
    speed_v: float = 0.0,
) -> bytes:
    ew = 1 if direction >= 180 else 0
    direc = int(round(direction - (180 if ew else 0))) % 180
    if speed_h <= 255 * SPEED_DIV[0]:
        mult = 0
        sh = int(round(speed_h / SPEED_DIV[0]))
    else:
        mult = 1
        sh = int(round((speed_h - 255 * SPEED_DIV[0]) / SPEED_DIV[1]))
    sh = max(0, min(255, sh))
    sv = max(-128, min(127, int(round(speed_v / VSPEED_DIV))))
    b1 = (mult & 1) | ((ew & 1) << 1) | (0 << 2) | ((status & 0xF) << 4)
    body = struct.pack(
        "<BBbiiHHH",
        direc,
        sh,
        sv,
        encode_latlon(lat),
        encode_latlon(lon),
        encode_alt(alt_geo),
        encode_alt(alt_geo),
        encode_alt(height),
    )
    return bytes(((1 << 4) | (proto & 0xF), b1)) + body + bytes((0xA9, 0x22, 0, 0, 0, 0))


def encode_system(lat: float, lon: float, proto: int = 2) -> bytes:
    b1 = 1  # live GNSS, undeclared class
    body = struct.pack("<iiHBHH", encode_latlon(lat), encode_latlon(lon), 1, 0, encode_alt(-1000), encode_alt(-1000))
    return bytes(((4 << 4) | (proto & 0xF), b1)) + body + bytes(8)


def encode_operator_id(op_id: str, proto: int = 2) -> bytes:
    oid = op_id.encode("ascii", errors="ignore")[:ODID_ID_SIZE].ljust(ODID_ID_SIZE, b"\x00")
    return bytes(((5 << 4) | (proto & 0xF), 0)) + oid + bytes(3)


def encode_self_id(text: str, proto: int = 2) -> bytes:
    desc = text.encode("utf-8", errors="ignore")[:ODID_STR_SIZE].ljust(ODID_STR_SIZE, b"\x00")
    return bytes(((3 << 4) | (proto & 0xF), 0)) + desc


def encode_message_pack(messages: list[bytes], proto: int = 2) -> bytes:
    msgs = [m[:ODID_MESSAGE_SIZE].ljust(ODID_MESSAGE_SIZE, b"\x00") for m in messages[:ODID_PACK_MAX]]
    head = bytes(((0xF << 4) | (proto & 0xF), ODID_MESSAGE_SIZE, len(msgs)))
    return head + b"".join(msgs)


def encode_wifi_beacon_ie(payload: bytes, counter: int = 1, oui: bytes = ASTM_OUI) -> bytes:
    info = bytes(oui[:3]) + bytes((ASTM_OUI_TYPE, counter & 0xFF)) + payload
    return bytes((221, len(info))) + info


def encode_ble_ad(message: bytes, counter: int = 1) -> bytes:
    msg = message[:ODID_MESSAGE_SIZE].ljust(ODID_MESSAGE_SIZE, b"\x00")
    inner = struct.pack("<HB", BLE_UUID, ASTM_OUI_TYPE) + bytes((counter & 0xFF,)) + msg
    return bytes((len(inner) + 1, 0x16)) + inner


def decode_basic_id(msg: bytes) -> dict[str, Any] | None:
    if len(msg) < ODID_MESSAGE_SIZE or (msg[0] >> 4) != 0:
        return None
    id_type = (msg[1] >> 4) & 0xF
    ua_type = msg[1] & 0xF
    uas_id = _ascii(msg[2:22])
    if id_type == 0 or not uas_id:
        return None
    return {
        "type": "basic_id",
        "proto": msg[0] & 0xF,
        "idType": ID_TYPES.get(id_type, str(id_type)),
        "idTypeN": id_type,
        "uaType": UA_TYPES.get(ua_type, str(ua_type)),
        "uaTypeN": ua_type,
        "uasId": uas_id,
    }


def decode_location(msg: bytes) -> dict[str, Any] | None:
    if len(msg) < ODID_MESSAGE_SIZE or (msg[0] >> 4) != 1:
        return None
    b1 = msg[1]
    mult = b1 & 1
    ew = (b1 >> 1) & 1
    height_type = (b1 >> 2) & 1
    status = (b1 >> 4) & 0xF
    lat = decode_latlon(_i32(msg, 5))
    lon = decode_latlon(_i32(msg, 9))
    if abs(lat) > 90 or abs(lon) > 180:
        return None
    ts = _u16(msg, 21)
    return {
        "type": "location",
        "proto": msg[0] & 0xF,
        "status": STATUS.get(status, str(status)),
        "statusN": status,
        "direction": decode_direction(msg[2], ew),
        "speedH": decode_speed_h(msg[3], mult),
        "speedV": decode_speed_v(msg[4] if msg[4] < 128 else msg[4] - 256),
        "latitude": lat,
        "longitude": lon,
        "altBaro": decode_alt(_u16(msg, 13)),
        "altGeo": decode_alt(_u16(msg, 15)),
        "height": decode_alt(_u16(msg, 17)),
        "heightType": "agl" if height_type else "takeoff",
        "horizAcc": msg[19] & 0xF,
        "vertAcc": (msg[19] >> 4) & 0xF,
        "timestamp": decode_ts(ts),
    }


def decode_auth(msg: bytes) -> dict[str, Any] | None:
    if len(msg) < ODID_MESSAGE_SIZE or (msg[0] >> 4) != 2:
        return None
    page = msg[1] & 0xF
    auth_type = (msg[1] >> 4) & 0xF
    out: dict[str, Any] = {
        "type": "auth",
        "proto": msg[0] & 0xF,
        "authType": auth_type,
        "page": page,
    }
    if page == 0:
        out["lastPage"] = msg[2]
        out["length"] = msg[3]
        out["timestamp"] = _u32(msg, 4)
        out["dataHex"] = msg[8:25].hex()
    else:
        out["dataHex"] = msg[2:25].hex()
    return out


def decode_self_id(msg: bytes) -> dict[str, Any] | None:
    if len(msg) < ODID_MESSAGE_SIZE or (msg[0] >> 4) != 3:
        return None
    return {
        "type": "self_id",
        "proto": msg[0] & 0xF,
        "descType": msg[1],
        "text": _ascii(msg[2:25]),
    }


def decode_system(msg: bytes) -> dict[str, Any] | None:
    if len(msg) < ODID_MESSAGE_SIZE or (msg[0] >> 4) != 4:
        return None
    b1 = msg[1]
    return {
        "type": "system",
        "proto": msg[0] & 0xF,
        "operatorLocType": b1 & 0x3,
        "classType": (b1 >> 2) & 0x7,
        "operatorLatitude": decode_latlon(_i32(msg, 2)),
        "operatorLongitude": decode_latlon(_i32(msg, 6)),
        "areaCount": _u16(msg, 10),
        "areaRadius": msg[12] * 10,
        "areaCeiling": decode_alt(_u16(msg, 13)),
        "areaFloor": decode_alt(_u16(msg, 15)),
        "classEU": msg[17] & 0xF,
        "categoryEU": (msg[17] >> 4) & 0xF,
        "operatorAltGeo": decode_alt(_u16(msg, 18)),
        "timestamp": _u32(msg, 20),
    }


def decode_operator_id(msg: bytes) -> dict[str, Any] | None:
    if len(msg) < ODID_MESSAGE_SIZE or (msg[0] >> 4) != 5:
        return None
    return {
        "type": "operator_id",
        "proto": msg[0] & 0xF,
        "operatorIdType": msg[1],
        "operatorId": _ascii(msg[2:22]),
    }


def decode_message(msg: bytes) -> dict[str, Any] | None:
    if len(msg) < 1:
        return None
    if len(msg) < ODID_MESSAGE_SIZE:
        return None
    kind = (msg[0] >> 4) & 0xF
    if kind == 0:
        return decode_basic_id(msg)
    if kind == 1:
        return decode_location(msg)
    if kind == 2:
        return decode_auth(msg)
    if kind == 3:
        return decode_self_id(msg)
    if kind == 4:
        return decode_system(msg)
    if kind == 5:
        return decode_operator_id(msg)
    if kind == 0xF:
        return None
    return None


def decode_pack(buf: bytes) -> list[dict[str, Any]]:
    if len(buf) < 3 or (buf[0] >> 4) != 0xF:
        return []
    size = buf[1]
    n = buf[2]
    if size != ODID_MESSAGE_SIZE or n < 1 or n > ODID_PACK_MAX:
        return []
    out: list[dict[str, Any]] = []
    off = 3
    for _ in range(n):
        chunk = buf[off : off + ODID_MESSAGE_SIZE]
        off += ODID_MESSAGE_SIZE
        if len(chunk) < ODID_MESSAGE_SIZE:
            break
        row = decode_message(chunk)
        if row:
            out.append(row)
    return out


def _as_bytes(item: Any) -> bytes:
    if isinstance(item, (bytes, bytearray, memoryview)):
        return bytes(item)
    if isinstance(item, str):
        h = "".join(ch for ch in item if ch not in " \n\r\t:")
        try:
            return bytes.fromhex(h)
        except ValueError:
            return item.encode("latin-1", errors="ignore")
    if isinstance(item, list) and item and isinstance(item[0], int):
        return bytes(int(x) & 0xFF for x in item)
    return b""


def extract_ie221(body: bytes) -> list[bytes]:
    """Beacon body после 12 фиксированных байт, либо сырая цепочка IE."""
    found: list[bytes] = []
    for base in (0, 12):
        off = base
        while off + 2 <= len(body):
            tag = body[off]
            ln = body[off + 1]
            end = off + 2 + ln
            if end > len(body):
                break
            info = body[off + 2 : end]
            if tag == 221 and len(info) >= 5:
                oui, typ = info[:3], info[3]
                if (oui == ASTM_OUI and typ == ASTM_OUI_TYPE) or oui == DJI_RID_OUI:
                    found.append(info[4:])
            off = end
        if found:
            return found
    return found


def extract_ble(buf: bytes) -> list[bytes]:
    found: list[bytes] = []
    off = 0
    while off + 2 <= len(buf):
        ln = buf[off]
        if ln < 1 or off + 1 + ln > len(buf):
            break
        ad_type = buf[off + 1]
        data = buf[off + 2 : off + 1 + ln]
        if ad_type == 0x16 and len(data) >= 4:
            uuid = struct.unpack_from("<H", data, 0)[0]
            if uuid == BLE_UUID and data[2] == ASTM_OUI_TYPE:
                found.append(data[3:])
        off += 1 + ln
    return found


def _payload_messages(payload: bytes) -> list[dict[str, Any]]:
    """Счётчик + сообщение / pack, либо голое 25-байт / pack."""
    if not payload:
        return []
    cands = [payload]
    if len(payload) >= ODID_MESSAGE_SIZE + 1:
        cands.append(payload[1:])
    out: list[dict[str, Any]] = []
    for blob in cands:
        if not blob:
            continue
        kind = (blob[0] >> 4) & 0xF
        if kind == 0xF:
            rows = decode_pack(blob)
            if rows:
                return rows
        if len(blob) >= ODID_MESSAGE_SIZE:
            row = decode_message(blob[:ODID_MESSAGE_SIZE])
            if row:
                out.append(row)
                rest = blob[ODID_MESSAGE_SIZE:]
                while len(rest) >= ODID_MESSAGE_SIZE:
                    nxt = decode_message(rest[:ODID_MESSAGE_SIZE])
                    if not nxt:
                        break
                    out.append(nxt)
                    rest = rest[ODID_MESSAGE_SIZE:]
                if out:
                    return out
    return out


def parse_opendroneid(frames: Any) -> dict[str, Any]:
    """Любая смесь hex/bytes/802.11/BLE/IE → plaintext OpenDroneID."""
    items: list[Any]
    if frames is None:
        items = []
    elif isinstance(frames, (bytes, bytearray, str)):
        items = [frames]
    elif isinstance(frames, list):
        items = frames
    else:
        items = [frames]
    messages: list[dict[str, Any]] = []
    for item in items:
        raw = _as_bytes(item)
        if not raw:
            continue
        structured = extract_ie221(raw) + extract_ie221(raw[24:] if len(raw) > 36 else b"") + extract_ble(raw)
        if structured:
            for pay in structured:
                messages.extend(_payload_messages(pay))
            continue
        for blob in [raw, raw[24:] if len(raw) > 36 else b""]:
            if not blob:
                continue
            messages.extend(_payload_messages(blob))
    # дедуп по типу+ключевым полям
    seen: set[str] = set()
    uniq: list[dict[str, Any]] = []
    for m in messages:
        key = f"{m.get('type')}:{m.get('uasId') or m.get('operatorId') or m.get('latitude') or m.get('text')}"
        if key in seen:
            continue
        seen.add(key)
        uniq.append(m)
    uas = _uas_view(uniq)
    return {
        "hit": bool(uniq),
        "ok": bool(uas.get("uasId") or uas.get("latitude") is not None),
        "messages": uniq,
        "uas": uas,
        "reason": None if uniq else "нет OpenDroneID в кадре (нужен IE 221 / BLE 0xFFFA, не IQ 802.11)",
    }


def _uas_view(messages: list[dict[str, Any]]) -> dict[str, Any]:
    uas: dict[str, Any] = {}
    for m in messages:
        t = m.get("type")
        if t == "basic_id" and m.get("uasId"):
            uas["uasId"] = m["uasId"]
            uas["idType"] = m.get("idType")
            uas["uaType"] = m.get("uaType")
        elif t == "location":
            uas["latitude"] = m.get("latitude")
            uas["longitude"] = m.get("longitude")
            uas["altGeo"] = m.get("altGeo")
            uas["height"] = m.get("height")
            uas["status"] = m.get("status")
            uas["speedH"] = m.get("speedH")
        elif t == "operator_id" and m.get("operatorId"):
            uas["operatorId"] = m["operatorId"]
        elif t == "self_id" and m.get("text"):
            uas["selfId"] = m["text"]
        elif t == "system":
            uas["operatorLatitude"] = m.get("operatorLatitude")
            uas["operatorLongitude"] = m.get("operatorLongitude")
    return uas
