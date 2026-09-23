import { useEffect, useId, useState } from "react";

import { WAVE_CATALOG, type WaveKind } from "../sdr/waveforms";

type Step = "band" | "path" | "walk";
type Path = "auto" | "air" | "solo";

export function DemoGate({
  mode,
  f1,
  f2,
  onClose,
  onRun,
}: {
  mode: "sdr" | "esp32";
  f1: string;
  f2: string;
  onClose: () => void;
  onRun: (run: { path: Path | "esp32"; f1: string; f2: string }) => void;
}) {
  const titleId = useId();
  const [step, setStep] = useState<Step>("band");
  const [a, setA] = useState(f1);
  const [b, setB] = useState(f2);
  const [ohm, setOhm] = useState(false);
  const [wave, setWave] = useState<WaveKind>("tone");
  const [path, setPath] = useState<Path>("auto");
  const [err, setErr] = useState("");
  const selected = WAVE_CATALOG.find((item) => item.id === wave) ?? WAVE_CATALOG[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const goNext = () => {
    setErr("");
    const lo = parseFloat(a);
    const hi = parseFloat(b);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
      setErr("Задайте коридор F1…F2 в мегагерцах.");
      return;
    }
    if (!ohm) {
      setErr("Подтвердите нагрузку 50 Ом на выходе усилителя.");
      return;
    }
    if (mode === "esp32") {
      onRun({ path: "esp32", f1: a, f2: b });
      return;
    }
    if (step === "band") {
      setStep("path");
      return;
    }
    if (step === "path") {
      setStep("walk");
      return;
    }
    onRun({ path, f1: a, f2: b });
  };

  return (
    <div className="cinema-gate" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cinema-gate-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {mode === "sdr" && step === "path" ? (
          <>
            <p className="cinema-kicker">Умный · FPGA</p>
            <h2 id={titleId}>Режим работы</h2>
            <p className="cinema-gate-lead">
              Умная атака: после Старта хозяин — плата (USB не в круге увидел→TX).
              Эфир + FPGA и Только FPGA работают без онбордового обзора: USB один —
              либо Soapy ставит LO, либо агент держит FPGA.
            </p>
            <div className="cinema-paths" role="radiogroup" aria-label="Режим FPGA">
              <button type="button" role="radio" aria-checked={path === "auto"} className={path === "auto" ? "cinema-path on" : "cinema-path"} onClick={() => setPath("auto")}>
                <strong>Умная атака</strong>
                <span>Антенна на RX SMA. Плата смотрит эфир в аналоговом окне и сама решает, что энергия есть. USB не в круге «увидел → усилитель». Эта плата в ревизии legion.</span>
              </button>
              <button type="button" role="radio" aria-checked={path === "air"} className={path === "air" ? "cinema-path on" : "cinema-path"} onClick={() => setPath("air")}>
                <strong>Эфир + FPGA</strong>
                <span>Антенна на RX SMA. Детектор в FPGA. Есть энергия — тот же RX IQ на TX SMA / усилитель. Эта плата в ревизии legion.</span>
              </button>
              <button type="button" role="radio" aria-checked={path === "solo"} className={path === "solo" ? "cinema-path on" : "cinema-path"} onClick={() => setPath("solo")}>
                <strong>Только FPGA</strong>
                <span>Эфир не слушаем. Генерация сигнала в FPGA (тон или волна из памяти) по сетке коридор÷окно.</span>
              </button>
            </div>
          </>
        ) : mode === "sdr" && step === "walk" ? (
          <>
            <p className="cinema-kicker">{path === "air" ? "Умный · Эфир + FPGA" : path === "solo" ? "Умный · Только FPGA" : "Умный · Умная атака"}</p>
            <h2 id={titleId}>{path === "solo" ? "Окно на усилитель" : "Канал и обход"}</h2>
            <p className="cinema-gate-lead">
              {path === "auto"
                ? "После Старта хозяин — SDR. Ноутбук задаёт коридор, Старт и Стоп. Плата сама видит энергию. В этом контуре плата не подключена: на главном экране будет тот же статус, что без шлюза."
                : path === "air"
                  ? "Без онбордового обзора. Детектор смотрит энергию канала."
                  : "Эфир не слушаем. Генерация по сетке коридора."}
            </p>
          </>
        ) : (
          <>
            <p className="cinema-kicker">{mode === "sdr" ? "Умный · SDR" : "Простой · ESP32"}</p>
            <h2 id={titleId}>{mode === "sdr" ? "Коридор и тип сигнала" : "Коридор синтезатора"}</h2>
            <p className="cinema-gate-lead">
              {mode === "sdr"
                ? "Дальше: умная атака (плата сама ищет всплеск и ставит окно), эфир+FPGA без онбордового обзора или только FPGA. Тип сигнала — волна для генерации в FPGA."
                : "ESP32 ведёт ADF4351 по коридору. Скана эфира нет — только сетка синтезатора."}
            </p>
            <div className="cinema-gate-row">
              <label>F1, МГц<input value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" /></label>
              <label>F2, МГц<input value={b} onChange={(e) => setB(e.target.value)} inputMode="decimal" /></label>
            </div>
            {mode === "sdr" && (
              <div className="cinema-waves">
                <p className="cinema-waves-title">Тип сигнала</p>
                <div className="cinema-waves-list" role="listbox" aria-label="Тип сигнала">
                  {WAVE_CATALOG.map((item) => (
                    <button key={item.id} type="button" role="option" aria-selected={item.id === wave} className={item.id === wave ? "cinema-wave on" : "cinema-wave"} onClick={() => setWave(item.id)}>
                      {item.title}
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
            <button type="button" className="cinema-btn ghost" onClick={() => { setErr(""); setStep(step === "walk" ? "path" : "band"); }}>Назад</button>
          ) : (
            <button type="button" className="cinema-btn ghost" onClick={onClose}>Отмена</button>
          )}
          <button type="button" className="cinema-btn solid" onClick={goNext}>
            {step === "walk" || mode === "esp32" ? "Запустить" : "Продолжить"}
          </button>
        </div>
      </div>
    </div>
  );
}
