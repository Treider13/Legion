import { useEffect, useMemo, useRef, useState } from "react";
import { computePosition } from "../sense/position/compute";
import { formatDeg } from "../sense/position/geo";
import { parseDemJson, parsePathMarks, parseSrtmHgt, sampleDem, swCornerFromHgtName } from "../sense/position/terrain";
import type { AntennaKind, DemGrid, PositionInput, PositionResult, ProfileSample, VerdictKind } from "../sense/position/types";
import { loadUkraineDem } from "../sense/position/ukraineDem";
import "./position.css";

const KINDS: Array<{ id: AntennaKind; title: string }> = [
  { id: "whip", title: "Штырь" },
  { id: "patch", title: "Патч" },
  { id: "dish", title: "Тарелка" },
  { id: "yagi", title: "Волновой канал" },
];

function num(text: string): number {
  const v = Number(text.trim().replace(",", "."));
  return Number.isFinite(v) ? v : Number.NaN;
}

function optionalNum(text: string): number | null {
  if (text.trim() === "") return null;
  const v = num(text);
  return Number.isFinite(v) ? v : null;
}

export function PositionPanel() {
  const [ourLat, setOurLat] = useState("");
  const [ourLon, setOurLon] = useState("");
  const [ourGround, setOurGround] = useState("");
  const [ourAgl, setOurAgl] = useState("0");
  const [oppLat, setOppLat] = useState("");
  const [oppLon, setOppLon] = useState("");
  const [oppGround, setOppGround] = useState("");
  const [oppAgl, setOppAgl] = useState("0");
  const [freq, setFreq] = useState("2400");
  const [ourKind, setOurKind] = useState<AntennaKind>("patch");
  const [ourDbi, setOurDbi] = useState("19");
  const [oppKind, setOppKind] = useState<AntennaKind>("patch");
  const [oppDbi, setOppDbi] = useState("21");
  const [ourAimAz, setOurAimAz] = useState("");
  const [ourAimEl, setOurAimEl] = useState("");
  const [oppAimAz, setOppAimAz] = useState("");
  const [oppAimEl, setOppAimEl] = useState("");
  const [powerW, setPowerW] = useState("1");
  const [threshold, setThreshold] = useState("-90");
  const [marksText, setMarksText] = useState("");
  const [flat, setFlat] = useState(false);
  const [flatM, setFlatM] = useState("");
  const [cellM, setCellM] = useState("");
  const [clutter, setClutter] = useState(false);
  const [rain, setRain] = useState("");
  const [grid, setGrid] = useState<DemGrid | null>(null);
  const [ukraine, setUkraine] = useState<DemGrid | null>(null);
  const [pending, setPending] = useState(true);
  const [fileNote, setFileNote] = useState("Свой файл не выбран. Берём рельеф Украины из памяти.");
  const fileGen = useRef(0);

  const activeGrid = grid ?? ukraine;
  const ourMapH = activeGrid ? sampleDem(activeGrid, num(ourLat), num(ourLon)) : null;
  const oppMapH = activeGrid ? sampleDem(activeGrid, num(oppLat), num(oppLon)) : null;

  const input = useMemo<PositionInput>(() => ({
    ourLat: num(ourLat),
    ourLon: num(ourLon),
    ourGroundM: num(ourGround),
    ourAglM: num(ourAgl),
    oppLat: num(oppLat),
    oppLon: num(oppLon),
    oppGroundM: num(oppGround),
    oppAglM: num(oppAgl),
    freqMhz: num(freq),
    ourKind,
    ourDbi: num(ourDbi),
    oppKind,
    oppDbi: num(oppDbi),
    ourAimAzDeg: optionalNum(ourAimAz),
    ourAimElDeg: optionalNum(ourAimEl),
    oppAimAzDeg: optionalNum(oppAimAz),
    oppAimElDeg: optionalNum(oppAimEl),
    powerW: optionalNum(powerW),
    thresholdDbm: optionalNum(threshold),
    marks: flat ? [] : parsePathMarks(marksText),
    flatM: flat ? num(flatM) : null,
    grid: activeGrid,
    cellM: optionalNum(cellM),
    clutter,
    rainMmH: optionalNum(rain),
    terrainPending: pending && grid == null,
  }), [ourLat, ourLon, ourGround, ourAgl, oppLat, oppLon, oppGround, oppAgl, freq, ourKind, ourDbi, oppKind, oppDbi, ourAimAz, ourAimEl, oppAimAz, oppAimEl, powerW, threshold, marksText, flat, flatM, cellM, clutter, rain, activeGrid, pending, grid]);

  const result = useMemo(() => computePosition(input), [input]);
  const profileRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    drawProfile(profileRef.current, result);
  }, [result]);

  useEffect(() => {
    drawMap(mapRef.current, result);
  }, [result]);

  useEffect(() => {
    let live = true;
    loadUkraineDem().then(
      (dem) => {
        if (live) {
          setUkraine(dem);
          setPending(false);
        }
      },
      () => {
        if (live) {
          setPending(false);
          setFileNote("Рельеф Украины не прочитался.");
        }
      },
    );
    return () => {
      live = false;
    };
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const gen = ++fileGen.current;
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".json")) {
      const parsed = parseDemJson(await file.text());
      if (gen !== fileGen.current) return;
      if (!parsed) {
        setFileNote("JSON рельефа не разобран. Нужны lat0, lon0, nlat, nlon, dlat, dlon, heights.");
        setGrid(null);
        return;
      }
      setGrid(parsed);
      setFileNote(`Свой файл ${parsed.nlat}×${parsed.nlon}, шаг около ${parsed.cellM.toFixed(0)} м. Сеть не используется.`);
      return;
    }
    const corner = swCornerFromHgtName(file.name);
    if (!corner) {
      if (gen !== fileGen.current) return;
      setFileNote("Для .hgt имя файла должно содержать угол, например N55E037.");
      setGrid(null);
      return;
    }
    const parsed = parseSrtmHgt(await file.arrayBuffer(), corner.lat, corner.lon);
    if (gen !== fileGen.current) return;
    if (!parsed) {
      setFileNote("Файл .hgt не 1201 и не 3601.");
      setGrid(null);
      return;
    }
    setGrid(parsed);
    setFileNote(`SRTM ${file.name}, шаг около ${parsed.cellM.toFixed(0)} м. Читается с диска, без сети.`);
  };

  const blurDeg = (text: string, set: (value: string) => void) => {
    const value = num(text);
    if (Number.isFinite(value)) set(value.toFixed(6));
  };

  const frame = ukraine
    ? `В памяти рельеф от ${ukraine.lat0.toFixed(1)}° до ${(ukraine.lat0 + (ukraine.nlat - 1) * ukraine.dlat).toFixed(1)}° северной широты и от ${ukraine.lon0.toFixed(1)}° до ${(ukraine.lon0 + (ukraine.nlon - 1) * ukraine.dlon).toFixed(1)}° восточной долготы. Шаг около ${ukraine.cellM.toFixed(0)} м. Вся Украина внутри этой рамки.`
    : pending
      ? "Рельеф Украины ещё читается."
      : "Рельеф Украины не в памяти.";

  return (
    <section className="panel">
      <span className="panel-title">ПОЗИЦИЯ // ДОЙДЁТ ЛИ СИГНАЛ ДО СТАНЦИИ ПРОТИВНИКА</span>
      <p className="panel-note">
        Считает на этом компьютере. Интернет не нужен. Широта и долгота — в градусах, как на карте.
        Если антенна противника смотрит не на нас, берём боковой лепесток: станция может стоять сбоку, и сигнал всё равно ловится.
        Передатчик отсюда не включается.
      </p>
      <p className="panel-note">{frame}</p>
      <div className="pos-wrap">
        <div className="pos-fields">
          <label>Наша широта, градусы<input value={ourLat} placeholder="50.450100" onChange={(e) => setOurLat(e.target.value)} onBlur={() => blurDeg(ourLat, setOurLat)} /></label>
          <label>Наша долгота, градусы<input value={ourLon} placeholder="30.523400" onChange={(e) => setOurLon(e.target.value)} onBlur={() => blurDeg(ourLon, setOurLon)} /></label>
          <label>Земля под нами, м<input value={ourMapH == null ? ourGround : ourMapH.toFixed(0)} disabled={ourMapH != null} onChange={(e) => setOurGround(e.target.value)} /></label>
          <label>Наша антенна над землёй, м<input value={ourAgl} onChange={(e) => setOurAgl(e.target.value)} /></label>
          <label>Широта станции, градусы<input value={oppLat} placeholder="48.160300" onChange={(e) => setOppLat(e.target.value)} onBlur={() => blurDeg(oppLat, setOppLat)} /></label>
          <label>Долгота станции, градусы<input value={oppLon} placeholder="24.500000" onChange={(e) => setOppLon(e.target.value)} onBlur={() => blurDeg(oppLon, setOppLon)} /></label>
          <label>Земля под станцией, м<input value={oppMapH == null ? oppGround : oppMapH.toFixed(0)} disabled={oppMapH != null} onChange={(e) => setOppGround(e.target.value)} /></label>
          <label>Антенна противника над землёй, м<input value={oppAgl} onChange={(e) => setOppAgl(e.target.value)} /></label>
          <label>Частота, МГц<input value={freq} onChange={(e) => setFreq(e.target.value)} /></label>
          <label>Мощность противника, Вт<input value={powerW} onChange={(e) => setPowerW(e.target.value)} /></label>
          <label>Наша антенна
            <select value={ourKind} onChange={(e) => setOurKind(e.target.value as AntennaKind)}>
              {KINDS.map((k) => <option key={k.id} value={k.id}>{k.title}</option>)}
            </select>
          </label>
          <label>Наша, дБи<input value={ourDbi} onChange={(e) => setOurDbi(e.target.value)} /></label>
          <label>Антенна противника
            <select value={oppKind} onChange={(e) => setOppKind(e.target.value as AntennaKind)}>
              {KINDS.map((k) => <option key={k.id} value={k.id}>{k.title}</option>)}
            </select>
          </label>
          <label>Противник, дБи<input value={oppDbi} onChange={(e) => setOppDbi(e.target.value)} /></label>
          <label>Куда смотрит наша, °<input value={ourAimAz} placeholder="пусто — повернём" onChange={(e) => setOurAimAz(e.target.value)} /></label>
          <label>Наклон нашей, °<input value={ourAimEl} placeholder="пусто — ровно" onChange={(e) => setOurAimEl(e.target.value)} /></label>
          <label>Куда смотрит противник, °<input value={oppAimAz} placeholder="пусто — сбоку" onChange={(e) => setOppAimAz(e.target.value)} /></label>
          <label>Наклон противника, °<input value={oppAimEl} placeholder="пусто — сбоку" onChange={(e) => setOppAimEl(e.target.value)} /></label>
          <label className="pos-wide">Порог приёмника, дБм<input value={threshold} onChange={(e) => setThreshold(e.target.value)} /></label>
          <label className="pos-check">
            <input type="checkbox" checked={flat} onChange={(e) => setFlat(e.target.checked)} />
            Земля ровная
          </label>
          {flat && <label className="pos-wide">Отметка ровной земли, м<input value={flatM} onChange={(e) => setFlatM(e.target.value)} /></label>}
          {!flat && (
            <label className="pos-wide">Отметки по пути, км и метры
              <textarea value={marksText} onChange={(e) => setMarksText(e.target.value)} spellCheck={false} />
            </label>
          )}
          <label>Шаг карты, м<input value={cellM} onChange={(e) => setCellM(e.target.value)} placeholder="для файла можно пусто" /></label>
          <label>Дождь, мм/ч<input value={rain} onChange={(e) => setRain(e.target.value)} placeholder="пусто — сухой ответ" /></label>
          <label className="pos-check">
            <input type="checkbox" checked={clutter} onChange={(e) => setClutter(e.target.checked)} />
            По пути лес или дома
          </label>
          <label className="pos-wide">Файл рельефа, JSON или SRTM .hgt
            <input type="file" accept=".json,.hgt,application/json" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <p className="panel-note pos-wide">{fileNote}</p>
          {grid && (
            <button type="button" className="btn-ghost pos-wide" onClick={() => { fileGen.current += 1; setGrid(null); setFileNote("Свой файл снят. Снова рельеф Украины из памяти."); }}>
              Снять свой файл
            </button>
          )}
        </div>
        <div>
          <p className={`pos-verdict ${result.verdict}`}>{phraseTitle(result.verdict)}</p>
          <p className="pos-action">{result.phrase} {result.action}</p>
          {result.side && <p className="panel-note">{result.side}</p>}
          {result.rx1 && <p className="panel-note">{result.rx1}</p>}
          <div className="pos-meta">
            <span>Дальность {result.distanceKm.toFixed(2)} км</span>
            <span>Азимут {result.azimuthDeg.toFixed(1)}°</span>
            <span>Наклон {result.elevationDeg.toFixed(1)}°</span>
            {Number.isFinite(num(ourLat)) && Number.isFinite(num(oppLat)) && (
              <span>Градусы {formatDeg(num(ourLat))} {formatDeg(num(ourLon))} → {formatDeg(num(oppLat))} {formatDeg(num(oppLon))}</span>
            )}
            <span>{result.beamwidthDeg == null ? "Луч круговой" : `Луч около ${result.beamwidthDeg.toFixed(0)}°`}</span>
            <span>Потери без земли {result.fsplDb.toFixed(1)} дБ</span>
            <span>Потеря на холме {result.diffractionDb.toFixed(1)} дБ</span>
            <span>Поглощение в воздухе {result.gasDb.toFixed(1)} дБ</span>
            <span>{result.rainDb == null ? "Дождь не задан" : `Дождь ${result.rainDb.toFixed(1)} дБ, в сухой ответ не входит`}</span>
            <span>{result.marginDb == null || result.verdict === "closed" ? "Запас здесь не смотрим" : `Запас ${result.marginDb.toFixed(1)} дБ`}</span>
            <span>Мачта до нормы {result.raiseNormM.toFixed(0)} м</span>
          </div>
          <canvas ref={profileRef} className="pos-canvas" width={900} height={420} />
          <div className="pos-legend">
            <span><i style={{ background: "#c4a574" }} />земля</span>
            <span><i style={{ background: "#5eead4" }} />радиолуч</span>
            <span><i style={{ background: "rgba(94,234,212,0.45)" }} />полоса луча</span>
          </div>
          {result.map && result.map.length > 0 && (
            <>
              <p className="panel-note" style={{ marginTop: 12 }}>Карта вокруг нас. Станция может стоять и сбоку. Зелёное — доходит, жёлтое — мешает земля, красное — не доходит.</p>
              <canvas ref={mapRef} className="pos-canvas" width={900} height={420} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function phraseTitle(kind: VerdictKind): string {
  if (kind === "open") return "ДОХОДИТ";
  if (kind === "ridge") return "МЕШАЕТ ЗЕМЛЯ";
  if (kind === "closed") return "НЕ ДОХОДИТ";
  return "МАЛО ДАННЫХ";
}

function drawProfile(canvas: HTMLCanvasElement | null, result: PositionResult) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const samples = result.profile;
  if (samples.length < 2) {
    ctx.fillStyle = "#8b93a7";
    ctx.font = "16px sans-serif";
    ctx.fillText("Нет разреза", 24, 40);
    return;
  }
  const pad = 36;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const s of samples) {
    minY = Math.min(minY, s.terrainM, s.rayM - s.fresnelM);
    maxY = Math.max(maxY, s.terrainM, s.rayM + s.fresnelM);
  }
  if (maxY - minY < 10) {
    minY -= 5;
    maxY += 5;
  }
  const xOf = (km: number) => pad + (km / result.distanceKm) * (w - pad * 2);
  const yOf = (m: number) => h - pad - ((m - minY) / (maxY - minY)) * (h - pad * 2);
  const line = (pick: (s: ProfileSample) => number, color: string, width: number) => {
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = xOf(s.km);
      const y = yOf(pick(s));
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  ctx.beginPath();
  samples.forEach((s, i) => {
    const x = xOf(s.km);
    const y = yOf(s.rayM + s.fresnelM);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let i = samples.length - 1; i >= 0; i--) {
    ctx.lineTo(xOf(samples[i].km), yOf(samples[i].rayM - samples[i].fresnelM));
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(94, 234, 212, 0.16)";
  ctx.fill();
  line((s) => s.terrainM, "#c4a574", 2);
  line((s) => s.rayM, "#5eead4", 2);
  ctx.fillStyle = "#8b93a7";
  ctx.font = "14px sans-serif";
  ctx.fillText("0", pad, h - 12);
  ctx.fillText(`${result.distanceKm.toFixed(1)} км`, w - pad - 70, h - 12);
  ctx.fillText(`${maxY.toFixed(0)} м`, 8, pad);
  ctx.fillText(`${minY.toFixed(0)} м`, 8, h - pad);
}

function drawMap(canvas: HTMLCanvasElement | null, result: PositionResult) {
  if (!canvas || !result.map || result.map.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const maxKm = Math.max(...result.map.map((c) => c.km), 1);
  const scale = (Math.min(w, h) / 2 - 28) / maxKm;
  const color: Record<VerdictKind, string> = {
    open: "#2dd4bf",
    ridge: "#f5d061",
    closed: "#ff6b73",
    insufficient: "#5c6570",
  };
  for (const cell of result.map) {
    const rad = ((cell.azimuthDeg - 90) * Math.PI) / 180;
    const x = cx + Math.cos(rad) * cell.km * scale;
    const y = cy + Math.sin(rad) * cell.km * scale;
    ctx.fillStyle = color[cell.verdict];
    ctx.fillRect(x - 4, y - 4, 8, 8);
  }
  ctx.fillStyle = "#e8eefc";
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.fill();
}
