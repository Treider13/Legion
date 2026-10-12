import { useEffect, useId, useState } from "react";

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
  const [a, setA] = useState(f1);
  const [b, setB] = useState(f2);
  const [ohm, setOhm] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const goNext = () => {
    setErr("");
    if (mode === "sdr") {
      onClose();
      return;
    }
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
    onRun({ path: "esp32", f1: a, f2: b });
  };

  return (
    <div className="cinema-gate" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cinema-gate-card" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <p className="cinema-kicker">{mode === "sdr" ? "Умный · SDR" : "Простой · ESP32"}</p>
        <h2 id={titleId}>{mode === "sdr" ? "Окно оператора" : "Коридор синтезатора"}</h2>
        <p className="cinema-gate-lead">
          {mode === "sdr"
            ? "Умная атака снята. Окно оператора — иконка LEGION: кнопки, мониторинг и живой водопад."
            : "ESP32 ведёт ADF4351 по коридору. Скана эфира нет — только сетка синтезатора."}
        </p>
        {mode === "esp32" && (
          <>
            <div className="cinema-gate-row">
              <label>F1, МГц<input value={a} onChange={(e) => setA(e.target.value)} inputMode="decimal" /></label>
              <label>F2, МГц<input value={b} onChange={(e) => setB(e.target.value)} inputMode="decimal" /></label>
            </div>
            <label className="cinema-check">
              <input type="checkbox" checked={ohm} onChange={(e) => setOhm(e.target.checked)} />
              Нагрузка 50 Ом на выходе усилителя
            </label>
          </>
        )}
        {err ? <p className="cinema-gate-err">{err}</p> : null}
        <div className="cinema-gate-actions">
          <button type="button" className="cinema-btn ghost" onClick={onClose}>Отмена</button>
          <button type="button" className="cinema-btn solid" onClick={goNext}>
            {mode === "esp32" ? "Запустить" : "Понятно"}
          </button>
        </div>
      </div>
    </div>
  );
}
