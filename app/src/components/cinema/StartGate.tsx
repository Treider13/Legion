import { useEffect, useId, useMemo, useRef, useState } from "react";

import { WAVE_CATALOG, type WaveKind } from "../../sdr/waveforms";
import { catalogCaps } from "../../sdr/hostClient";
import { FPGA_US_DET_SHIFT, LEGION_FPGA_FS_HZ, airTractParams, clampAirBwMhz, detectorWindowUs, fpgaAirSupported, fpgaSurveyPeriodClamp, fpgaTurnDwellClamp, parseLocaleNumber } from "../../sense/fpgaFastpath";
import { airHopBlockedReason, planFpgaSoloWalk, soloHopBlockedReason, standingWordRu, type FpgaSoloPattern } from "../../sense/fpgaSoloWalk";
import { autoDispatchOptionRu, FPGA_AI_OPTION_RU, FPGA_AIR_MODE_RU, fpgaInnerDispatch, type AutoDispatch } from "../../sense/modes";
import { TxGainControl } from "../TxGainControl";
import { useLegion } from "../../state/store";
import { type CinemaMode, type FpgaStartPath, runSimpleStart, runSmartStart } from "./run";

interface Props {
  mode: CinemaMode;
  onClose: () => void;
}

/** Слепое пятно одночастотного релея (docs/architecture.md): утечка TX→RX
 *  держит гейт открытым после смерти цели. Показываем в режимах с ретрансляцией. */
