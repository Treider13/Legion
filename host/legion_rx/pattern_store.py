"""PatternStore — память FHSS-паттернов с уникальными ID (патент [G5]).

Запись: {pattern_id, sub_corridor_id, hop_sequence[F(1)…F(n)], cycle_length,
confirmed, confidence, sequence_type, jammed_count}. Паттерны НЕ удаляются —
только статусы pending/confirmed/legacy (запрещено ТЗ).

find_match — выравнивание живой последовательности по циклу паттерна с
допуском ±1 канал (краевое расщепление решётки PFB). min_match адаптивен:
не больше длины канонического цикла (сетка 2 не требует 8 совпадений).
"""
from __future__ import annotations

import time
import uuid

# Типы последовательности (шаг 10 ТЗ)
SEQ_PSEUDO = "pseudo_random"
SEQ_TABLE = "table_based"
SEQ_AFH = "adaptive_afh"


class PatternStore:
    def __init__(self, n_chans: "int | None" = None):
        self.patterns: dict[str, dict] = {}
        # Число каналов решётки PFB — для допуска ±1 по кругу в _align_score.
        # None → выводится из данных (max+1). При адаптивной сетке
        # (chans_for_corridor) FSM обновляет это поле.
        self.n_chans = n_chans

    # ---- CRUD ----

    def add_pattern(self, sub_corridor: dict, hops: list,
                    dedupe_score: float = 0.9) -> str:
        """Новый паттерн из записи HopRecorder (порог — период + ≥2 цикла,
        не фиксированные 16). Дубликат в том же sub (match ≥ dedupe_score)
        — обновляем существующий, ID сохраняем."""
        seq = [int(h["channel_idx"]) for h in hops]
        freqs = [float(h["freq_mhz"]) for h in hops]
        if len(seq) < 2:
            raise ValueError(f"add_pattern: {len(seq)} < 2 скачков")
        sub_id = sub_corridor["sub_corridor_id"]
        for pid, rec in self.patterns.items():
            if rec["sub_corridor_id"] != sub_id:
                continue
            score, _pos = _align_score(seq, rec["cycle"], m=self.n_chans)
            if score >= dedupe_score:
                per = find_period_tolerant(seq, m=self.n_chans)
                rec["hop_sequence"] = seq
                rec["freqs_mhz"] = freqs
                rec["updated"] = time.time()
                rec["cycle_length"] = per[0] if per else len(seq)
                rec["cycle"] = seq[: rec["cycle_length"]]
                rec["sequence_type"] = classify_sequence_type(
                    seq, m=self.n_chans)
                return pid
        pid = f"fhss-{uuid.uuid4().hex[:10]}"  # уникальный ID [G5]
        per = find_period_tolerant(seq, m=self.n_chans)
        cyc_len = per[0] if per else len(seq)
        dwells = [float(h["dwell_us"]) for h in hops if h.get("dwell_us")]
        self.patterns[pid] = {
            "pattern_id": pid,
            "sub_corridor_id": sub_id,
            "parent_corridor_id": sub_corridor.get("parent_corridor_id"),
            "sub": dict(sub_corridor),
            "hop_sequence": seq,
            "freqs_mhz": freqs,
            "cycle_length": cyc_len,
            "cycle": seq[:cyc_len],  # канонический цикл для align/predict
            "dwell_s": (sorted(dwells)[len(dwells) // 2] / 1e6
                        if dwells else 1e-3),
            "confirmed": False,
            "confirm_count": 0,
            "confidence": 0.0,
            "sequence_type": classify_sequence_type(seq, m=self.n_chans),
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
            score, pos = _align_score(live, rec["cycle"], m=self.n_chans)
            n_cyc = max(1, len(rec["cycle"]))
            n_cmp = min(len(live), 256)
            matched = int(round(score * n_cmp))
            # Сетка 2..7: нельзя требовать 8 совпадений в цикле короче 8.
            need = max(1, min(int(min_match), n_cyc))
            if matched >= need and (best is None or score > best[2]):
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
        per = find_period_tolerant(seq, m=self.n_chans)
        rec["hop_sequence"] = seq
        rec["freqs_mhz"] = [float(h["freq_mhz"]) for h in new_hops]
        rec["cycle_length"] = per[0] if per else len(seq)
        rec["cycle"] = seq[: rec["cycle_length"]]
        rec["sequence_type"] = classify_sequence_type(seq, m=self.n_chans)
        dwells = [float(h["dwell_us"]) for h in new_hops if h.get("dwell_us")]
        if dwells:
            rec["dwell_s"] = sorted(dwells)[len(dwells) // 2] / 1e6
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

def find_period_tolerant(seq: list, tol: int = 1, m: "int | None" = None,
                         min_score: float = 0.85,
                         max_cycle: int = 4096) -> "tuple | None":
    """Период ЛЮБОЙ длины 2..max_cycle (4096), с допуском ±tol каналов
    (джиттер/краевое расщепление) и усечённым хвостом. p=1 исключён:
    при tol=1 последовательная таблица 0,1,2,… даёт ложный период 1.
    Критерий: доля совпадений seq[i]≈seq[i+p] ≥ min_score при
    ≥ max(4, min(p,8)) сравнениях. None — период не найден (AFH).
    m — число каналов решётки (для кругового допуска); None → max+1."""
    import numpy as np

    n = len(seq)
    if n < 4:
        return None
    a = np.asarray(seq, dtype=np.int64)
    mm = int(m) if m else int(a.max()) + 1
    hi = min(n - 1, int(max_cycle))
    for p in range(2, hi + 1):
        d = (a[:-p] - a[p:]) % mm
        ok = np.minimum(d, mm - d) <= tol
        if ok.size < max(4, min(p, 8)):
            continue
        score = float(ok.mean())
        if score >= min_score:
            return (p, score)
    return None


def _align_score(a: list, b_cycle: list, m: "int | None" = None) -> tuple:
    """Лучшее циклическое выравнивание a по b_cycle, допуск ±1 канал
    ПО КРУГУ m (число каналов решётки — параметр, не константа [W1]).
    Векторизовано: цикл 4096 × окно 256 ≈ 1 мс. Возвращает (score,
    position последнего элемента a в цикле)."""
    import numpy as np

    if not a or not b_cycle:
        return (0.0, 0)
    aa = np.asarray(a, dtype=np.int64)
    bb = np.asarray(b_cycle, dtype=np.int64)
    mm = int(m) if m else int(max(aa.max(), bb.max())) + 1
    m_len = bb.size
    # Все живые скачки против ПОВТОРЯЮЩЕГОСЯ цикла (сетка 2: окно 8
    # даёт 8 сравнений, не 2). Потолок 256 — realtime, не длина сетки.
    n_cmp = min(aa.size, 256)
    aa = aa[-n_cmp:]
    idx = np.arange(n_cmp)
    best_score, best_pos = 0.0, 0
    for off in range(m_len):
        pred = bb[(idx + off) % m_len]
        d = (aa - pred) % mm
        ok = float((np.minimum(d, mm - d) <= 1).mean())
        if ok > best_score:
            best_score = ok
            best_pos = (off + n_cmp - 1) % m_len
    return (best_score, best_pos)


def classify_sequence_type(seq: list, m: "int | None" = None) -> str:
    """Тип FHSS-последовательности (эвристика [G2], честно задокументирована):
      table_based   — чистый период с уникальными каналами (перестановка);
      pseudo_random — период с повторами ИЛИ нет периода, узкий охват;
      adaptive_afh  — периода нет, широкий равномерный охват (AFH-подобно)."""
    if not seq:
        return SEQ_PSEUDO
    per = find_period_tolerant(seq, m=m)
    cyc = per[0] if per else len(seq)
    uniq = len(set(seq))
    if cyc < len(seq) and uniq == cyc:
        return SEQ_TABLE
    span = max(seq) - min(seq) + 1
    coverage = uniq / max(1, span)
    if per is None and coverage > 0.5 and uniq >= 0.6 * len(seq):
        return SEQ_AFH
    return SEQ_PSEUDO
