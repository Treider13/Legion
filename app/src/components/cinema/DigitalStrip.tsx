import {
  DIGITAL_HOP_DWELL_US,
  DIGITAL_MAX_CORRIDOR_MHZ,
  DIGITAL_PRESETS,
  DIGITAL_PRESET_IDS,
  DIGITAL_PROFILE_WIDTHS_MHZ,
  autoTuneDigital,
  digitalTuneLine,
  walkLabelRu,
  waveLabelRu,
  type DigitalCorridor,
  type DigitalPresetId,
  type DigitalWalk,
  type DigitalWave,
} from "../../sense/digitalMode";
import { DIGITAL_MODE_RU, isDigitalPattern } from "../../sense/modes";
import { TxGainControl } from "../TxGainControl";
import { useLegion } from "../../state/store";

export function DigitalFields() {
  const corridors = useLegion((s) => s.digitalCorridors);
  const walk = useLegion((s) => s.digitalWalk);
  const wave = useLegion((s) => s.digitalWave);
  const staticIndex = useLegion((s) => s.digitalStaticIndex);
  const chirpDir = useLegion((s) => s.digitalChirpDir);
  const sawUs = useLegion((s) => s.digitalSawPeriodUs);
  const amp = useLegion((s) => s.digitalAmp);
  const toneMhz = useLegion((s) => s.digitalToneWidthMhz);
  const preset = useLegion((s) => s.digitalPreset);
  const profileMhz = useLegion((s) => s.digitalProfileMhz);
  const dwellMs = useLegion((s) => s.digitalDwellMs);
  const hopUs = useLegion((s) => s.digitalHopDwellUs);
  const setCorridors = useLegion((s) => s.setDigitalCorridors);
  const setWalk = useLegion((s) => s.setDigitalWalk);
  const setWave = useLegion((s) => s.setDigitalWave);
  const setStatic = useLegion((s) => s.setDigitalStaticIndex);
  const setChirp = useLegion((s) => s.setDigitalChirpDir);
  const setSaw = useLegion((s) => s.setDigitalSawPeriodUs);
  const setAmp = useLegion((s) => s.setDigitalAmp);
  const setTone = useLegion((s) => s.setDigitalToneWidthMhz);
  const setPreset = useLegion((s) => s.setDigitalPreset);
  const setProfileMhz = useLegion((s) => s.setDigitalProfileMhz);
  const setDwellMs = useLegion((s) => s.setDigitalDwellMs);
  const setHopUs = useLegion((s) => s.setDigitalHopDwellUs);
  const f1 = useLegion((s) => s.sdrF1);
  const f2 = useLegion((s) => s.sdrF2);
  const rows = corridors.length
    ? corridors
    : [{
        startMhz: parseFloat(String(f1).replace(",", ".")) || 2400,
        endMhz: Math.min(
          (parseFloat(String(f1).replace(",", ".")) || 2400) + DIGITAL_MAX_CORRIDOR_MHZ,
          parseFloat(String(f2).replace(",", ".")) || 2456,
        ),
        priority: 1,
      }];
  const tune = autoTuneDigital(rows, dwellMs, profileMhz, hopUs);

  const pickPreset = (id: DigitalPresetId) => {
    const spec = DIGITAL_PRESETS[id];
    setPreset(id);
    if (id !== "custom") {
      setProfileMhz(spec.profileMhz);
      setDwellMs(spec.dwellMs);
    }
  };

  const patch = (i: number, next: Partial<DigitalCorridor>) => {
    const copy = rows.map((r, k) => (k === i ? { ...r, ...next } : r));
    setCorridors(copy);
  };

  return (
    <div className="corr-grid" aria-label={DIGITAL_MODE_RU}>
      <label>
        ПРОФИЛЬ
        <select
          aria-label="Профиль подавления"
          value={preset}
          onChange={(e) => pickPreset(e.target.value as DigitalPresetId)}
        >
          {DIGITAL_PRESET_IDS.map((id) => (
            <option key={id} value={id}>{DIGITAL_PRESETS[id].label}</option>
          ))}
        </select>
      </label>
      <label>
        ШИРИНА ОКНА, МГц
        <select
          aria-label="Ширина профиля цифрового"
          value={String(profileMhz)}
          onChange={(e) => {
            setPreset("custom");
            setProfileMhz(parseFloat(e.target.value));
          }}
        >
          {DIGITAL_PROFILE_WIDTHS_MHZ.map((w) => (
            <option key={w} value={String(w)}>{w}</option>
          ))}
        </select>
      </label>
      {preset === "custom" ? (
        <label>
          DWELL, мс
          <input
            aria-label="Dwell пользовательский"
            value={String(dwellMs)}
            onChange={(e) => setDwellMs(parseFloat(e.target.value.replace(",", ".")))}
            inputMode="decimal"
          />
        </label>
      ) : null}
      <label>
        СТОЯНКА, мкс
        <input
          aria-label="Стоянка цифрового"
          value={String(hopUs)}
          onChange={(e) => setHopUs(parseFloat(e.target.value.replace(",", ".")))}
          inputMode="numeric"
        />
      </label>
      {rows.map((row, i) => (
        <div key={`d-c-${i}`} className="corr-grid">
          <label>
            ОТ, МГц
            <input
              aria-label={`Коридор ${i + 1} начало`}
              value={String(row.startMhz)}
              onChange={(e) => patch(i, { startMhz: parseFloat(e.target.value.replace(",", ".")) })}
              inputMode="decimal"
            />
          </label>
          <label>
            ДО, МГц
            <input
              aria-label={`Коридор ${i + 1} конец`}
              value={String(row.endMhz)}
              onChange={(e) => patch(i, { endMhz: parseFloat(e.target.value.replace(",", ".")) })}
              inputMode="decimal"
            />
          </label>
          <label>
            ПРИОРИТЕТ
            <input
              aria-label={`Коридор ${i + 1} приоритет`}
              value={String(row.priority)}
              onChange={(e) => patch(i, { priority: parseFloat(e.target.value.replace(",", ".")) })}
              inputMode="decimal"
            />
          </label>
        </div>
      ))}
      <button
        type="button"
        className="cinema-btn ghost"
        onClick={() => {
          const last = rows[rows.length - 1];
          setCorridors([
            ...rows,
            {
              startMhz: last.endMhz,
              endMhz: last.endMhz + DIGITAL_MAX_CORRIDOR_MHZ,
              priority: 1,
            },
          ]);
        }}
      >
        Ещё коридор
      </button>
      {rows.length > 1 ? (
        <button type="button" className="cinema-btn ghost" onClick={() => setCorridors(rows.slice(0, -1))}>
          Убрать последний
        </button>
      ) : null}
      <label>
        ОБХОД
        <select
          aria-label="Режим обхода цифрового"
          value={walk}
          onChange={(e) => setWalk(e.target.value as DigitalWalk)}
        >
          <option value="sequential">{walkLabelRu("sequential")}</option>
          <option value="random">{walkLabelRu("random")}</option>
          <option value="static">{walkLabelRu("static")}</option>
        </select>
      </label>
      {walk === "static" ? (
        <label>
          КОРИДОР
          <input
            aria-label="Номер статичного коридора"
            value={String(staticIndex)}
            onChange={(e) => setStatic(parseFloat(e.target.value) || 0)}
            inputMode="numeric"
          />
        </label>
      ) : null}
      <label>
        СИГНАЛ
        <select
          aria-label="Тип сигнала цифрового"
          value={wave}
          onChange={(e) => setWave(e.target.value as DigitalWave)}
        >
          <option value="saw">{waveLabelRu("saw")}</option>
          <option value="chirp">{waveLabelRu("chirp")}</option>
          <option value="noise">{waveLabelRu("noise")}</option>
          <option value="tone">{waveLabelRu("tone")}</option>
          <option value="fm">{waveLabelRu("fm")}</option>
        </select>
      </label>
      {wave === "chirp" ? (
        <label>
          ЧИРП
          <select
            aria-label="Направление чирпа"
            value={chirpDir}
            onChange={(e) => setChirp(e.target.value === "down" ? "down" : "up")}
          >
            <option value="up">вверх</option>
            <option value="down">вниз</option>
          </select>
        </label>
      ) : null}
      {wave === "saw" ? (
        <label>
          ПЕРИОД ПИЛЫ, мкс
          <input
            aria-label="Период пилы"
            value={String(sawUs)}
            onChange={(e) => setSaw(parseFloat(e.target.value.replace(",", ".")))}
            inputMode="decimal"
          />
        </label>
      ) : null}
      {wave === "tone" ? (
        <label>
          ШИРИНА ТОНА, МГц
          <input
            aria-label="Ширина тона"
            value={String(toneMhz)}
            onChange={(e) => setTone(parseFloat(e.target.value.replace(",", ".")))}
            inputMode="decimal"
          />
        </label>
      ) : null}
      <label>
        АМПЛИТУДА
        <input
          aria-label="Амплитуда цифрового"
          value={String(amp)}
          onChange={(e) => setAmp(parseFloat(e.target.value.replace(",", ".")))}
          inputMode="decimal"
        />
      </label>
      <p className="panel-note">
        {DIGITAL_PRESETS[preset].label}. {digitalTuneLine(tune)}.
        Стоянка по умолчанию {DIGITAL_HOP_DWELL_US} мкс (PLL ~20 мкс). Амплитуда 0.1…0.9 (потолок ЦАП).
        Случайный: коридор ∝ приоритет, внутри равномерно.
        Перекрытие схлопывается (остаётся больший приоритет).
        Журнал: шаг, очередь, срыв USB. Стоп снимает очередь и TX.
        Смена сигнала — стоп и старт.
      </p>
    </div>
  );
}

export function DigitalStrip() {
  const pattern = useLegion((s) => s.scanPattern);
  if (!isDigitalPattern(pattern)) return null;
  return (
    <section className="smart-attack-strip" aria-label={DIGITAL_MODE_RU}>
      <p>Профиль подавления. Старт ставит очередь retune и волну. Стоп снимает очередь и TX.</p>
      <TxGainControl tone="cinema" />
      <DigitalFields />
    </section>
  );
}
