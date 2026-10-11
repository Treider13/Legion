"""Hop map (шаг 6): восстановление последовательности скачков по CH_PWR_gpu.

Вход на кадр: вектор CH_PWR_gpu (M,) + время кадра (perf_counter, шаг 4.7).
Доминантный канал = argmax выше адаптивного порога (median + 6·MAD),
иначе None (скачок вне окна приёма — честная «дыра», не выдуманный канал).

Оценка темпа: смены доминанта/сек (скользящее окно) — 1000 Гц ELRS 2.4,
200 Гц ELRS 900, 150/50 Гц Crossfire (шаг 6.2).

Предсказание (шаг 6.3): период последовательности доминантов
(автокорреляция с допуском по None — «дыры» от вне-оконных скачков) →
следующий канал по фазе цикла; fallback — Markov-1 по наблюдённым
переходам. Критерий 6.4: точность > 0.7 на 10 следующих скачков.
"""
from __future__ import annotations

import numpy as np


class HopTracker:
    def __init__(self, n_chans: int, frame_dt_s: float,
                 max_period: int = 96, hist: int = 4096):
        self.m = int(n_chans)
        self.dt = float(frame_dt_s)
        self.max_period = int(max_period)
        self.dom: list = []  # доминантный канал кадра: int | None
        self.t: list[float] = []
        self._hist = int(hist)
        self._dwell_est = 1.0  # последняя оценка dwell (infer_hop_clock)
        self._table_lag: "int | None" = None  # период таблицы FHSS в кадрах
        self._pred_log: list[bool] = []  # попадания предсказания (окно 10)
        self._pending: "int | None" = None  # предсказание на следующий hop
        self._event_pwr: list[float] = []  # мощность принятых onset'ов (≤8)

    @staticmethod
    def _centroid(p: np.ndarray, k: int) -> float:
        """Параболическая суббиновая оценка пика (тон на краю канала делит
        мощность между соседними бинами — argmax «мигает» ±1 от шума)."""
        if 0 < k < len(p) - 1:
            a, b, c = p[k - 1], p[k], p[k + 1]
            denom = a - 2.0 * b + c
            if abs(denom) > 1e-20:
                return float(k) + max(-1.0, min(1.0, 0.5 * (a - c) / denom))
        return float(k)

    # ---- кадр ----

    def update(self, ch_pwr, t_s: float) -> dict:
        p = np.asarray(ch_pwr, dtype=np.float64)
        floor = float(np.median(p))
        mad = float(np.median(np.abs(p - floor))) + 1e-12
        thr = floor + 6.0 * 1.4826 * mad
        k = int(np.argmax(p))
        dom = k if p[k] > thr else None
        # Гистерезис по margin: хвост прошлой пачки vs фронт новой (top-2
        # близки) → держим прошлый канал. Иначе кадр-на-границе пачки
        # подставляет «чужой» канал и рвёт детерминированную таблицу.
        if dom is not None:
            prev = next((d for d in reversed(self.dom) if d is not None), None)
            if (prev is not None and prev != dom and p[prev] > thr
                    and p[dom] < 1.4 * p[prev]):
                dom = prev
        # Амплитудные ворота onset'а: кадр-протечка (часть пачки) несёт
        # долю мощности полного кадра — принимаем смену канала только при
        # мощности ≥ 0.5 медианы последних принятых onset'ов (передатчик
        # FHSS мощность не качает — ворота физичны).
        prev_vis = next((d for d in reversed(self.dom) if d is not None), None)
        if (dom is not None and prev_vis is not None and dom != prev_vis
                and len(self._event_pwr) >= 3):
            med = float(np.median(self._event_pwr[-8:]))
            if p[dom] < 0.5 * med:
                dom = None  # слабый кадр — протечка, а не скачок
        self.dom_frac = self._centroid(p, k) if dom is not None else None
        is_hop = bool(self.dom) and self.dom[-1] != dom
        if is_hop and dom is not None and (
                not self._event_pwr or p[dom] >= 0.5 * float(np.median(self._event_pwr[-8:]))
                or len(self._event_pwr) < 3):
            self._event_pwr.append(float(p[dom]))
            self._event_pwr = self._event_pwr[-8:]
        if is_hop and dom is not None:
            if self._pending is not None:
                self._pred_log.append(self._match_bin(self._pending, dom))
                self._pred_log = self._pred_log[-10:]
            self._pending = None
        self.dom.append(dom)
        self.t.append(float(t_s))
        if len(self.dom) > self._hist:
            self.dom = self.dom[-self._hist:]
            self.t = self.t[-self._hist:]
        return {"dominant": dom, "hop": is_hop, "floor": floor, "thr": thr}

    def _match_bin(self, pred: "int | None", meas: int) -> bool:
        """Попадание с допуском ±1 бин по кругу (суббиновое краевое
        расщепление — квантование решётки PFB, не промах предсказания)."""
        if pred is None:
            return False
        d = (int(pred) - int(meas)) % self.m
        return d in (0, 1, self.m - 1)

    # ---- темп скачков ----

    def hop_rate_hz(self, window_s: float = 0.5) -> float:
        if len(self.t) < 4:
            return 0.0
        t0 = self.t[-1] - window_s
        hops = 0
        prev = None
        for d, tt in zip(self.dom, self.t):
            if tt < t0:
                prev = d
                continue
            if d is not None and prev is not None and d != prev:
                hops += 1
            if d is not None:
                prev = d
        span = max(1e-9, self.t[-1] - max(t0, self.t[0]))
        return hops / span

    def _visible_events(self) -> list:
        """Индексы кадров- onset'ов: смена или появление видимого канала."""
        out = []
        for i, d in enumerate(self.dom):
            if d is None:
                continue
            if i == 0 or self.dom[i - 1] != d:
                out.append(i)
        return out

    def _gap_stats(self, events: list) -> "tuple | None":
        """(мода интервалов, кандидаты dwell): мода + её /2 и /3 при
        валидном квантовании (редкая видимость: мода может сесть на
        гармонику 2·dwell). Валидация кандидата: ≥80% интервалов с
        ошибкой ≤0.2 кадра и хотя бы один интервал = 1×dwell."""
        if len(events) < 5:
            return None
        gaps = np.diff(np.asarray(events, dtype=np.float64))
        gaps = gaps[gaps >= 1]
        if gaps.size < 4:
            return None
        vals, counts = np.unique(gaps.astype(np.int64), return_counts=True)
        mode = float(vals[np.argmax(counts)])

        def quant_score(d: float) -> float:
            q = gaps / d
            err = np.abs(q - np.round(q))
            ok = (err <= 0.35) & (np.round(q) >= 1)
            if not np.any(np.round(q) == 1):
                return 0.0
            return float(ok.mean())

        cands = [mode]
        for div in (2, 3):
            d = mode / div
            if d >= 0.5 and quant_score(d) >= 0.8:
                cands.append(d)
        return (mode, cands, quant_score)

    def _onset_autocorr(self, events: list, max_lag: int = 40):
        """Автокорреляция индикатора onset'ов (робастна к джиттеру ±1 кадр):
        пик на лаге = период сетки скачков. Возвращает (lags, r) или None."""
        n = len(self.dom)
        if n < 32 or len(events) < 5:
            return None
        a = np.zeros(n)
        a[np.asarray(events)] = 1.0
        if a.mean() > 0.95:  # onset в каждом кадре: dwell = 1 тривиально
            return (np.arange(1, 2), np.asarray([1.0]))
        a = a - a.mean()
        r = np.correlate(a, a, "full")[n - 1:]
        if r[0] <= 1e-12:
            return None
        r = r / r[0]
        hi = min(max_lag, n // 3)
        return (np.arange(1, hi + 1), r[1: hi + 1])

    def infer_hop_clock(self) -> "dict | None":
        """Истинный темп при частичной видимости: dwell = мода интервалов
        между onset'ами. Частный случай мода=1: либо правда 1000 Гц
        (ELRS 2.4 — интервалы геометрические), либо джиттер-подмена
        (внутрипачечный флип/граница) — решает автокорреляция onset'ов:
        ясный пик на лаге ≥2 → dwell = лаг."""
        events = self._visible_events()
        st = self._gap_stats(events)
        if st is None:
            return None
        mode, cands, quant_score = st
        dwell, method = mode, "gap-mode"
        ac = self._onset_autocorr(events)

        def support(d: float) -> float:
            if ac is None:
                return 0.0
            _lags, r = ac
            lag = int(round(d))
            lo, hi = max(1, lag - 1), min(len(r), lag + 1)
            return float(np.max(r[lo - 1: hi])) if hi >= lo else 0.0

        if len(cands) > 1:
            # скоринг = квантование интервалов + автокорреляционная
            # поддержка. Квантование одних интервалов не отличает dwell
            # от делителя (1 кадр квантует всё); автокорреляция голосует
            # за фундаментальный период, а не гармонику/делитель.
            scored = [(quant_score(d) + support(d), d) for d in cands]
            scored.sort(key=lambda sd: (-sd[0], sd[1]))
            best_score, best = scored[0]
            if best_score >= 0.5:
                dwell, method = best, "scored"
        elif dwell == 1.0 and ac is not None:
            lags, r = ac
            k = int(np.argmax(r))
            if r[k] >= 0.3 and lags[k] >= 2:
                dwell, method = float(lags[k]), "autocorr"
        self._dwell_est = dwell
        self._table_lag = self._table_period(dwell)
        return {"dwell_frames": round(dwell, 2),
                "rate_hz": round(1.0 / (dwell * self.dt), 2),
                "method": method, "table_lag": self._table_lag}

    def protocol_match(self) -> dict:
        """Ближайший протокол по темпу (шаг 6.2), допуск ±15%. Истинный
        темп (infer_hop_clock) в приоритете над видимым (окно < таблицы)."""
        vis = self.hop_rate_hz()
        inf = self.infer_hop_clock()
        r = inf["rate_hz"] if inf else vis
        cands = {"elrs_24": 1000.0, "wifi_bt": 1600.0, "orangerx_fhss": 500.0,
                 "elrs_900": 200.0, "crossfire_fsk": 150.0,
                 "crossfire_lora": 50.0, "orangerx_dsmx": 90.9}
        best, best_d = None, 1e18
        for name, ref in cands.items():
            d = abs(r - ref) / ref
            if d < best_d:
                best, best_d = name, d
        return {"rate_hz": round(r, 2), "visible_rate_hz": round(vis, 2),
                "inferred": inf,
                "match": best if best_d <= 0.15 else None,
                "match_err": round(best_d, 3)}

    # ---- предсказание ----

    def _find_period(self, seq: list) -> "int | None":
        """Наименьший p: seq совпадает с собой со сдвигом p на ≥85%
        сравнимых (оба не-None) позиций. None-позиции не голосуют.
        Только при плотной видимости (≥40% кадров): при редкой видимости
        сравнимых пар мало — ложные периоды; там надёжнее Markov-1."""
        vis = sum(1 for d in seq if d is not None)
        if vis < 0.4 * len(seq):
            return None
        n = len(seq)
        for p in range(2, min(self.max_period, n // 2) + 1):
            cmp, ok = 0, 0
            for i in range(n - p, n):
                a, b = seq[i], seq[i - p]
                if a is None or b is None:
                    continue
                cmp += 1
                ok += int(a == b)
            if cmp >= max(12, p // 3) and ok / cmp >= 0.85:
                return p
        return None

    def _table_period(self, dwell_frames: float) -> "int | None":
        """Период таблицы FHSS в кадрах: лаг автосовпадения последователь-
        ности доминантов (None — wildcard, не голосует; совпадение с
        допуском ±1 бин — краевое расщепление PFB). Детерминированная
        таблица повторяется целиком → совпадение ≥80% сравнимых позиций,
        пропуски измерения не мешают (в отличие от Markov-1)."""
        seq = self.dom
        n = len(seq)
        if n < 64:
            return None
        d = max(1, int(round(dwell_frames)))
        hi = min(600, n - 64)
        for lag in range(max(2, d), hi):
            cmp = ok = 0
            for i in range(n - lag):
                a, b = seq[i], seq[i + lag]
                if a is None or b is None:
                    continue
                cmp += 1
                dd = (int(a) - int(b)) % self.m
                ok += int(dd in (0, 1, self.m - 1))
            if cmp >= 8 and ok / cmp >= 0.8:
                return lag
        return None

    def _merged_event_channels(self) -> list:
        """Каналы onset'ов после слияния 1-кадровых пар при медленной
        сетке (dwell ≥ 3 кадра): пара onset'ов в соседних кадрах —
        внутрипачечный флип (Carson-размаз по бинам PFB), а не два
        скачка. При dwell = 1 (ELRS 1000 Гц) каждый onset — скачок,
        слияние выключено."""
        ev = self._visible_events()
        chans: list = []
        i = 0
        while i < len(ev):
            chans.append(self.dom[ev[i]])
            if (self._dwell_est >= 3 and i + 1 < len(ev)
                    and ev[i + 1] == ev[i] + 1):
                i += 1  # второй onset пары — флип, пропускаем
            i += 1
        return [c for c in chans if c is not None]

    def predict_next(self) -> dict:
        """Предсказание следующего ВИДИМОГО канала (шаг 6.3).
        Приоритет — фазовой таблице (детерминированный цикл FHSS,
        устойчива к случайным пропускам измерения), затем период при
        плотной видимости, затем Markov-1, иначе hold."""
        seq = [d for d in self.dom]
        lag = self._table_lag
        if lag is not None and len(seq) > lag:
            # table[j] ≡ фазе кадра len+j: следующий кадр = table[0].
            # Текущий слот пропускаем целиком (== cur): доминант живёт
            # dwell кадров, иначе предсказание возвращает текущий канал.
            table = seq[-lag:]
            cur = seq[-1]
            for j in range(lag):
                cand = table[j]
                if cand is None or cand == cur:
                    continue
                self._pending = cand
                return {"next_channel": cand, "conf": 0.85,
                        "how": f"table={lag}", "period": lag}
        p = self._find_period(seq)
        evc = self._merged_event_channels()
        cur = evc[-1] if evc else None
        if p is not None:
            nxt = seq[len(seq) - p]
            conf = 0.9
            how = f"period={p}"
        elif cur is not None:
            succ: dict = {}
            trans = [(a, b) for a, b in zip(evc, evc[1:]) if a != b][-64:]
            for a, b in trans:
                if a == cur:
                    succ[b] = succ.get(b, 0) + 1
            if succ:
                nxt = max(succ.items(), key=lambda kv: kv[1])[0]
                conf = 0.5
                how = "markov1"
            else:
                nxt, conf, how = cur, 0.2, "hold"
        else:
            nxt, conf, how = cur, 0.2, "hold"
        self._pending = nxt
        return {"next_channel": nxt, "conf": conf, "how": how,
                "period": p}

    def prediction_accuracy(self) -> tuple:
        """Доля попаданий на последних ≤10 подтверждённых скачках (6.4)."""
        n = len(self._pred_log)
        if n == 0:
            return (0.0, 0)
        return (float(np.mean(self._pred_log)), n)


# ---------------------------------------------------------------------------
# Интеграция с PatternStore (когнитивный контур, ТЗ п.4)
# ---------------------------------------------------------------------------

def match_and_predict(store, live_hops, sub_corridor_id: str):
    """PatternStore-driven предсказание БЕЗ жёстких PARAMS:
    find_match → (pattern_id, next_channel_predicted, lp_score).
    next = цикл[(position+1) % cycle]. Нет матча — (None, None, 0.0):
    fallback — FallbackPredictor (Markov-1 HopTracker; DDPG [G3] —
    отдельный этап RL-обучения, см. RESOURCES.md)."""
    m = store.find_match(live_hops, sub_corridor_id, min_match=8)
    if m is None:
        return (None, None, 0.0)
    pid, pos, conf = m
    rec = store.get(pid)
    cyc = rec["cycle"]
    nxt = cyc[(pos + 1) % len(cyc)] if cyc else None
    return (pid, nxt, conf)


def check_pattern_drift(store, pattern_id: str, live_hops,
                        threshold: float = 0.7) -> bool:
    """LP score живого окна против паттерна < threshold → True (сбой)."""
    rec = store.get(pattern_id)
    if not live_hops:
        return True
    sub_id = rec["sub_corridor_id"]
    m = store.find_match(live_hops, sub_id, min_match=1)
    if m is None or m[0] != pattern_id:
        return True
    return float(m[2]) < float(threshold)


class FallbackPredictor:
    """Fallback при отсутствии паттерна в store: Markov-1/period из
    HopTracker (реальный, покрыт тестами). DDPG [G3] требует RL-обучения
    на размеченных эпизодах — отдельный этап, не заглушка."""

    def __init__(self, n_chans: int, frame_dt_s: float):
        self._tr = HopTracker(n_chans, frame_dt_s)

    def update(self, ch_pwr, t_s: float) -> dict:
        self._tr.update(ch_pwr, t_s)
        return self._tr.predict_next()
