import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import Map, { Layer, Marker, ScaleControl, Source, type MapRef } from "@vis.gl/react-maplibre";
import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";
import { setWorkerUrl, type LngLatLike, type Map as MapLibreMap, type MapSourceDataEvent } from "maplibre-gl";
import maplibreWorker from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { formatDeg } from "../../sense/position/geo";
import type { MapCell, SearchBox, SitePick } from "../../sense/position/types";
import {
  frameTarget,
  frameZoom,
  MAX_PITCH,
  modePitch,
  motionMs,
  scalePercent,
  UKRAINE_VIEW,
  type FrameTarget,
  type MapViewMode,
} from "./mapStage";
import "maplibre-gl/dist/maplibre-gl.css";
import "./positionMap.css";

// Сборка кладёт код MapLibre в свой чанк. Рядом с ним файла worker нет,
// поэтому адрес задаём сами: Vite упаковывает worker вместе с приложением.
setWorkerUrl(maplibreWorker);

const STYLE = "https://tiles.openfreemap.org/styles/liberty";
const SATELLITE = "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/g/{z}/{y}/{x}.jpg";
const TERRAIN = "https://tiles.mapterhorn.com/tilejson.json";

const UNDER_PHOTO = [
  "background",
  "natural_earth",
  "park",
  "landuse_residential",
  "landcover_wood",
  "landcover_grass",
  "landcover_ice",
  "landcover_wetland",
  "landuse_pitch",
  "landuse_track",
  "landuse_cemetery",
  "landuse_hospital",
  "landuse_school",
  "landcover_sand",
  "park_outline",
  "water",
];

interface Props {
  our: { lat: number; lon: number } | null;
  opp: { lat: number; lon: number } | null;
  cells: MapCell[] | null;
  box: SearchBox | null;
  picks: SitePick[];
}

function collection(features: FeatureCollection["features"]): FeatureCollection<Geometry, GeoJsonProperties> {
  return { type: "FeatureCollection", features };
}

function show(on: boolean): "visible" | "none" {
  return on ? "visible" : "none";
}