const SELF_EXCITE_WARN =
  "Ретрансляция — одночастотный тракт: возможна утечка собственного сигнала с выхода " +
  "на вход. Приоритет: сильная утечка держит гейт на взгляде. По очереди " +
  "плата уйдёт по выдержке даже если гейт ещё открыт. Разнесите антенны RX и TX. " +
  "Кнопка «Стоп» и сторожевой таймер работают всегда.";

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
  const storedSurveyPeriod = useLegion((s) => s.fpgaSurveyPeriodMs);
  const storedDispatch = useLegion((s) => s.autoDispatch);
  const storedDetThr = useLegion((s) => s.fpgaDetThr);
  const detShift = useLegion((s) => s.fpgaDetShift);
  const [step, setStep] = useState<"band" | "path" | "walk">("band");
  const [f1, setF1] = useState(mode === "sdr" ? sdrF1 : corrF1);
  const [f2, setF2] = useState(mode === "sdr" ? sdrF2 : corrF2);
  const [wave, setWave] = useState<WaveKind>(signalKind);
  const [ohm, setOhm] = useState(mode === "sdr" ? sdrLoadOk : loadOk);
  const [path, setPath] = useState<FpgaStartPath>("auto");
  const [dispatch, setDispatch] = useState<AutoDispatch>(fpgaInnerDispatch(storedDispatch));
  // У эфира и перехвата окно шага = канал подавления — свои сохранённые значения.
  const storedSoloStep = useLegion((s) => s.fpgaSoloStepMhz);
  const [windowMhz, setWindowMhz] = useState(
    path === "solo" ? storedWindow : storedAirBw,
  );
  const [soloStepMhz, setSoloStepMhz] = useState(storedSoloStep);
  const [dwellMs, setDwellMs] = useState(
    path === "air" ? storedAirDwell : path === "auto" ? storedTurnDwell : storedDwell,
  );
  const [surveyPeriodMs, setSurveyPeriodMs] = useState(storedSurveyPeriod);
  const [pattern, setPattern] = useState<FpgaSoloPattern>(path === "air" ? storedAirPattern : storedPattern);
  const [detThr, setDetThr] = useState(String(storedDetThr));
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
        stepMhz: path === "solo" ? parseLocaleNumber(soloStepMhz) : undefined,
        analogMaxMhz: analogMax,
        dwellMs: parseFloat(dwellMs),
        pattern,
        wave,
      }),
    [f1, f2, windowMhz, soloStepMhz, dwellMs, pattern, wave, analogMax, path],
  );
  const hopNo = walkPlan.ok
    ? path === "air"
      ? airHopBlockedReason(sdrId, walkPlan.hop)
      : soloHopBlockedReason(sdrId, walkPlan.hop)
    : null;
  // Калибровка порогов перед ARM: park+захват на каждой стоянке (~0.2 с по
  // LAN) — при тысячах стоянок это минуты; честно показываем оценку заранее.
  const calibEstSec = walkPlan.hops * 0.2;
  const calibEstTxt =
    calibEstSec < 90 ? `≈${Math.max(1, Math.ceil(calibEstSec))} с` : `≈${Math.round(calibEstSec / 60)} мин`;
  const airWalkReason = walkPlan.ok
    ? `коридор ${walkPlan.spanMhz} МГц · канал ${walkPlan.hopWindowMhz} МГц → ${walkPlan.hops} ${standingWordRu(walkPlan.hops)} · ${
        walkPlan.hop ? (pattern === "hop" ? "случайно" : "туда-сюда") : "без прыжков"
      } · ретрансляция эфира на каждой стоянке` +
      (walkPlan.hop ? ` · калибровка порогов при старте ${calibEstTxt}` : "") +
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
        surveyPeriodMs,
        pattern,
        dispatch,
        detThr,
        stepMhz: path === "solo" ? soloStepMhz : undefined,
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
        setErr(`${FPGA_AIR_MODE_RU}: нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 (вкладка SDR в Настройках).`);
        return;
      }
      const ch = parseLocaleNumber(windowMhz);
      if (!Number.isFinite(ch) || ch <= 0) {
        setErr("Задайте ширину взгляда платы в мегагерцах.");
        return;
      }
      const dwell = parseLocaleNumber(dwellMs);
      if (!Number.isFinite(dwell) || dwell <= 0) {
        setErr("Задайте выдержку числом (0,4 и 0.4 — 400 мкс).");
        return;
      }
      const period = parseLocaleNumber(surveyPeriodMs);
      if (!Number.isFinite(period) || period <= 0) {
        setErr("Задайте период сканирования числом (например 5).");
        return;
      }
      const thr = parseFloat(detThr);
      if (!Number.isFinite(thr) || thr <= 0) {
        setErr("Задайте порог чувствительности больше нуля.");
        return;
      }
      await startSmart();
      return;
    }
    if (!walkPlan.ok) {
      setErr(walkPlan.reason);
      return;
    }
    if (path === "air") {
      const thr = parseFloat(detThr);
      if (!Number.isFinite(thr) || thr <= 0) {
        setErr("Задайте порог чувствительности больше нуля.");
        return;
      }
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
            <p className="cinema-kicker">Умный · {FPGA_AIR_MODE_RU}</p>
            <h2 id={titleId}>Канал и стратегия</h2>
            <p className="cinema-gate-lead">
              После Старта хозяин один — SDR. Ноутбук задаёт коридор, выдержку
              на сигнал, период сканирования, Старт и Стоп. Плата сама видит
              энергию (антенна на RX1 / RX SMA) и сама открывает TX1 / TX SMA на усилитель.
              ИИ снаружи всегда: глухой обзор → окно на всплеск → по истечении периода снова обзор.
              Внутри окна — обычный (выдержка по очереди) или приоритет (сильнее — перескок и новая выдержка).
              USB не в круге «увидел → усилитель».
            </p>
            <div className="cinema-gate-row">
              <label title="Ширина одного взгляда платы и шаг сетки LO (аналоговый фильтр). Уже — 2450 и 2465 как разные стоянки; шире потолка платы — урежется.">
                Взгляд, МГц
                <input ref={firstRef} value={windowMhz} onChange={(e) => setWindowMhz(e.target.value)} inputMode="decimal" />
              </label>
              <label title="Сколько миллисекунд держать усилитель на найденном сигнале внутри окна. Обычный и приоритет.">
                Выдержка, мс
                <input value={dwellMs} onChange={(e) => setDwellMs(e.target.value)} inputMode="decimal" />
              </label>
            </div>
            <div className="cinema-gate-row">
              <label title="Через сколько миллисекунд снова пройти глухой обзор всего коридора.">
                Сканирование, мс
                <input value={surveyPeriodMs} onChange={(e) => setSurveyPeriodMs(e.target.value)} inputMode="decimal" />
              </label>
              <label title="Порог средней энергии I²+Q². Полка USB-IQ в круге перехвата больше не меряется.">
                Порог чувствительности
                <input value={detThr} onChange={(e) => setDetThr(e.target.value)} inputMode="numeric" />
              </label>
            </div>
            <p className="cinema-gate-lead">{FPGA_AI_OPTION_RU} · сканирование каждые {fpgaSurveyPeriodClamp(parseLocaleNumber(surveyPeriodMs))} мс.</p>
            <div className="cinema-paths" role="radiogroup" aria-label="Стратегия внутри окна">
              <button
                type="button"
                role="radio"
                aria-checked={dispatch === "priority"}
                className={dispatch === "priority" ? "cinema-path on" : "cinema-path"}
                onClick={() => setDispatch("priority")}
                title="Сильнее в окне — перескок и новая выдержка. Слабее не сбивает."
              >
                <strong>Приоритет</strong>
                <span>{autoDispatchOptionRu("priority")} · выдержка {fpgaTurnDwellClamp(parseLocaleNumber(dwellMs))} мс.</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={dispatch === "turn"}
                className={dispatch === "turn" ? "cinema-path on" : "cinema-path"}
                onClick={() => setDispatch("turn")}
                title="Найденный сигнал: усилитель на выдержке, затем текущий пик."
              >
                <strong>Обычный</strong>
                <span>{autoDispatchOptionRu("turn")} · выдержка {fpgaTurnDwellClamp(parseLocaleNumber(dwellMs))} мс.</span>
              </button>
            </div>
            <p className="cinema-gate-lead">
              {fpgaAirSupported(sdrId)
                ? `взгляд ${clampAirBwMhz(parseLocaleNumber(windowMhz), analogMax)} МГц · гейт ${
                    airTractParams(parseLocaleNumber(windowMhz), analogMax, detShift).windowUs.toFixed(1)
                  } мкс · обзор коридора — шаги LO, мс · ноутбук наблюдает и стопит`
                : "Нужен bladeRF 2.0 micro xA4/xA9 или bladeRF 1 x40 — выбирается на вкладке SDR в Настройках."}
            </p>
            <p className="cinema-gate-warn">{SELF_EXCITE_WARN}</p>
          </>
        ) : mode === "sdr" && step === "walk" ? (
          <>
            <p className="cinema-kicker">{path === "air" ? "Умный · Эфир + FPGA" : "Умный · Только FPGA"}</p>
            <h2 id={titleId}>{path === "air" ? "Канал и обход" : "Окно на усилитель"}</h2>
            <p className="cinema-gate-lead">
              {path === "air"
                ? "Канал — ширина ретрансляции на стоянке: вся мощность усилителя идёт в него. Коридор ÷ канал = стоянки. На каждой детектор и RX→TX по энергии; пороги меряются калибровкой при старте."
                : "Окно — полка на усилителе: часы и фильтр. Шум занимает её целиком, тон остаётся палочкой. Пустой шаг равен полке. Свой шаг только двигает центр."}
            </p>
            <div className="cinema-gate-row">
              <label title={path === "air"
                ? "Ширина полосы ретрансляции на каждой стоянке. Коридор делится на стоянки шириной канала."
                : "Ширина пятна сигнала на усилителе. Окно больше коридора — одна стоянка без прыжков."}>
                {path === "air" ? "Канал, МГц" : "Окно, МГц"}
                <input ref={firstRef} value={windowMhz} onChange={(e) => setWindowMhz(e.target.value)} inputMode="decimal" />
              </label>
              {path === "solo" && (
                <label title="На сколько мегагерц прыгает центр. Пусто — шаг равен полке, куски стыкуются.">
                  Шаг, МГц
                  <input
                    aria-label="Шаг стоянок solo"
                    value={soloStepMhz}
                    onChange={(e) => setSoloStepMhz(e.target.value)}
                    inputMode="decimal"
                    placeholder="как полка"
                  />
                </label>
              )}
              <label title="Сколько миллисекунд стоять на каждой точке перед переходом к следующей.">
                Задержка, мс
                <input value={dwellMs} onChange={(e) => setDwellMs(e.target.value)} inputMode="decimal" />
              </label>
            </div>
            {path === "air" && (
              <div className="cinema-gate-row">
                <label title="Минимальная энергия сигнала, при которой открывается ретрансляция. Больше — только сильные сигналы, меньше — чувствительнее к слабым. При обходе коридора (несколько стоянок) пороги измеряются калибровкой автоматически.">
                  Порог чувствительности
                  <input value={detThr} onChange={(e) => setDetThr(e.target.value)} inputMode="numeric" />
                </label>
              </div>
            )}
            <div className="cinema-paths" role="radiogroup" aria-label="Ход по стоянкам">
              <button
                type="button"
                role="radio"
                aria-checked={pattern === "sweep"}
                className={pattern === "sweep" ? "cinema-path on" : "cinema-path"}
                onClick={() => setPattern("sweep")}
                title="Обход стоянок по порядку: от края коридора к краю и обратно."
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
                title="Следующая стоянка выбирается случайно из сетки коридора."
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
            {path === "air" && <p className="cinema-gate-warn">{SELF_EXCITE_WARN}</p>}
          </>
        ) : mode === "sdr" && step === "path" ? (
          <>
            <p className="cinema-kicker">Умный · FPGA</p>
            <h2 id={titleId}>Режим работы</h2>
            <p className="cinema-gate-lead">
              {FPGA_AIR_MODE_RU}: после Старта хозяин — плата (USB не в круге увидел→TX).
              Эфир + FPGA и Только FPGA работают без онбордового обзора: USB один —
              либо Soapy ставит LO, либо агент держит FPGA.
            </p>
            <div className="cinema-paths" role="radiogroup" aria-label="Режим FPGA">
              <button
                type="button"
                role="radio"
                aria-checked={path === "auto"}
                className={path === "auto" ? "cinema-path on" : "cinema-path"}
                onClick={() => setPath("auto")}
                title="После Старта хозяин — SDR. Плата сама видит энергию и открывает TX. Ноутбук — рубильник."
              >
                <strong>{FPGA_AIR_MODE_RU}</strong>
                <span>
                  Антенна на RX SMA. Плата смотрит эфир в аналоговом окне и сама
                  решает, что энергия есть. USB не в круге «увидел → усилитель».{" "}
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
                title="Генерация сигнала внутри FPGA: тон или волна из памяти. Эфир не слушается."
              >
                <strong>Только FPGA</strong>
                <span>
                  Эфир не слушаем. Генерация сигнала в FPGA (тон или волна из памяти) по сетке
                  коридор÷окно. Одна стоянка или прыжки LO без перезаписи волны.
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
                ? `Дальше: ${FPGA_AIR_MODE_RU.toLowerCase()} (плата сама ищет всплеск и ставит окно), эфир+FPGA без онбордового обзора или только FPGA. Тип сигнала — волна для генерации в FPGA.`
                : "ESP32 ведёт ADF4351 по коридору. Скана эфира нет — только сетка синтезатора."}
            </p>

            <div className="cinema-gate-row">
              <label title="Начало рабочего коридора в мегагерцах.">
                F1, МГц
                <input ref={firstRef} value={f1} onChange={(e) => setF1(e.target.value)} inputMode="decimal" />
              </label>
              <label title="Конец рабочего коридора в мегагерцах.">
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

            <label className="cinema-check" title="Подтверждение, что выход усилителя замкнут на эквивалент антенны 50 Ом, а не на открытый эфир. Без этого старт заблокирован.">
              <input type="checkbox" checked={ohm} onChange={(e) => setOhm(e.target.checked)} />
              Нагрузка 50 Ом на выходе усилителя
            </label>
          </>
        )}

        {mode === "sdr" ? <TxGainControl tone="cinema" /> : null}

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
            {busy ? "…" : step === "walk" || mode === "esp32" ? "Запустить" : "Продолжить"}
          </button>
        </div>
      </div>
    </div>
  );
}
