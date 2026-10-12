"""PatternStore — память FHSS-паттернов с уникальными ID (патент [G5]).

Запись: {pattern_id, sub_corridor_id, hop_sequence[F(1)…F(n)], cycle_length,
confirmed, confidence, sequence_type, jammed_count}. Паттерны НЕ удаляются —
только статусы pending/confirmed/legacy (запрещено ТЗ).

find_match — выравнивание живой последовательности по циклу паттерна с
допуском ±1 канал (краевое расщепление решётки PFB), min_match=8 скачков.
"""
from __future__ import annotations

import time
import uuid

# Типы последовательности (шаг 10 ТЗ)
SEQ_PSEUDO = "pseudo_random"
SEQ_TABLE = "table_based"
SEQ_AFH = "adaptive_afh"


class PatternStore:
    def __init__(self):
        self.patterns: dict[str, dict] = {}

    # ---- CRUD ----

    def add_pattern(self, sub_corridor: dict, hops: list,
                    dedupe_score: float = 0.9) -> str:
        """Новый паттерн из ≥16 скачков (HopRecorder). Дубликат в том же
        sub (match ≥ dedupe_score) — обновляем существующий, ID сохраняем."""
        seq = [int(h["channel_idx"]) for h in hops]
        freqs = [float(h["freq_mhz"]) for h in hops]
        if len(seq) < 16:
            raise ValueError(f"add_pattern: {len(seq)} < 16 скачков")
        sub_id = sub_corridor["sub_corridor_id"]
        for pid, rec in self.patterns.items():
            if rec["sub_corridor_id"] != sub_id:
                continue
            score, _pos = _align_score(seq, rec["cycle"])
            if score >= dedupe_score:
                rec["hop_sequence"] = seq
                rec["freqs_mhz"] = freqs
                rec["updated"] = time.time()
                rec["cycle_length"] = _find_period(seq)
                rec["cycle"] = seq[: rec["cycle_length"]]
                rec["sequence_type"] = classify_sequence_type(seq)
                return pid
        pid = f"fhss-{uuid.uuid4().hex[:10]}"  # уникальный ID [G5]
        cyc_len = _find_period(seq)
        self.patterns[pid] = {
            "pattern_id": pid,
            "sub_corridor_id": sub_id,
            "parent_corridor_id": sub_corridor.get("parent_corridor_id"),
            "sub": dict(sub_corridor),
            "hop_sequence": seq,
            "freqs_mhz": freqs,
            "cycle_length": cyc_len,
            "cycle": seq[:cyc_len],  # канонический цикл для align/predict
            "confirmed": False,
            "confirm_count": 0,
            "confidence": 0.0,
            "sequence_type": classify_sequence_type(seq),
            "jammed_count": 0,
            "status": "pending",     # pending → confirmed; legacy — архив
            "legacy": [],
            "created": time.time(),
            "updated": time.time(),
        }
        return pid

    def get(self, pattern_id: str) -> dict:
        return self.patterns[pattern_id]

    def find_match(self, live_hops, sub_corridor_id: str,
                   min_match: int = 8) -> "tuple | None":
        """live_hops (каналы) против паттернов ЭТОГО sub-corridor.
        Другой sub → None (изоляция контуров, запрещено ТЗ).
        Возвращает (pattern_id, position, confidence): position — индекс
        ПОСЛЕДНЕГО живого скачка в цикле паттерна; next = position+1."""
        live = [int(h) for h in live_hops]
        best = None
        for pid, rec in self.patterns.items():
            if rec["sub_corridor_id"] != sub_corridor_id:
                continue
            score, pos = _align_score(live, rec["cycle"])
            matched = int(round(score * min(len(live), len(rec["cycle"]))))
            if matched >= min_match and (best is None or score > best[2]):
                best = (pid, pos, score)
        return best

    def mark_confirmed(self, pattern_id: str) -> int:
        """M += 1; confirmed при M >= 3 (фаза 2 ТЗ). Возвращает M."""
        rec = self.patterns[pattern_id]
        rec["confirm_count"] += 1
        if rec["confirm_count"] >= 3:
            rec["confirmed"] = True
            rec["status"] = "confirmed"
        rec["updated"] = time.time()
        return rec["confirm_count"]

    def mark_jammed(self, pattern_id: str) -> int:
        rec = self.patterns[pattern_id]
        rec["jammed_count"] += 1
        return rec["jammed_count"]

    def update_pattern(self, pattern_id: str, new_hops: list) -> None:
        """Сбой/дрейф: старая последовательность — в legacy (НЕ удаляем),
        паттерн возвращается в pending на пере-подтверждение."""
        rec = self.patterns[pattern_id]
        rec["legacy"].append({
            "hop_sequence": list(rec["hop_sequence"]),
            "retired": time.time(),
        })
        seq = [int(h["channel_idx"]) for h in new_hops]
        rec["hop_sequence"] = seq
        rec["freqs_mhz"] = [float(h["freq_mhz"]) for h in new_hops]
        rec["cycle_length"] = _find_period(seq)
        rec["cycle"] = seq[: rec["cycle_length"]]
        rec["sequence_type"] = classify_sequence_type(seq)
        rec["confirmed"] = False
        rec["confirm_count"] = 0
        rec["status"] = "pending"
        rec["updated"] = time.time()

    def classify_threat_type(self, pattern_id: str) -> dict:
        rec = self.patterns[pattern_id]
        return {"pattern_id": pattern_id,
                "sequence_type": rec["sequence_type"],
                "cycle_length": rec["cycle_length"],
                "sub_corridor_id": rec["sub_corridor_id"],
                "confirmed": rec["confirmed"],
                "jammed_count": rec["jammed_count"]}


