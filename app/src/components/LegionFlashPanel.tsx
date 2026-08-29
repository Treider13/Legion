// LEGION — кастомная ревизия legion: СОБРАТЬ из fpga/ (Quartus на этом ПК),
// затем ПРОШИТЬ через bladeRF-cli -l/-L (локальный USB) или через шлюз.
// Не hosted-вкладка (та — ПРОШИВКА SDR) и не ESP32. Только bladeRF x40/xA4/xA9.
import { useEffect, useMemo } from "react";

import {
  LEGION_BOARDS,
  legionBoardFor,
  planLegionBuild,
  planLegionFlashGateway,
  planLegionFlashLocal,
} from "../flash/legionCustom";
import { useLegion } from "../state/store";

export function LegionFlashPanel() {
  const s = useLegion();
  useEffect(() => {
    void s.legionEnvRefresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const board = legionBoardFor(s.sdrId);
  const buildPlan = useMemo(() => planLegionBuild(s.sdrId), [s.sdrId]);
  const path = (s.legionFlashPath || (s.legionFlashTarget === "local" ? s.legionArtifactPath : "")).trim();
  const flashPlan = useMemo(() => {
    const opts = {
      sdrId: s.sdrId,
      path,
      action: s.legionFlashAction,
      confirmed: true, // превью команды без галочки; запись всё равно требует confirm
    };
    return s.legionFlashTarget === "local" ? planLegionFlashLocal(opts) : planLegionFlashGateway(opts);
  }, [s.sdrId, path, s.legionFlashAction, s.legionFlashTarget]);

  const canBuild = buildPlan.ok && s.legionCanBuild && s.legionBuildPhase !== "building";
  const canFlash = flashPlan.ok && s.legionFlashConfirm && !s.flashBusy && !s.fpgaArmed && path.length > 0;

  return (
    <section className="panel">
      <span className="panel-title">КАСТОМ FPGA // РЕВИЗИЯ LEGION</span>
      <p className="panel-note">
        Своя ревизия поверх hosted Nuand: детектор энергии сигнала, ретрансляция приём→передача,
        генератор тона и записанного сигнала, сторожевой таймер.
        Сборка из <code>fpga/</code> этим ПК (Quartus Prime Lite 23.1.1 + NIOS II shell), запись —
        вендорский <code>bladeRF-cli</code>. Официальный hosted-образ — вкладка ПРОШИВКА SDR,
        ESP32 — своя вкладка. Сюда: только bladeRF 1 x40 и bladeRF 2.0 micro xA4/xA9.
      </p>
      <p className="flash-brick">
        Неверный size (A4↔A9, x40↔micro) кирпичит FPGA до отката на hostedx*.rbf. Сначала RAM
        (-l): питание off/on — и плата снова стоковая.
      </p>
      <div className="corr-grid">
        <label>
          ПЛАТА
          <select aria-label="Плата bladeRF для ревизии legion" value={s.sdrId} onChange={(e) => s.setSdrId(e.target.value)}>
            {!board && <option value={s.sdrId}>{s.sdrId} — без ревизии legion</option>}
            {LEGION_BOARDS.map((b) => (
              <option key={b.sdrId} value={b.sdrId}>
                {b.sdrId} → {b.rbf}
              </option>
            ))}
          </select>
        </label>
        <label>
          ЗАПИСЬ
          <select
            aria-label="Куда пишет bladeRF-cli"
            value={s.legionFlashAction}
            onChange={(e) => s.setLegionFlashAction(e.target.value as "load" | "store")}
          >
            <option value="load">FPGA В RAM (-l) — после питания спадёт</option>
            <option value="store">FPGA В FLASH (-L) — autoload, останется</option>
          </select>
        </label>
      </div>

      <span className="panel-title">1 · СБОРКА (этот ПК)</span>
      <p className={s.legionCanBuild && buildPlan.ok ? "status-line" : "panel-warn"}>
        {s.legionEnvDetail || "среда не проверена"}
        {` · ${buildPlan.reason}`}
      </p>
      <div className="power-row">
        <button
          className="btn-ghost"
          type="button"
          disabled={s.legionBuildPhase === "building"}
          onClick={() => void s.legionToolchainRun()}
        >
          ПРОВЕРИТЬ ТУЛЧЕЙН
        </button>
        <button
          className="btn-primary"
          type="button"
          disabled={!canBuild}
          onClick={() => void s.legionBuildStart()}
        >
          {s.legionBuildPhase === "building" ? "СОБИРАЕМ…" : "СОБРАТЬ"}
        </button>
        {s.legionBuildPhase === "building" && (
          <button className="btn-danger" type="button" onClick={() => void s.legionBuildCancel()}>
            ОТМЕНА
          </button>
        )}
      </div>
      {s.legionBuildLog && <pre className="build-log">{s.legionBuildLog}</pre>}
      {s.legionBuildPhase === "done" && s.legionArtifactPath && (
        <p className="status-line">
          артефакт: {s.legionArtifactPath}
          {s.legionArtifactSha256 ? ` · sha256 ${s.legionArtifactSha256.slice(0, 16)}…` : ""}
        </p>
      )}
      {s.legionBuildPhase === "failed" && <p className="panel-warn">сборка не дала .rbf — хвост лога выше</p>}

      <span className="panel-title">2 · ПРОШИТЬ SDR</span>
      <div className="corr-grid">
        <label>
          ГДЕ USB
          <select
            aria-label="Где USB к плате"
            value={s.legionFlashTarget}
            onChange={(e) => s.setLegionFlashTarget(e.target.value as "local" | "gateway")}
          >
            <option value="local">локальный USB (этот ПК)</option>
            <option value="gateway">на шлюзе (Ethernet-стенд)</option>
          </select>
        </label>
        <label>
          {s.legionFlashTarget === "local" ? "АБСОЛЮТНЫЙ ПУТЬ К .RBF" : "АБСОЛЮТНЫЙ ПУТЬ НА ШЛЮЗЕ"}
          <input
            aria-label="Путь к legion .rbf"
            value={s.legionFlashPath}
            onChange={(e) => s.setLegionFlashPath(e.target.value)}
            spellCheck={false}
            placeholder={board ? `/tmp/fw/${board.rbf}` : "/tmp/fw/legionxA4.rbf"}
          />
        </label>
      </div>
      {s.legionFlashTarget === "gateway" && (
        <p className="panel-note">
          Файл должен уже лежать на машине шлюза (scp с этого ПК после сборки). Шлюз сам гоняет
          bladeRF-cli и перезанимает USB. Перед прошивкой на шлюзе остановить SoapySDRServer —
          USB один владелец. LEGION_FPGA_TOKEN — как на вкладке ТИП СИГНАЛА.
        </p>
      )}
      <p className={flashPlan.ok ? "status-line" : "panel-warn"}>
        {flashPlan.ok ? `будет запущено: ${flashPlan.reason}` : flashPlan.reason}
      </p>
      <label className="check-row">
        <input
          type="checkbox"
          checked={s.legionFlashConfirm}
          onChange={(e) => s.setLegionFlashConfirm(e.target.checked)}
        />
        Подтверждаю: это ревизия legion для {board?.sdrId ?? s.sdrId}, не hosted и не ESP32.
      </label>
      <div className="power-row">
        <button className="btn-ghost" type="button" onClick={() => s.setWorkspace("sdrFlash")}>
          ← ОФИЦ. ОБРАЗ
        </button>
        <button
          className="btn-danger"
          type="button"
          disabled={!canFlash}
          onClick={() => void s.legionFlash()}
        >
          {s.flashBusy ? "ПИШЕМ…" : "ПРОШИТЬ"}
        </button>
        {s.fpgaArmed && <p className="panel-warn">сначала ОСТАНОВИТЬ FPGA — CLI и шлюз не делят USB</p>}
      </div>
      {s.lastLegionFlash && (
        <p className={s.lastLegionFlash.ok ? "status-line" : "panel-warn"}>
          {s.lastLegionFlash.ok ? "записано: " : "не записано: "}
          {s.lastLegionFlash.reason}
        </p>
      )}
    </section>
  );
}
