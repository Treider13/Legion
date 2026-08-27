import { useEffect, useId, useRef, useState } from "react";

import { WAVE_CATALOG, type WaveKind } from "../../sdr/waveforms";
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
  const [step, setStep] = useState<"band" | "path">(mode === "sdr" ? "band" : "band");
  const [f1, setF1] = useState(mode === "sdr" ? sdrF1 : corrF1);
  const [f2, setF2] = useState(mode === "sdr" ? sdrF2 : corrF2);
  const [wave, setWave] = useState<WaveKind>(signalKind);
  const [ohm, setOhm] = useState(mode === "sdr" ? sdrLoadOk : loadOk);
  const [path, setPath] = useState<FpgaStartPath>("air");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const selected = WAVE_CATALOG.find((w) => w.id === wave) ?? WAVE_CATALOG[0];

  useEffect(() => {
    firstRef.current?.focus();
  }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

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
    setBusy(true);
    try {
      const ok = await runSmartStart({ f1, f2, wave, loadOk: ohm, path });
      if (!ok) {
        setErr(useLegion.getState().log.at(-1)?.text || "FPGA не стартовала.");
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cinema-gate" role="presentation" onClick={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="cinema-gate-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        {mode === "sdr" && step === "path" ? (
          <>
            <p className="cinema-kicker">Умный · FPGA</p>
            <h2 id={titleId}>Как работает чип</h2>
            <p className="cinema-gate-lead">
              Хостовый скан здесь не идёт. USB один: либо Soapy ставит LO, либо агент держит FPGA.
            </p>
            <div className="cinema-paths" role="radiogroup" aria-label="Тракт FPGA">
              <button
                type="button"
                role="radio"
                aria-checked={path === "air"}
                className={path === "air" ? "cinema-path on" : "cinema-path"}
                onClick={() => setPath("air")}
              >
                <strong>Эфир + FPGA</strong>
                <span>
                  LO в центр F1–F2. Детектор в FPGA (I²+Q², окно 16 сэмплов ≈ 8 мкс). Есть энергия —
                  RX→TX внутри чипа на усилитель. Полосу шире аналогового окна плата не обходит.
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
                  Эфир не слушаем. Выбранная помеха играет из FPGA (NCO или player) на центре
                  коридора. Это не скан и не хостовые 200 µs.
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
                ? "Дальше выберете эфир+FPGA или только FPGA. Тип сигнала — волна в player/NCO."
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
          {mode === "sdr" && step === "path" ? (
            <button type="button" className="cinema-btn ghost" onClick={() => setStep("band")} disabled={busy}>
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
