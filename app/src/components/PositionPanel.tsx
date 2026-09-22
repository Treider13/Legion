import { Component, lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { computePosition, searchSquare } from "../sense/position/compute";
import { degreeFrame, formatDeg, xyOfDegree } from "../sense/position/geo";
import { parseDemJson, parsePathMarks, parseSrtmHgt, sampleDem, swCornerFromHgtName } from "../sense/position/terrain";
import type { AntennaKind, DemGrid, PositionInput, PositionResult, ProfileSample, SitePick, VerdictKind } from "../sense/position/types";
import { loadUkraineDem } from "../sense/position/ukraineDem";
import "./position.css";
import "./position/positionMap.css";

const PositionMap = lazy(() => import("./position/PositionMap"));

class PositionMapBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return <div className="pos-stage pos-stage-wait">Карта не открылась. Разрез и счёт ниже на месте.</div>;
    }
    return this.props.children;
  }
}

function finitePoint(lat: string, lon: string): { lat: number; lon: number } | null {
  if (lat.trim() === "" || lon.trim() === "") return null;
  const la = num(lat);
  const lo = num(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) return null;
  return { lat: la, lon: lo };
}

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
  const [boxSouth, setBoxSouth] = useState("");
  const [boxNorth, setBoxNorth] = useState("");
  const [boxWest, setBoxWest] = useState("");
  const [boxEast, setBoxEast] = useState("");
  const [searchNote, setSearchNote] = useState("");
  const [picks, setPicks] = useState<SitePick[]>([]);
  const [searching, setSearching] = useState(false);
  const fileGen = useRef(0);
  const searchGen = useRef(0);

  const activeGrid = grid ?? ukraine;
  const ourMapH = activeGrid ? sampleDem(activeGrid, num(ourLat), num(ourLon)) : null;
  const oppMapH = activeGrid ? sampleDem(activeGrid, num(oppLat), num(oppLon)) : null;

  const input = useMemo<PositionInput>(() => ({
    ourLat: num(ourLat),
    ourLon: num(ourLon),
    ourGroundM: ourMapH ?? num(ourGround),
    ourAglM: num(ourAgl),
    oppLat: num(oppLat),
    oppLon: num(oppLon),
    oppGroundM: oppMapH ?? num(oppGround),
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
  }), [ourLat, ourLon, ourGround, ourMapH, ourAgl, oppLat, oppLon, oppGround, oppMapH, oppAgl, freq, ourKind, ourDbi, oppKind, oppDbi, ourAimAz, ourAimEl, oppAimAz, oppAimEl, powerW, threshold, marksText, flat, flatM, cellM, clutter, rain, activeGrid, pending, grid]);

  const result = useMemo(() => computePosition(input), [input]);
  const profileRef = useRef<HTMLCanvasElement>(null);
  const mapRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    drawProfile(profileRef.current, result);
  }, [result]);

  const searchBox = useMemo(() => {
    const south = num(boxSouth);
    const north = num(boxNorth);
    const west = num(boxWest);
    const east = num(boxEast);
    if (![south, north, west, east].every(Number.isFinite) || south >= north || west >= east) return null;
    return { south, north, west, east };
  }, [boxSouth, boxNorth, boxWest, boxEast]);

  useEffect(() => {
    drawMap(mapRef.current, result, input, searchBox, picks);
  }, [result, input, searchBox, picks]);

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
        if (!live) return;
        setPending(false);
        if (fileGen.current === 0) setFileNote("Рельеф Украины не прочитался.");
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
        Счёт на этом компьютере, сеть ему не нужна. Карта ниже берёт снимок и подписи по сети. Холмы в режиме 3D — из этого же файла высот. Широта и долгота — в градусах, как на карте.
        Сначала поставьте свою точку и точку противника. Квадрат ниже ищет, куда встать вместо нашей точки, и сам её не переносит.
        Укажите, в какую сторону противник смотрит на свой борт. Передатчик отсюда не включается.
      </p>
      <p className="panel-note">{frame}</p>
      <PositionMapBoundary>
        <Suspense fallback={<div className="pos-stage pos-stage-wait">Карта открывается…</div>}>
          <PositionMap
            our={finitePoint(ourLat, ourLon)}
            opp={finitePoint(oppLat, oppLon)}
            cells={result.map}
            box={searchBox}
            picks={picks}
            grid={activeGrid}
          />
        </Suspense>
      </PositionMapBoundary>
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
          <label>Куда смотрит противник, °<input value={oppAimAz} placeholder="сторона их борта" onChange={(e) => setOppAimAz(e.target.value)} /></label>
          <label>Наклон противника, °<input value={oppAimEl} placeholder="пусто — в горизонт" onChange={(e) => setOppAimEl(e.target.value)} /></label>
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
          <label>Квадрат, юг °<input value={boxSouth} placeholder="южная широта" onChange={(e) => setBoxSouth(e.target.value)} onBlur={() => blurDeg(boxSouth, setBoxSouth)} /></label>
          <label>Квадрат, север °<input value={boxNorth} placeholder="северная широта" onChange={(e) => setBoxNorth(e.target.value)} onBlur={() => blurDeg(boxNorth, setBoxNorth)} /></label>
          <label>Квадрат, запад °<input value={boxWest} placeholder="западная долгота" onChange={(e) => setBoxWest(e.target.value)} onBlur={() => blurDeg(boxWest, setBoxWest)} /></label>
          <label>Квадрат, восток °<input value={boxEast} placeholder="восточная долгота" onChange={(e) => setBoxEast(e.target.value)} onBlur={() => blurDeg(boxEast, setBoxEast)} /></label>
          <button type="button" className="btn-ghost pos-wide" disabled={searching} onClick={() => {
            const gen = ++searchGen.current;
            setSearching(true);
            setSearchNote("Ищем в квадрате…");
            setPicks([]);
            const snapshot = input;
            window.setTimeout(() => {
              if (gen !== searchGen.current) return;
              const found = searchSquare(snapshot, {
                south: num(boxSouth),
                north: num(boxNorth),
                west: num(boxWest),
                east: num(boxEast),
              });
              if (gen !== searchGen.current) return;
              setPicks(found.picks);
              setSearchNote(found.note);
              setSearching(false);
            }, 0);
          }}>
            Искать в квадрате
          </button>
          {searchNote && <p className="panel-note pos-wide">{searchNote}</p>}
          {picks.map((pick) => (
            <button
              key={`${pick.lat.toFixed(5)}-${pick.lon.toFixed(5)}`}
              type="button"
              className="btn-ghost pos-wide"
              onClick={() => {
                setOurLat(pick.lat.toFixed(6));
                setOurLon(pick.lon.toFixed(6));
              }}
            >
              {pick.phrase} {formatDeg(pick.lat)} {formatDeg(pick.lon)}, земля {pick.groundM.toFixed(0)} м, {pick.distanceKm.toFixed(1)} км, запас {pick.marginDb.toFixed(0)} дБ.
            </button>
          ))}
          {grid && (
            <button type="button" className="btn-ghost pos-wide" onClick={() => { fileGen.current += 1; setGrid(null); setFileNote("Свой файл снят. Снова рельеф Украины из памяти."); }}>
              Снять свой файл
            </button>
          )}
        </div>
        <div>
          <p className={`pos-verdict ${result.verdict}`}>{phraseTitle(result.verdict)}</p>
          <p className="pos-action">{result.phrase} {result.action}</p>
          {result.aim && <p className="panel-note">{result.aim}</p>}
          {result.side && <p className="panel-note">{result.side}</p>}
          {result.rx1 && <p className="panel-note">{result.rx1}</p>}
          <div className="pos-meta">
            <span>Дальность {result.distanceKm.toFixed(2)} км</span>
            <span>Азимут {result.azimuthDeg.toFixed(1)}°</span>
            <span>Наклон {(Math.abs(result.elevationDeg) < 0.3 ? 0 : result.elevationDeg).toFixed(1)}°</span>
            {Number.isFinite(num(ourLat)) && Number.isFinite(num(oppLat)) && (
              <span>Градусы {formatDeg(num(ourLat))} {formatDeg(num(ourLon))} → {formatDeg(num(oppLat))} {formatDeg(num(oppLon))}</span>
            )}
            <span>{result.beamwidthDeg == null ? "Луч круговой" : `Луч около ${result.beamwidthDeg.toFixed(0)}°`}</span>
            <span>Потери без земли {result.fsplDb.toFixed(1)} дБ</span>
            <span>Потеря на холме {result.diffractionDb.toFixed(1)} дБ</span>
            <span>Поглощение в воздухе {result.gasDb.toFixed(1)} дБ</span>
            <span>{result.rainDb == null ? "Дождь не задан" : `Дождь ${result.rainDb.toFixed(1)} дБ, в сухой ответ не входит`}</span>
            <span>{result.marginDb == null || result.verdict === "closed" ? "Запас здесь не смотрим" : `Запас ${result.marginDb.toFixed(1)} дБ`}</span>
            <span>Для чистой трассы, не для слышимости: касание {result.raiseGrazeM.toFixed(0)} м, норма {result.raiseNormM.toFixed(0)} м, чистая {result.raiseCleanM.toFixed(0)} м</span>
          </div>
          <canvas ref={profileRef} className="pos-canvas" width={900} height={420} />
          <div className="pos-legend">
            <span><i style={{ background: "#c4a574" }} />земля</span>
            <span><i style={{ background: "#5eead4" }} />радиолуч</span>
            <span><i style={{ background: "rgba(94,234,212,0.45)" }} />полоса луча</span>
          </div>
          {result.map && result.map.length > 0 && (
            <>
              <p className="panel-note" style={{ marginTop: 12 }}>Карта в тех же градусах, что поля выше. Север сверху, шаг широты и долготы одинаковый. Зелёное — доходит, жёлтое — мешает земля, красное — не доходит. Место для нас ищется кнопкой в квадрате.</p>
              <canvas ref={mapRef} className="pos-canvas pos-map" width={900} height={420} />
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

function tickStep(span: number): number {
  if (!(span > 0)) return 1;
  const raw = span / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * pow;
}

function tickLabel(value: number, step: number): string {
  const digits = step >= 1 ? 0 : Math.min(4, Math.ceil(-Math.log10(step)));
  return `${value.toFixed(digits)}°`;
}

function drawMap(
  canvas: HTMLCanvasElement | null,
  result: PositionResult,
  input: PositionInput,
  box: { south: number; north: number; west: number; east: number } | null,
  picks: SitePick[],
) {
  if (!canvas || !result.map || result.map.length === 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const points = [
    ...result.map,
    { lat: input.ourLat, lon: input.ourLon },
    { lat: input.oppLat, lon: input.oppLon },
    ...picks,
  ];
  if (box) {
    points.push(
      { lat: box.south, lon: box.west },
      { lat: box.north, lon: box.east },
    );
  }
  const frame = degreeFrame(points, w, h, 46);
  if (!frame) return;
  const place = (lat: number, lon: number) => xyOfDegree(frame, lat, lon);
  ctx.strokeStyle = "rgba(139, 147, 167, 0.35)";
  ctx.fillStyle = "#8b93a7";
  ctx.font = "12px sans-serif";
  ctx.lineWidth = 1;
  const lonStep = tickStep(frame.east - frame.west);
  const latStep = tickStep(frame.north - frame.south);
  const lon0 = Math.ceil(frame.west / lonStep - 1e-9) * lonStep;
  const lat0 = Math.ceil(frame.south / latStep - 1e-9) * latStep;
  for (let i = 0; i < 12; i++) {
    const lon = lon0 + i * lonStep;
    if (lon > frame.east + lonStep * 1e-6) break;
    const x = place(frame.north, lon).x;
    if (x < 8 || x > w - 8) continue;
    ctx.beginPath();
    ctx.moveTo(x, 28);
    ctx.lineTo(x, h - 22);
    ctx.stroke();
    ctx.fillText(tickLabel(lon, lonStep), x + 4, h - 8);
  }
  for (let i = 0; i < 12; i++) {
    const lat = lat0 + i * latStep;
    if (lat > frame.north + latStep * 1e-6) break;
    const y = place(lat, frame.west).y;
    if (y < 16 || y > h - 16) continue;
    ctx.beginPath();
    ctx.moveTo(8, y);
    ctx.lineTo(w - 8, y);
    ctx.stroke();
    ctx.fillText(tickLabel(lat, latStep), 8, y - 4);
  }
  if (box) {
    const nw = place(box.north, box.west);
    const se = place(box.south, box.east);
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = "#e8eefc";
    ctx.strokeRect(nw.x, nw.y, se.x - nw.x, se.y - nw.y);
    ctx.restore();
  }
  if ([input.ourLat, input.ourLon, input.oppLat, input.oppLon].every(Number.isFinite)) {
    const us = place(input.ourLat, input.ourLon);
    const them = place(input.oppLat, input.oppLon);
    ctx.beginPath();
    ctx.moveTo(us.x, us.y);
    ctx.lineTo(them.x, them.y);
    ctx.strokeStyle = "#5eead4";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  const color: Record<VerdictKind, string> = {
    open: "#2dd4bf",
    ridge: "#f5d061",
    closed: "#ff6b73",
    insufficient: "#5c6570",
  };
  for (const cell of result.map) {
    const p = place(cell.lat, cell.lon);
    ctx.fillStyle = color[cell.verdict];
    ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
  }
  picks.forEach((pick, index) => {
    const p = place(pick.lat, pick.lon);
    ctx.fillStyle = "#e8eefc";
    ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
    ctx.fillText(String(index + 1), p.x + 6, p.y - 6);
  });
  const mark = (lat: number, lon: number, title: string) => {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const p = place(lat, lon);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
    ctx.fillStyle = "#e8eefc";
    ctx.fill();
    ctx.fillStyle = "#8b93a7";
    const label = `${title} ${formatDeg(lat)} ${formatDeg(lon)}`;
    ctx.fillText(label, p.x + 160 > w ? p.x - 168 : p.x + 8, p.y < 24 ? p.y + 16 : p.y - 8);
  };
  mark(input.ourLat, input.ourLon, "мы");
  mark(input.oppLat, input.oppLon, "противник");
}