# ---- анализ ----

def _find_period(seq: list) -> int:
    """Наименьший период p: seq[i] == seq[i+p] для всех i < n−p.
    Допускает усечённый хвост (запись 16–23 скачка цикла 12: p=12 > n/2 —
    прежняя капсула n/2 такой цикл не видела, баг подтверждения)."""
    n = len(seq)
    for p in range(1, n):
        if all(seq[i] == seq[i + p] for i in range(n - p)):
            return p
    return n


def _align_score(a: list, b_cycle: list) -> tuple:
    """Лучшее циклическое выравнивание a по b_cycle, допуск ±1 канал.
    Возвращает (score, position последнего элемента a в цикле)."""
    if not a or not b_cycle:
        return (0.0, 0)
    m = len(b_cycle)
    n_cmp = min(len(a), m)
    best_score, best_pos = 0.0, 0
    for off in range(m):
        ok = 0
        for i in range(n_cmp):
            j = (off + i) % m
            d = (a[i] - b_cycle[j]) % 64
            if min(d, 64 - d) <= 1:
                ok += 1
        score = ok / n_cmp
        if score > best_score:
            best_score = score
            best_pos = (off + n_cmp - 1) % m
    return (best_score, best_pos)


def classify_sequence_type(seq: list) -> str:
    """Тип FHSS-последовательности (эвристика [G2], честно задокументирована):
      table_based   — чистый период с уникальными каналами (перестановка);
      pseudo_random — период с повторами ИЛИ нет периода, узкий охват;
      adaptive_afh  — периода нет, широкий равномерный охват (AFH-подобно)."""
    if not seq:
        return SEQ_PSEUDO
    cyc = _find_period(seq)
    uniq = len(set(seq))
    if cyc < len(seq) and uniq == cyc:
        return SEQ_TABLE
    span = max(seq) - min(seq) + 1
    coverage = uniq / max(1, span)
    if cyc == len(seq) and coverage > 0.5 and uniq >= 0.6 * len(seq):
        return SEQ_AFH
    return SEQ_PSEUDO