function lngLatPair(center: LngLatLike | undefined, fallback: [number, number]): [number, number] {
  if (Array.isArray(center) && center.length >= 2) {
    const lon = Number(center[0]);
    const lat = Number(center[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }
  if (center && typeof center === "object" && "lng" in center && "lat" in center) {
    const lon = Number(center.lng);
    const lat = Number(center.lat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) return [lon, lat];
  }
  return fallback;
}

function underPhoto(map: MapLibreMap, hidden: boolean) {
  for (const id of UNDER_PHOTO) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", show(!hidden));
  }
}

function applyPhoto(map: MapLibreMap, on: boolean, cover: boolean) {
  if (!map.getSource("satellite")) {
    map.addSource("satellite", {
      type: "raster",
      tiles: [SATELLITE],
      tileSize: 256,
      maxzoom: 15,
      attribution: "Sentinel-2 cloudless © EOX (CC BY 4.0), Copernicus",
    });
  }
  if (!map.getLayer("satellite")) {
    const before = map.getLayer("park") ? "park" : undefined;
    map.addLayer(
      {
        id: "satellite",
        type: "raster",
        source: "satellite",
        paint: { "raster-saturation": -0.08, "raster-contrast": 0.08, "raster-resampling": "linear" },
      },
      before,
    );
  }
  if (!map.getLayer("satellite")) throw new Error("слой снимка не встал");
  map.setLayoutProperty("satellite", "visibility", show(on));
  // Пока снимок не пришёл, землю не прячем: иначе холст остаётся пустым.
  underPhoto(map, on && cover);
}

function applyBuildings(map: MapLibreMap, on: boolean) {
  for (const id of ["building", "building-3d"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", show(on));
  }
}

export default function PositionMap({ our, opp, cells, box, picks }: Props) {
  const mapRef = useRef<MapRef>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<MapViewMode>("3d");
  const photoRef = useRef(true);
  const satelliteCover = useRef(false);
  const buildingsRef = useRef(true);
  const homeZoom = useRef(UKRAINE_VIEW.zoom);
  const framing = useRef(false);
  const frameToken = useRef(0);
  const frameEnd = useRef<(() => void) | null>(null);
  const [mode, setMode] = useState<MapViewMode>("3d");
  const [ready, setReady] = useState(false);
  const [photo, setPhoto] = useState(true);
  const [relief, setRelief] = useState(true);
  const [buildings, setBuildings] = useState(true);
  const [pathOn, setPathOn] = useState(true);
  const [marksOn, setMarksOn] = useState(true);
  const [boxOn, setBoxOn] = useState(true);
  const [layersOpen, setLayersOpen] = useState(false);
  const [percent, setPercent] = useState(100);
  const [photoError, setPhotoError] = useState("");
  modeRef.current = mode;
  photoRef.current = photo;
  buildingsRef.current = buildings;

  const points = useMemo(() => [our, opp].filter((p): p is NonNullable<typeof our> => p != null), [our, opp]);
  const pointKey = points.map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join("|");

  const linkData = useMemo(() => collection(
    our && opp ? [{
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [[our.lon, our.lat], [opp.lon, opp.lat]] },
    }] : [],
  ), [our, opp]);

  const cellData = useMemo(() => collection(
    (cells ?? []).filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon)).map((c) => ({
      type: "Feature" as const,
      properties: { verdict: c.verdict },
      geometry: { type: "Point" as const, coordinates: [c.lon, c.lat] },
    })),
  ), [cells]);

  const pickData = useMemo(() => collection(
    picks.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map((p, index) => ({
      type: "Feature" as const,
      properties: { n: String(index + 1) },
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
    })),
  ), [picks]);

  const boxData = useMemo(() => collection(
    box ? [{
      type: "Feature",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[
          [box.west, box.south],
          [box.east, box.south],
          [box.east, box.north],
          [box.west, box.north],
          [box.west, box.south],
        ]],
      },
    }] : [],
  ), [box]);

  const readScale = () => {
    const zoom = mapRef.current?.getZoom();
    if (zoom == null) return;
    setPercent(scalePercent(zoom, homeZoom.current));
    const raw = mapRef.current?.getMap();
    const el = stageRef.current;
    if (!raw || !el) return;
    el.dataset.posZoom = raw.getZoom().toFixed(2);
    el.dataset.posPitch = raw.getPitch().toFixed(1);
    el.dataset.posBearing = raw.getBearing().toFixed(1);
    el.dataset.posTerrain = raw.getTerrain() ? "on" : "off";
    const sat = raw.getLayer("satellite");
    el.dataset.posSat = sat ? String(raw.getLayoutProperty("satellite", "visibility") ?? "visible") : "missing";
    const buildingsLayer = raw.getLayer("building-3d");
    el.dataset.posBuildings = buildingsLayer ? String(raw.getLayoutProperty("building-3d", "visibility") ?? "visible") : "missing";
  };

  const goFrame = (target: FrameTarget | null) => {
    const map = mapRef.current;
    if (!map) return;
    const raw = map.getMap();
    const pitch = modePitch(modeRef.current);
    const bearing = modeRef.current === "2d" ? 0 : raw.getBearing();
    const duration = motionMs();
    const token = ++frameToken.current;
    if (frameEnd.current) {
      raw.off("moveend", frameEnd.current);
      frameEnd.current = null;
    }
    // stop() сам шлёт moveend прошлой анимации. Слушатель снимаем до него,
    // иначе конец старого кадра запишет масштаб нового.
    raw.stop();

    const fallback: [number, number] = [UKRAINE_VIEW.longitude, UKRAINE_VIEW.latitude];
    let center = fallback;
    let zoom = UKRAINE_VIEW.zoom;
    let nextBearing = 0;
    if (target?.kind === "point") {
      center = [target.longitude, target.latitude];
      zoom = target.zoom;
      nextBearing = bearing;
    } else if (target?.kind === "bounds") {
      const bounds: [[number, number], [number, number]] = [
        [target.west, target.south],
        [target.east, target.north],
      ];
      const fitted = raw.cameraForBounds(bounds, { padding: 72, maxZoom: 16, bearing, pitch });
      const tight = raw.cameraForBounds(bounds, { padding: 36, maxZoom: 16, bearing, pitch });
      const fittedZoom = fitted?.zoom ?? raw.getZoom();
      zoom = frameZoom(fittedZoom, tight?.zoom ?? null);
      const chosen = zoom === fittedZoom ? fitted : tight;
      center = lngLatPair(chosen?.center, [(target.west + target.east) / 2, (target.south + target.north) / 2]);
      nextBearing = bearing;
    }
    // 100% — этот кадр, а не то место, где камера оказалась по дороге.
    homeZoom.current = zoom;
    framing.current = true;
    const finish = () => {
      if (token !== frameToken.current) return;
      frameEnd.current = null;
      framing.current = false;
      const actual = raw.getZoom();
      readScale();
      setPercent(Math.abs(actual - zoom) < 0.08 ? 100 : scalePercent(actual, zoom));
    };
    frameEnd.current = finish;
    map.easeTo({ center, zoom, bearing: nextBearing, pitch, duration, essential: true });
    // duration 0 (в том числе «меньше движения») кончает полёт внутри easeTo,
    // раньше любого requestAnimationFrame. Иначе флаг кадра залипает и масштаб молчит.
    if (!raw.isMoving()) finish();
    else raw.once("moveend", finish);
  };

  useEffect(() => {
    let stop = false;
    let hooked: MapLibreMap | null = null;
    const onSatellite = (event: MapSourceDataEvent) => {
      if (stop || event.sourceId !== "satellite" || event.sourceDataType !== "content") return;
      satelliteCover.current = true;
      if (!photoRef.current || !hooked) return;
      underPhoto(hooked, true);
    };
    const onStyle = () => {
      if (stop || !hooked) return;
      satelliteCover.current = false;
      try {
        applyPhoto(hooked, photoRef.current, false);
        applyBuildings(hooked, buildingsRef.current);
        setPhotoError("");
      } catch (err) {
        setPhotoError(err instanceof Error ? err.message : "снимок не открылся");
      }
    };
    let frames = 0;
    const watch = () => {
      if (stop) return;
      const map = mapRef.current?.getMap();
      if (!map) {
        if (++frames < 180) window.requestAnimationFrame(watch);
        return;
      }
      const arm = () => {
        if (stop || hooked) return;
        hooked = map;
        try {
          applyPhoto(map, photoRef.current, satelliteCover.current);
          applyBuildings(map, buildingsRef.current);
          setPhotoError("");
        } catch (err) {
          setPhotoError(err instanceof Error ? err.message : "снимок не открылся");
        }
        setReady(true);
        map.on("sourcedata", onSatellite);
        map.on("style.load", onStyle);
      };
      if (map.getStyle()?.layers?.length) arm();
      else map.once("style.load", arm);
    };
    watch();
    return () => {
      stop = true;
      hooked?.off("style.load", onStyle);
      hooked?.off("sourcedata", onSatellite);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    if (mode === "2d") {
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
    } else {
      map.touchZoomRotate.enableRotation();
      map.keyboard.enableRotation();
    }
    map.easeTo({
      pitch: modePitch(mode),
      bearing: mode === "2d" ? 0 : map.getBearing(),
      duration: motionMs(),
      essential: true,
    });
  }, [mode, ready]);

  useEffect(() => {
    if (!ready) return;
    goFrame(frameTarget(points));
    // Кадр пересчитывается только когда меняются сами градусы.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointKey, ready]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    try {
      applyPhoto(map, photo, satelliteCover.current);
      setPhotoError("");
    } catch (err) {
      setPhotoError(err instanceof Error ? err.message : "снимок не открылся");
    }
  }, [photo, ready]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !ready) return;
    applyBuildings(map, buildings);
  }, [buildings, ready]);

  useEffect(() => () => {
    const map = mapRef.current?.getMap();
    if (map && frameEnd.current) map.off("moveend", frameEnd.current);
  }, []);

  useEffect(() => {
    const onFs = () => mapRef.current?.resize();
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;
      event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onKey = (e: ReactKeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "2") setMode("2d");
    if (e.key === "3") setMode("3d");
    if (e.key === "Escape" && layersOpen) {
      e.stopPropagation();
      setLayersOpen(false);
    }
    // На холсте те же клавиши уже ловит MapLibre. Второй zoomIn удваивал бы шаг.
    if (target?.closest(".maplibregl-canvas, .maplibregl-map")) return;
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      mapRef.current?.zoomIn({ duration: motionMs() });
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      mapRef.current?.zoomOut({ duration: motionMs() });
    }
  };

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen();
    else void el.requestFullscreen();
  };

  const place = our ? `${formatDeg(our.lat)} ${formatDeg(our.lon)}` : "Точка не задана";
  const viewName = mode === "2d" ? "Картографический вид" : "Наклонный вид";

  return (
    <div className="pos-stage" ref={stageRef} tabIndex={0} onKeyDown={onKey} data-pos-map data-pos-mode={mode} data-pos-photo={photoError ? "fail" : photo ? "on" : "off"}>
      <div className="pos-stage-canvas">
        <Map
          ref={mapRef}
          mapStyle={STYLE}
          initialViewState={{ ...UKRAINE_VIEW, pitch: modePitch("3d"), bearing: 0 }}
          minZoom={3}
          maxZoom={18}
          maxPitch={MAX_PITCH}
          scrollZoom
          dragRotate={mode === "3d"}
          touchPitch={mode === "3d"}
          pitchWithRotate
          terrain={(relief ? { source: "terrain-dem", exaggeration: 1 } : null) as unknown as { source: string; exaggeration: number }}
          sky={{ "sky-color": "#c5d5e4", "horizon-color": "#f3efe6", "fog-color": "#d5dde4", "atmosphere-blend": 0.6 }}
          style={{ width: "100%", height: "100%" }}
          onMove={() => {
            if (!framing.current) readScale();
          }}
          onIdle={() => {
            if (!framing.current) readScale();
          }}
        >
          <Source id="terrain-dem" type="raster-dem" url={TERRAIN} tileSize={512} encoding="terrarium" maxzoom={12} />
          <Source id="pos-link" type="geojson" data={linkData}>
            <Layer id="pos-link-line" type="line" layout={{ visibility: show(pathOn) }} paint={{ "line-color": "#5eead4", "line-width": 2 }} />
          </Source>
          <Source id="pos-cells" type="geojson" data={cellData}>
            <Layer
              id="pos-cells-layer"
              type="circle"
              layout={{ visibility: show(marksOn) }}
              paint={{
                "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2, 14, 6],
                "circle-color": ["match", ["get", "verdict"], "open", "#2dd4bf", "ridge", "#f5d061", "closed", "#ff6b73", "#5c6570"],
                "circle-opacity": 0.9,
                "circle-stroke-width": 0.5,
                "circle-stroke-color": "rgba(0,0,0,0.35)",
              }}
            />
          </Source>
          <Source id="pos-picks" type="geojson" data={pickData}>
            <Layer id="pos-picks-circle" type="circle" layout={{ visibility: show(marksOn) }} paint={{ "circle-radius": 5, "circle-color": "#f4f1ea" }} />
            <Layer
              id="pos-picks-label"
              type="symbol"
              layout={{ visibility: show(marksOn), "text-field": ["get", "n"], "text-offset": [0.6, -0.6], "text-size": 11 }}
              paint={{ "text-color": "#f4f1ea", "text-halo-color": "#141611", "text-halo-width": 1 }}
            />
          </Source>
          <Source id="pos-box" type="geojson" data={boxData}>
            <Layer id="pos-box-line" type="line" layout={{ visibility: show(boxOn) }} paint={{ "line-color": "#f4f1ea", "line-width": 1.5, "line-dasharray": [1.2, 1] }} />
          </Source>
          {our && (
            <Marker longitude={our.lon} latitude={our.lat} anchor="center" pitchAlignment="viewport" rotationAlignment="viewport">
              <span className="pos-pin">мы</span>
            </Marker>
          )}
          {opp && (
            <Marker longitude={opp.lon} latitude={opp.lat} anchor="center" pitchAlignment="viewport" rotationAlignment="viewport">
              <span className="pos-pin opp">противник</span>
            </Marker>
          )}
          <ScaleControl position="bottom-left" unit="metric" />
        </Map>
      </div>

      <div className="pos-chrome pos-top">
        <div className="pos-brand">
          <strong>ПОЗИЦИЯ</strong>
          <span>{our && opp ? `${formatDeg(our.lat)} ${formatDeg(our.lon)} → ${formatDeg(opp.lat)} ${formatDeg(opp.lon)}` : place}</span>
        </div>
        <div className="pos-tools">
          <button type="button" aria-pressed={mode === "2d"} onClick={() => setMode("2d")}>2D</button>
          <button type="button" aria-pressed={mode === "3d"} onClick={() => setMode("3d")}>3D</button>
          <button type="button" aria-pressed={layersOpen} onClick={() => setLayersOpen((v) => !v)}>Слои</button>
          <button type="button" onClick={fullscreen}>Весь экран</button>
        </div>
      </div>

      <div className="pos-chrome pos-card">
        <p>УКРАИНА</p>
        <strong>{place}</strong>
        <p>{viewName}</p>
      </div>

      {!layersOpen && <div className="pos-chrome pos-badge"><i />{mode === "2d" ? "2D · ПЛАН" : "3D · ОБЪЁМ"}</div>}
      {layersOpen && (
        <div className="pos-chrome pos-layers">
          <label><input type="checkbox" checked={photo} onChange={(e) => setPhoto(e.target.checked)} />Снимок</label>
          <label><input type="checkbox" checked={relief} onChange={(e) => setRelief(e.target.checked)} />Рельеф</label>
          <label><input type="checkbox" checked={buildings} onChange={(e) => setBuildings(e.target.checked)} />Дома</label>
          <label><input type="checkbox" checked={pathOn} onChange={(e) => setPathOn(e.target.checked)} />Трасса</label>
          <label><input type="checkbox" checked={marksOn} onChange={(e) => setMarksOn(e.target.checked)} />Отметки расчёта</label>
          <label><input type="checkbox" checked={boxOn} onChange={(e) => setBoxOn(e.target.checked)} />Квадрат</label>
        </div>
      )}

      <div className="pos-chrome pos-zoom">
        <button type="button" aria-label="Приблизить" onClick={() => mapRef.current?.zoomIn({ duration: motionMs() })}>+</button>
        <button type="button" aria-label="Отдалить" onClick={() => mapRef.current?.zoomOut({ duration: motionMs() })}>−</button>
        <button type="button" aria-label="Домашний кадр" onClick={() => goFrame(frameTarget(points))}>⌖</button>
      </div>

      <div className="pos-chrome pos-foot">
        <span>МАСШТАБ {percent}% · {viewName}{photoError ? ` · ${photoError}` : photo ? " · снимок около 10 м, ближе резкость у улиц и домов" : ""}</span>
        <span>2 / 3 — вид · колёсико — масштаб · в 3D правая кнопка крутит</span>
      </div>
    </div>
  );
}
