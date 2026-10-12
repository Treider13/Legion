// Настройки умной атаки по связке ПК → таблица в FPGA → удар платы.
// Коридор и время удара задаёт оператор. Прыжки, паттерн и загрузку LUT
// компьютер считает сам. Плата шагает по таблице без команды на каждый прыжок.
import { useEffect, useState } from "react";

import { isFpgaAirPattern } from "../../sense/modes";
import {
  loadRx,
  paintRxSpectrum,
  replayArmedNow,
  rxCaptures,
  rxFields,
  rxStatus,
  setReplayArmed,
  startRx,
  stopRx,
  subscribeRx,
} from "../../sense/rxTest";
import { useLegion } from "../../state/store";

const RX_WINDOW_MHZ = 34;

export function SmartAttackStrip() {
  const pattern = useLegion((s) => s.scanPattern);
  const f1 = useLegion((s) => s.sdrF1);
  const f2 = useLegion((s) => s.sdrF2);
  const setField = useLegion((s) => s.setSdrAllowField);
  const [jamS, setJamS] = useState(String(rxFields.jam));
  const [muteNs, setMuteNs] = useState(String(rxFields.mute));
  const [lnaDb, setLnaDb] = useState(String(rxFields.lna));
  const [note, setNote] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [picked, setPicked] = useState("");
  const [watching, setWatching] = useState(false);

  useEffect(() => {
    const jam = parseFloat(jamS.replace(",", "."));
    const mute = parseInt(muteNs, 10);
    const lna = parseFloat(lnaDb.replace(",", "."));
    if (Number.isFinite(jam)) rxFields.jam = jam;
    if (Number.isFinite(mute)) rxFields.mute = mute;
    if (Number.isFinite(lna)) rxFields.lna = lna;
  }, [jamS, muteNs, lnaDb]);

  useEffect(() => subscribeRx(() => setWatching(true)), []);

  useEffect(() => {
    if (!isFpgaAirPattern(pattern)) return;
    void rxCaptures().then((list) => {
      setFiles(list);
      setPicked((cur) => cur || list[0] || "");
    });
  }, [pattern]);

  useEffect(() => {
    if (!watching) return;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      const st = await rxStatus();
      if (stop || !st) return;
      if (st.line) {
        paintRxSpectrum(st.line);
        try {
          const msg = JSON.parse(st.line) as { note?: string; file?: string | null; left_s?: number | null };
          const left = msg.left_s != null ? ` · ${Math.ceil(msg.left_s)} с` : "";
          const file = msg.file ? ` · ${msg.file}` : "";
          if (msg.note || msg.file) setNote(`${msg.note || "разбор"}${left}${file}`);
        } catch {
          /* ждём целую строку */
        }
      }
      if (!st.running) {
        if (st.err && !st.line) setNote(st.err.trim());
        setWatching(false);
        const list = await rxCaptures();
        setFiles(list);
        if (list[0]) setPicked(list[0]);
        return;
      }
      window.setTimeout(tick, 400);
    };
    void tick();
    return () => {
      stop = true;
    };
  }, [watching]);

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
      <div className="smart-attack-actions">
        <button
          type="button"
          className="cinema-btn solid"
          onClick={() => {
            setReplayArmed(false);
            setNote("тест идёт — включи ELRS рядом");
            void startRx(false).catch((e) => {
              setWatching(false);
              setNote(String(e));
            });
          }}
        >
          Тест
        </button>
        <button
          type="button"
          className="cinema-btn ghost"
          disabled={!picked}
          onClick={() => {
            void loadRx(picked).then(setNote).catch((e) => setNote(String(e)));
          }}
        >
          Загрузить
        </button>
        <select aria-label="Файл теста" value={picked} onChange={(e) => setPicked(e.target.value)}>
          {files.length === 0 ? <option value="">нет файлов</option> : null}
          {files.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        {watching ? (
          <button type="button" className="cinema-btn ghost" onClick={() => void stopRx()}>
            Стоп
          </button>
        ) : null}
      </div>
      {note ? <p>{note}{replayArmedNow() && !watching ? " Дальше Запустить бьёт по этому логу." : ""}</p> : null}
    </section>
  );
}
