import { catalogById } from "../../sdr/catalog";
import { modeOf } from "../../sense/modes";
import { useLegion } from "../../state/store";
import { connectionLabel } from "../graphite/connectionLabel";
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
  const fpgaStopPending = useLegion((s) => s.fpgaStopPending);
  const fpgaReleasing = useLegion((s) => s.fpgaStopPhase === "release");
  const fpgaStopReason = useLegion((s) => s.fpgaStatus?.reason);
  const lastCue = useLegion((s) => s.lastCueReason);
  const lastLog = useLegion((s) => s.log[s.log.length - 1]?.text ?? "");
  const workspace = useLegion((s) => s.workspace);
  const sdrId = useLegion((s) => s.sdrId);
  const openedIface = useLegion((s) => s.sdrOpened?.iface);
  const sl22 = useLegion((s) => s.transportKind === "htool-sl22");
  const txShelfMhz = useLegion((s) => s.txShelfMhz);
  const setTxShelfMhz = useLegion((s) => s.setTxShelfMhz);
  const sdrLink = sl22 ? "SDR" : connectionLabel(openedIface ?? catalogById(sdrId)?.iface).value;
  const live = cinemaIsLive({ scanRunning, transmitArmed, corridorRunning, signalTxActive, fpgaArmed, fpgaBusy, fpgaStopPending });
  const message = fpgaStopPending
    ? fpgaReleasing
      ? `Освобождаем соединение: ${fpgaStopReason ?? "ожидаем подтверждение шлюза"}`
      : `Остановка FPGA не подтверждена: ${fpgaStopReason ?? "ожидаем ответ шлюза"}`
    : lastCue || lastLog;

  return (
    <footer className="cinema-dock">
      {mode === "sdr" && (
        <label
          className="cinema-shelf"
          title="Ширина горба на анализаторе: часы и фильтр TX. Шум занимает это число. Тон и QPSK — нет. Шаг коридора только двигает центр. Умная атака и эфир копируют антенну — полка их не расширяет."
        >
          <span>ПОЛКА, МГц</span>
          <input
            aria-label="Полка передачи, МГц"
            value={txShelfMhz}
            onChange={(e) => setTxShelfMhz(e.target.value)}
            inputMode="decimal"
          />
          <small>ширина горба. Шум занимает её целиком. Шаг только двигает центр.</small>
        </label>
      )}
      <div className="cinema-dock-bar">
      <div className="cinema-modes" role="group" aria-label="Режим">
        <button
          type="button"
          className={mode === "sdr" ? "cinema-mode on" : "cinema-mode"}
          onClick={() => onMode("sdr")}
          disabled={live && modeOf(workspace) === "esp32"}
        >
          Умный
          <span>{sdrLink}</span>
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

      <div className="cinema-go-row">
        {live ? (
          <button type="button" className="cinema-go stop" onClick={() => void runCinemaStop()}>
            Стоп
          </button>
        ) : (
          <button type="button" className="cinema-go" onClick={onStart}>
            Запустить
          </button>
        )}
        {transmitArmed ? (
          <button type="button" className="cinema-go stop" onClick={() => void useLegion.getState().stopTransmit()}>
            Стоп передачу
          </button>
        ) : (
          <button type="button" className="cinema-go" onClick={() => void useLegion.getState().startTransmit()}>
            Передать
          </button>
        )}
      </div>

      <div className="cinema-dock-end">
        <p className="cinema-whisper" title={message}>
          {message || "Запустить → коридор → умная атака, эфир+FPGA или только FPGA."}
        </p>
        <button type="button" className="cinema-btn ghost" onClick={onSettings}>
          Настройки
        </button>
      </div>
      </div>
    </footer>
  );
}
