import { useEffect, useId, useMemo, useRef, useState } from "react";

import { WAVE_CATALOG, type WaveKind } from "../../sdr/waveforms";
import { catalogCaps } from "../../sdr/hostClient";
import { FPGA_US_DET_SHIFT, LEGION_FPGA_FS_HZ, clampAirBwMhz, detectorWindowUs, fpgaAirSupported, fpgaTurnDwellClamp } from "../../sense/fpgaFastpath";
import { airHopBlockedReason, planFpgaSoloWalk, soloHopBlockedReason, standingWordRu, type FpgaSoloPattern } from "../../sense/fpgaSoloWalk";
import { autoDispatchOptionRu, type AutoDispatch } from "../../sense/modes";
import { useLegion } from "../../state/store";
import { type CinemaMode, type FpgaStartPath, runSimpleStart, runSmartStart } from "./run";

interface Props {
  mode: CinemaMode;
  onClose: () => void;
}

export function StartGate({ mode, onClose }: Props) {
  const titleId = useId();
  const firstRef = useRef<HTMLInputElement>(null);
  const sdrF1 = useLegion((s) => s.sdrF1);
  const sdrF2 = useLegion((s) => s.sdrF2);
  const corrF1 = useLegion((s) => s.corrF1);
  const corrF2 = useLegion((s) => s.corrF2);
  const signalKind = useLegion((s) => s.signalKind);
  const sdrLoadOk = useLegion((s) => s.sdrLoadOk);
  const loadOk = useLegion((s) => s.loadOk);
  const sdrId = useLegion((s) => s.sdrId);
  const storedWindow = useLegion((s) => s.fpgaSoloWindowMhz);
  const storedDwell = useLegion((s) => s.fpgaSoloDwellMs);
  const storedPattern = useLegion((s) => s.fpgaSoloPattern);
  const storedAirBw = useLegion((s) => s.fpgaAirBwMhz);
  const storedAirDwell = useLegion((s) => s.fpgaAirDwellMs);
  const storedAirPattern = useLegion((s) => s.fpgaAirWalkPattern);
  const storedTurnDwell = useLegion((s) => s.fpgaTurnDwellMs);
  const storedDispatch = useLegion((s) => s.autoDispatch);
  const [step, setStep] = useState<"band" | "path" | "walk">(mode === "sdr" ? "band" : "band");
  const [f1, setF1] = useState(mode === "sdr" ? sdrF1 : corrF1);
  const [f2, setF2] = useState(mode === "sdr" ? sdrF2 : corrF2);
  const [wave, setWave] = useState<WaveKind>(signalKind);
  const [ohm, setOhm] = useState(mode === "sdr" ? sdrLoadOk : loadOk);
  const [path, setPath] = useState<FpgaStartPath>("auto");
  const [dispatch, setDispatch] = useState<AutoDispatch>(storedDispatch);
  // У эфира и перехвата окно шага = канал подавления — свои сохранённые значения.
  const [windowMhz, setWindowMhz] = useState(path === "solo" ? storedWindow : storedAirBw);
  const [dwellMs, setDwellMs] = useState(
    path === "air" ? storedAirDwell : path === "auto" ? storedTurnDwell : storedDwell,
  );
  const [pattern, setPattern] = useState<FpgaSoloPattern>(path === "air" ? storedAirPattern : storedPattern);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const selected = WAVE_CATALOG.find((w) => w.id === wave) ?? WAVE_CATALOG[0];
  const analogMax = catalogCaps(sdrId).analogBwMhz;
  const airDetUs = detectorWindowUs(FPGA_US_DET_SHIFT, LEGION_FPGA_FS_HZ);
  const walkPlan = useMemo(
    () =>
      planFpgaSoloWalk({
        f1Mhz: parseFloat(f1),
        f2Mhz: parseFloat(f2),
        // Эфир: предпросмотр сетки по реальному каналу (урезан фильтром платы),
        // чтобы совпасть с тем, что посчитает startFpgaPath.
        windowMhz: path === "air" ? clampAirBwMhz(parseFloat(windowMhz), analogMax) : parseFloat(windowMhz),
        analogMaxMhz: analogMax,
        dwellMs: parseFloat(dwellMs),
        pattern,
        wave,
      }),
    [f1, f2, windowMhz, dwellMs, pattern, wave, analogMax, path],
  );
  const hopNo = walkPlan.ok
    ? path === "air"
      ? airHopBlockedReason(sdrId, walkPlan.hop)
      : soloHopBlockedReason(sdrId, walkPlan.hop)
    : null;
  const airWalkReason = walkPlan.ok
    ? `коридор ${walkPlan.spanMhz} МГц · канал ${walkPlan.hopWindowMhz} МГц → ${walkPlan.hops} ${standingWordRu(walkPlan.hops)} · ${
        walkPlan.hop ? (pattern === "hop" ? "случайно" : "туда-сюда") : "без прыжков"
      } · ретрансляция эфира на каждой стоянке` +
      // ADI: скачок LO > 100 МГц перезапускает QEC/DC-калибровки (десятки мс
      // вместо ~0.25 мс) — в выдержку влезает, но честно предупреждаем.
      (walkPlan.spanMhz > 100 ? " · скачки > 100 МГц = калибровки AD9361, десятки мс" : "")
    : walkPlan.reason;

  useEffect(() => {
    firstRef.current?.focus();
  }, [step]);

  // Поля шага walk у путей разные (канал эфира/перехвата ≠ окно solo; выдержка
  // очереди ≠ выдержка обхода) — при смене пути подставляем сохранённые.
  useEffect(() => {
    setWindowMhz(path === "solo" ? storedWindow : storedAirBw);
    setDwellMs(path === "air" ? storedAirDwell : path === "auto" ? storedTurnDwell : storedDwell);
    setPattern(path === "air" ? storedAirPattern : storedPattern);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const startSmart = async () => {
    setBusy(true);
    try {
      const ok = await runSmartStart({
        f1,
        f2,
        wave,
        loadOk: ohm,
        path,
        windowMhz,
        dwellMs,
        pattern,
        dispatch,
      });
      if (!ok) {
        setErr(useLegion.getState().log.at(-1)?.text || "FPGA не стартовала.");
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const goNext = async () => {
    setErr("");
    const a = parseFloat(f1);
    const b = parseFloat(f2);
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) {
      setErr("Задайте коридор F1…F2 в мегагерцах.");
      return;
    }
    if (!ohm) {
      setErr("Подтвердите нагрузку 50 Ом на выходе усилителя.");
      return;
    }
    if (mode === "esp32") {
      setBusy(true);
      try {
        await runSimpleStart({ f1, f2, loadOk: ohm });
        const st = useLegion.getState();
        if (!st.corridorRunning) {
          setErr(st.log[st.log.length - 1]?.text || "Коридор не стартовал — проверьте связь USB.");
          return;
        }
        onClose();
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === "band") {
      setStep("path");
      return;
    }
    if (step === "path") {
      // Перехват и эфир проходят шаг walk: канал/стратегия и канал/обход.
      setStep("walk");
      return;
    }
    if (path === "auto") {
      if (!fpgaAirSupported(sdrId)) {
        setErr("Автоматический перехват: нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 (вкладка SDR в Настройках).");
        return;
      }
      const ch = parseFloat(windowMhz);
      if (!Number.isFinite(ch) || ch <= 0) {
        setErr("Задайте канал ретрансляции в мегагерцах.");
        return;
      }
      await startSmart();
      return;
    }
    if (!walkPlan.ok) {
      setErr(walkPlan.reason);
      return;
    }
    if (hopNo) {
      setErr(hopNo);
      return;
    }
    await startSmart();
  };

  const goBack = () => {
    setErr("");
    if (step === "walk") setStep("path");
    else if (step === "path") setStep("band");
    else onClose();
  };

  return (
    <div className="cinema-gate" role="presentation" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="cinema-gate-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {mode === "sdr" && step === "walk" && path === "auto" ? (
          <>
            <p className="cinema-kicker">Умный · Автоматический перехват</p>
            <h2 id={titleId}>Канал и стратегия</h2>
            <p className="cinema-gate-lead">
              Сканер ищет сигнал в коридоре → LO паркуется на пик → FPGA ретранслирует
              эфир на усилитель за микросекунды. Сигнал пропал — поиск продолжается сам.
              Канал — ширина ретрансляции вокруг найденной частоты.
            </p>
            <div className="cinema-gate-row">
              <label title="Ширина полосы вокруг найденного пика, которую ретранслирует FPGA. Уже канал — точнее на цель, шире — захватывает соседей.">
                Канал, МГц
                <input ref={firstRef} value={windowMhz} onChange={(e) => setWindowMhz(e.target.value)} inputMode="decimal" />
              </label>
              {dispatch === "turn" && (
                <label title="Сколько секунд держать каждую найденную частоту перед переходом к следующей.">
                  Выдержка, мс
                  <input value={dwellMs} onChange={(e) => setDwellMs(e.target.value)} inputMode="decimal" />
                </label>
              )}
            </div>
            <div className="cinema-paths" role="radiogroup" aria-label="Стратегия перехвата">
              <button
                type="button"
                role="radio"
                aria-checked={dispatch === "priority"}
                className={dispatch === "priority" ? "cinema-path on" : "cinema-path"}
                onClick={() => setDispatch("priority")}
                title="Всегда выбирается самый сильный сигнал в коридоре. Появился более сильный рядом — переключение на него."
              >
                <strong>Приоритет</strong>
                <span>{autoDispatchOptionRu("priority")}.</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={dispatch === "turn"}
                className={dispatch === "turn" ? "cinema-path on" : "cinema-path"}
                onClick={() => setDispatch("turn")}
                title="Каждая живая частота обслуживается по кругу с выдержкой. Никто не монополизирует усилитель."
              >
                <strong>По очереди</strong>
                <span>{autoDispatchOptionRu("turn")} · выдержка {fpgaTurnDwellClamp(parseFloat(dwellMs))} мс.</span>
              </button>
            </div>
            <p className="cinema-gate-lead">
              {fpgaAirSupported(sdrId)
                ? `канал ${clampAirBwMhz(parseFloat(windowMhz), analogMax)} МГц · окно детектора ${airDetUs.toFixed(1)} мкс · ноутбук наблюдает и стопит`
                : "Нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 — выбирается на вкладке SDR в Настройках."}
            </p>
          </>
        ) : mode === "sdr" && step === "walk" ? (
          <>
            <p className="cinema-kicker">{path === "air" ? "Умный · Эфир + FPGA" : "Умный · Только FPGA"}</p>
            <h2 id={titleId}>{path === "air" ? "Канал и обход" : "Окно на усилитель"}</h2>
            <p className="cinema-gate-lead">
              {path === "air"
                ? "Канал — ширина ретрансляции на стоянке: вся мощность усилителя идёт в него. Коридор ÷ канал = стоянки. На каждой детектор и RX→TX по энергии; пороги меряются калибровкой при старте."
                : "Число — ширина пятна на усилителе. Коридор ÷ окно = стоянки. Окно ≥ коридора — одна точка, без прыжков. Тон остаётся палочкой."}
            </p>
            <div className="cinema-gate-row">
              <label>
                {path === "air" ? "Канал, МГц" : "Окно, МГц"}
                <input ref={firstRef} value={windowMhz} onChange={(e) => setWindowMhz(e.target.value)} inputMode="decimal" />
              </label>
              <label>
                Задержка, мс
                <input value={dwellMs} onChange={(e) => setDwellMs(e.target.value)} inputMode="decimal" />
              </label>
            </div>
            <div className="cinema-paths" role="radiogroup" aria-label="Ход по стоянкам">
              <button
                type="button"
                role="radio"
                aria-checked={pattern === "sweep"}
                className={pattern === "sweep" ? "cinema-path on" : "cinema-path"}
                onClick={() => setPattern("sweep")}
              >
                <strong>Туда-сюда</strong>
                <span>По сетке стоянок туда и обратно. USB не отпускаем — только LO.</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={pattern === "hop"}
                className={pattern === "hop" ? "cinema-path on" : "cinema-path"}
                onClick={() => setPattern("hop")}
              >
                <strong>Случайно</strong>
                <span>
                  {path === "air"
                    ? "Следующая стоянка из коридора наугад. Порог стоянки едет в той же команде tune."
                    : "Следующая стоянка из коридора наугад. Волну в RAM не переснимаем."}
                </span>
              </button>
            </div>
            <p className="cinema-gate-lead">{hopNo ?? (path === "air" ? airWalkReason : walkPlan.reason)}</p>
          </>
        ) : mode === "sdr" && step === "path" ? (
          <>
            <p className="cinema-kicker">Умный · FPGA</p>
            <h2 id={titleId}>Режим работы</h2>
            <p className="cinema-gate-lead">
              Перехват слушает эфир сканером и сам находит цели. Эфир + FPGA и Только FPGA
              работают без сканера: USB один — либо Soapy ставит LO, либо агент держит FPGA.
            </p>
            <div className="cinema-paths" role="radiogroup" aria-label="Режим FPGA">
              <button
                type="button"
                role="radio"
                aria-checked={path === "auto"}
                className={path === "auto" ? "cinema-path on" : "cinema-path"}
                onClick={() => setPath("auto")}
                title="Полный автомат: сканер ищет сигнал, FPGA ретранслирует его за микросекунды, при пропадании — возврат к поиску."
              >
                <strong>Автоматический перехват</strong>
                <span>
                  Сканер находит сигнал в коридоре → FPGA ретранслирует его на усилитель
                  за микросекунды. Сигнал пропал — поиск продолжается сам.{" "}
                  {fpgaAirSupported(sdrId)
                    ? "Эта плата в ревизии legion."
                    : "Нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40."}
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={path === "air"}
                className={path === "air" ? "cinema-path on" : "cinema-path"}
                onClick={() => setPath("air")}
                title="Одна стоянка или обход коридора без сканера: детектор в FPGA, ретрансляция по энергии."
              >
                <strong>Эфир + FPGA</strong>
                <span>
                  Антенна на RX SMA. Детектор в FPGA (I²+Q², 16 сэмплов @ {LEGION_FPGA_FS_HZ / 1e6} МГц ≈{" "}
                  {airDetUs} мкс на канале 2 МГц). Есть энергия — тот же RX IQ на TX SMA / усилитель.{" "}
                  {fpgaAirSupported(sdrId)
                    ? "Эта плата в ревизии legion."
                    : "Нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40."}{" "}
                  Канал, выдержка и обход коридора — следующий шаг.
                </span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={path === "solo"}
                className={path === "solo" ? "cinema-path on" : "cinema-path"}
                onClick={() => setPath("solo")}
              >
                <strong>Только FPGA</strong>
                <span>
                  Эфир не слушаем. Помеха из FPGA (NCO или player) по сетке коридор÷окно. Одна стоянка
                  или прыжки LO без пересъёма волны. Это не скан и не хостовые 200 µs.
                </span>
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="cinema-kicker">{mode === "sdr" ? "Умный · SDR" : "Простой · ESP32"}</p>
            <h2 id={titleId}>{mode === "sdr" ? "Коридор и тип сигнала" : "Коридор синтезатора"}</h2>
            <p className="cinema-gate-lead">
              {mode === "sdr"
                ? "Дальше: автоматический перехват (сканер + ретрансляция), эфир+FPGA без сканера или только FPGA. Тип сигнала — волна в player/NCO."
                : "ESP32 ведёт ADF4351 по коридору. Скана эфира нет — только сетка синтезатора."}
            </p>

            <div className="cinema-gate-row">
              <label>
                F1, МГц
                <input ref={firstRef} value={f1} onChange={(e) => setF1(e.target.value)} inputMode="decimal" />
              </label>
              <label>
                F2, МГц
                <input value={f2} onChange={(e) => setF2(e.target.value)} inputMode="decimal" />
              </label>
            </div>

            {mode === "sdr" && (
              <div className="cinema-waves">
                <p className="cinema-waves-title">Тип сигнала</p>
                <div className="cinema-waves-list" role="listbox" aria-label="Тип сигнала">
                  {WAVE_CATALOG.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      role="option"
                      aria-selected={w.id === wave}
                      className={w.id === wave ? "cinema-wave on" : "cinema-wave"}
                      onClick={() => setWave(w.id)}
                    >
                      {w.title}
                    </button>
                  ))}
                </div>
                <p className="cinema-wave-desc">{selected.desc}</p>
              </div>
            )}

            <label className="cinema-check">
              <input type="checkbox" checked={ohm} onChange={(e) => setOhm(e.target.checked)} />
              Нагрузка 50 Ом на выходе усилителя
            </label>
          </>
        )}

        {err ? <p className="cinema-gate-err">{err}</p> : null}

        <div className="cinema-gate-actions">
          {mode === "sdr" && (step === "path" || step === "walk") ? (
            <button type="button" className="cinema-btn ghost" onClick={goBack} disabled={busy}>
              Назад
            </button>
          ) : (
            <button type="button" className="cinema-btn ghost" onClick={onClose} disabled={busy}>
              Отмена
            </button>
          )}
          <button type="button" className="cinema-btn solid" onClick={() => void goNext()} disabled={busy}>
            {busy ? "…" : "Продолжить"}
          </button>
        </div>
      </div>
    </div>
  );
}
