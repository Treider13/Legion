// Настройки умной атаки по связке ПК → таблица в FPGA → удар платы.
// Коридор и время удара задаёт оператор. Прыжки, паттерн и загрузку LUT
// компьютер считает сам. Плата шагает по таблице без команды на каждый прыжок.
import { useState } from "react";

import { isFpgaAirPattern } from "../../sense/modes";
import { useLegion } from "../../state/store";

const RX_WINDOW_MHZ = 34;

export function SmartAttackStrip() {
  const pattern = useLegion((s) => s.scanPattern);
  const f1 = useLegion((s) => s.sdrF1);
  const f2 = useLegion((s) => s.sdrF2);
  const setField = useLegion((s) => s.setSdrAllowField);
  const [jamS, setJamS] = useState("15");
  const [muteNs, setMuteNs] = useState("0");
  const [lnaDb, setLnaDb] = useState("20");

  if (!isFpgaAirPattern(pattern)) return null;

  return (
    <section className="smart-attack-strip" aria-label="Настройки умной атаки">
      <p>
        Компьютер сканирует коридор окнами по {RX_WINDOW_MHZ} МГц, сам находит прыжки
        и подтверждает паттерн. Затем записывает таблицу частот в плату. Плата бьёт
        сама {jamS || "15"} с и возвращается к скану того же коридора.
      </p>
      <div>
        <label>
          Коридор от, МГц
          <input value={f1} onChange={(e) => setField("sdrF1", e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Коридор до, МГц
          <input value={f2} onChange={(e) => setField("sdrF2", e.target.value)} inputMode="decimal" />
        </label>
        <label title="Сколько секунд плата бьёт по таблице, потом компьютер снова сканирует коридор.">
          Удар, с
          <input value={jamS} onChange={(e) => setJamS(e.target.value)} inputMode="decimal" />
        </label>
        <label title="Пауза передачи на время смены стоянки, наносекунды.">
          Пауза retune, нс
          <input value={muteNs} onChange={(e) => setMuteNs(e.target.value)} inputMode="numeric" />
        </label>
        <label>
          LNA, дБ
          <input value={lnaDb} onChange={(e) => setLnaDb(e.target.value)} inputMode="decimal" />
        </label>
        <label>
          Окно RX, МГц
          <input value={String(RX_WINDOW_MHZ)} readOnly />
        </label>
        <label>
          Retune, мкс
          <input value="нет замера" readOnly />
        </label>
      </div>
    </section>
  );
}
