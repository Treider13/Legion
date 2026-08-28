import { modeOf } from "../../sense/modes";
import { useLegion } from "../../state/store";
import { cinemaIsLive, type CinemaMode, runCinemaStop } from "./run";

interface Props {
  mode: CinemaMode;
  onMode: (m: CinemaMode) => void;
  onStart: () => void;
  onSettings: () => void;
}

export function CinemaDock({ mode, onMode, onStart, onSettings }: Props) {
  const scanRunning = useLegion((s) => s.scanRunning);
  const transmitArmed = useLegion((s) => s.transmitArmed);
  const corridorRunning = useLegion((s) => s.corridorRunning);
  const signalTxActive = useLegion((s) => s.signalTxActive);
  const fpgaArmed = useLegion((s) => s.fpgaArmed);
  const fpgaBusy = useLegion((s) => s.fpgaBusy);
  const lastCue = useLegion((s) => s.lastCueReason);
  const lastLog = useLegion((s) => s.log[s.log.length - 1]?.text ?? "");
  const workspace = useLegion((s) => s.workspace);
  const live = cinemaIsLive({ scanRunning, transmitArmed, corridorRunning, signalTxActive, fpgaArmed, fpgaBusy });

  return (
    <footer className="cinema-dock">
      <div className="cinema-modes" role="group" aria-label="Режим">
        <button
          type="button"
          className={mode === "sdr" ? "cinema-mode on" : "cinema-mode"}
          onClick={() => onMode("sdr")}
          disabled={live && modeOf(workspace) === "esp32"}
        >
          Умный
          <span>SDR · Ethernet</span>
        </button>
        <button
          type="button"
          className={mode === "esp32" ? "cinema-mode on" : "cinema-mode"}
          onClick={() => onMode("esp32")}
          disabled={live && modeOf(workspace) === "sdr"}
        >
          Простой
          <span>ESP32 · USB</span>
        </button>
      </div>

      {live ? (
        <button type="button" className="cinema-go stop" onClick={() => void runCinemaStop()}>
          Стоп
        </button>
      ) : (
        <button type="button" className="cinema-go" onClick={onStart}>
          Запустить
        </button>
      )}

      <div className="cinema-dock-end">
        <p className="cinema-whisper" title={lastCue || lastLog}>
          {lastCue || lastLog || "Запустить → коридор и волна → эфир+FPGA или только FPGA."}
        </p>
        <button type="button" className="cinema-btn ghost" onClick={onSettings}>
          Настройки
        </button>
      </div>
    </footer>
  );
}
