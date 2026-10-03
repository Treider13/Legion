import { analogCombRu } from "../sense/analogComb";
import { ATTACK_SILENT_HINT } from "../sense/attackAtlas";
import { droneidPlainLines, droneidSortA, lookRu } from "../sense/attackLook";
import type { AttackRow } from "../sense/attackScene";
import type { FpgaObserveClass } from "../sense/fpgaObserveClass";
import { hopRailPct, isHopRcId, PROTOCOL_CATALOG, type FhssLook } from "../sense/protocolDb";
import { detectorListens, HOST_ATTACK_MODE_RU_CAPS, patternLabelRu, type SdrWalkPattern } from "../sense/modes";

function familyTone(id: string): string {
  if (id === "analog-video") return "rfclass-analog";
  if (id.startsWith("digital") || id === "window-fill") return "rfclass-digital";
  if (isHopRcId(id) || id === "crossfire" || id === "ghost") return "rfclass-hop";
  if (id === "droneid" || id === "opendroneid") return "rfclass-digital";
  if (id.startsWith("hop") || id.startsWith("rc-") || id === "digital-burst") return "rfclass-hop";
  if (id === "two-floor") return "rfclass-two";
  if (id === "silent") return "rfclass-silent";
  if (id === "fpga-energy" || id === "energy") return "rfclass-unknown";
  return "rfclass-unknown";
}

function stateRu(state: AttackRow["state"]): string {
  if (state === "held") return "ДЕРЖИМ";
  if (state === "confirmed") return "ЖИВОЙ";
  if (state === "cooled") return "ОСТЫЛ";
  return "НОВЫЙ";
}

function HopRail(props: { fhss: FhssLook; nowMhz?: number }) {
  const { fhss, nowMhz } = props;
  const lo = fhss.fLowMhz || Math.min(...fhss.hopSetMhz, nowMhz ?? 0);
  const hi = fhss.fHighMhz || Math.max(...fhss.hopSetMhz, nowMhz ?? 0);
  if (!(hi > lo) || fhss.hopSetMhz.length < 1) return null;
  return (
    <div className="rfclass-rail" aria-label="набор hop">
      <span className="rfclass-rail-edge">{lo.toFixed(1)}</span>
      <div className="rfclass-rail-track">
        {fhss.hopSetMhz.map((f) => (
          <i key={f} className="rfclass-rail-tick" style={{ left: `${hopRailPct(f, lo, hi)}%` }} title={`${f.toFixed(3)} МГц`} />
        ))}
        {nowMhz != null && (
          <i className="rfclass-rail-now" style={{ left: `${hopRailPct(nowMhz, lo, hi)}%` }} title="сейчас" />
        )}
      </div>
      <span className="rfclass-rail-edge">{hi.toFixed(1)}</span>
    </div>
  );
}

function Layer3Line({ row }: { row: AttackRow }) {
  const did = row.look?.droneid;
  const od = row.look?.opendroneid;
  if (did?.ok && did.plain) {
    const lines = droneidPlainLines(did.plain);
    return (
      <p className="rfclass-l3">
        {lines.map((line, i) => (
          <span key={`${i}-${line}`} className={i === 0 ? undefined : "rfclass-l3-sub"}>
            {line}
          </span>
        ))}
      </p>
    );
  }
  if (did?.hit) {
    const head = did.encrypted ? "DroneID без plaintext (O3+/O4)" : "DroneID ZC";
    const metrics = droneidSortA(did);
    return (
      <p className="rfclass-l3">
        {head}
        {metrics ? <span className="rfclass-l3-sub">{metrics}</span> : null}
      </p>
    );
  }
  if (od?.hit && od.uas) {
    const pos =
      od.uas.latitude != null && od.uas.longitude != null
        ? ` · ${od.uas.latitude.toFixed(5)}, ${od.uas.longitude.toFixed(5)}`
        : "";
    const extra = [od.uas.status, od.uas.operatorId, od.uas.altGeo != null && Number.isFinite(od.uas.altGeo) ? `${od.uas.altGeo.toFixed(0)} м` : ""]
      .filter(Boolean)
      .join(" · ");
    return (
      <p className="rfclass-l3">
        RID {od.uas.uasId || "—"}
        {pos}
        {extra ? <span className="rfclass-l3-sub">{extra}</span> : null}
      </p>
    );
  }
  return null;
}

function liveIds(rows: readonly AttackRow[]): Set<string> {
  const ids = new Set<string>();
  for (const t of rows) {
    if (t.state === "cooled") continue;
    ids.add(t.atlas.id);
    if (t.look?.rc?.id) ids.add(t.look.rc.id);
    if (t.look?.droneid?.hit) ids.add("droneid");
    if (t.look?.opendroneid?.hit) ids.add("opendroneid");
    if (t.look?.analog?.hit) ids.add("analog-video");
    if (t.look?.fhss?.domain?.id) ids.add(t.look.fhss.domain.id);
    if (t.look?.fhss?.domain?.family) ids.add(t.look.fhss.domain.family);
  }
  return ids;
}

export function RfClassCard(props: {
  rows: readonly AttackRow[];
  pattern: SdrWalkPattern;
  fpga?: FpgaObserveClass | null;
  silent?: string;
  persistOcc?: number;
  persistListen?: number;
  persistLine?: string;
}) {
  const listening = detectorListens(props.pattern) || !!props.fpga;
  const live = props.rows
    .filter((t) => t.state !== "cooled")
    .slice()
    .sort((a, b) => b.powerDbm - a.powerDbm)
    .slice(0, 8);
  const mode = props.fpga ? "УМНАЯ АТАКА · observe" : patternLabelRu(props.pattern);
  const help = detectorListens(props.pattern)
    ? props.pattern === "auto"
      ? `${HOST_ATTACK_MODE_RU_CAPS}: класс по спектру, IQ, FHSS и Layer 3. Имя фирмы — только если сетка уникальна.`
      : "СКАНИРОВАТЬ — analog платы. ПЕРЕДАТЬ — слух на часах полки. Засечки в Атаку не идут."
    : "Класс с платы: энергия и полоса. Гребёнка analog и FHSS — только хост-IQ.";
  const seen = liveIds(live);

  return (
    <div className="rfclass" aria-label="Классы эфира">
      <div className="rfclass-head">
        <p className="rfclass-kicker">{mode}</p>
        <p className="rfclass-help">{help}</p>
        <p className="rfclass-legend" aria-hidden="true">
          <span className="rfclass-dot analog">аналог</span>
          <span className="rfclass-dot digital">цифра</span>
          <span className="rfclass-dot hop">hop / RC</span>
          <span className="rfclass-dot two">два этажа</span>
        </p>
      </div>
      {props.fpga && (
        <article className={`rfclass-hero ${familyTone(props.fpga.atlas.id)}`}>
          <span className="rfclass-badge">{props.fpga.detActive ? "FPGA" : "ТИШИНА"}</span>
          <h3>{props.fpga.atlas.label}</h3>
          <p>
            {props.fpga.freqMhz != null ? `${props.fpga.freqMhz.toFixed(3)} МГц` : "пик не готов"}
            {` · взгляд ${props.fpga.lookMhz.toFixed(1)} МГц`}
          </p>
          <p className="rfclass-hint">{props.fpga.atlas.hint}</p>
          <p className="sens-hint">{props.fpga.note}</p>
          {props.persistLine ? (
            <p className="sens-hint">
              persist occupancy {props.persistOcc ?? 0} · слух {props.persistListen ?? 0}
              {` · ${props.persistLine}`}
            </p>
          ) : null}
        </article>
      )}
      {!props.fpga && props.persistLine ? (
        <p className="sens-hint">
          persist occupancy {props.persistOcc ?? 0} · слух {props.persistListen ?? 0}
          {` · ${props.persistLine}`}
        </p>
      ) : null}
      {!listening && live.length === 0 ? null : live.length === 0 ? (
        <p className="rfclass-empty">{props.silent || ATTACK_SILENT_HINT}</p>
      ) : (
        <div className="rfclass-grid" aria-live="polite">
          {live.map((t) => {
            const comb = analogCombRu(t.look?.analog);
            const fhss = t.look?.fhss;
            return (
              <article key={t.id} className={`rfclass-tile ${familyTone(t.atlas.id)}`} title={t.atlas.hint}>
                <div className="rfclass-tile-top">
                  <span className="rfclass-mhz">{t.freqMhz.toFixed(3)}</span>
                  <span className="rfclass-state">{stateRu(t.state)}</span>
                </div>
                <strong>{t.atlas.label}</strong>
                <p>
                  {t.width3Mhz.toFixed(1)} / {t.width26Mhz.toFixed(1)} / {t.occ99Mhz.toFixed(1)} МГц
                  {` · доля ${t.duty.toFixed(2)}`}
                </p>
                {t.infoRu ? <p className="rfclass-info">{t.infoRu}</p> : null}
                <p className="rfclass-hint">{t.look ? lookRu(t.look) : t.atlas.hint}</p>
                {comb ? <p className="rfclass-comb">{comb}</p> : null}
                <Layer3Line row={t} />
                {fhss?.hit ? (
                  <p className="rfclass-fhss">
                    FHSS {fhss.unique} кан. · шаг {fhss.spacingMhz.toFixed(2)} МГц · dwell {fhss.dwellMs.toFixed(1)} мс
                    {fhss.rateHz > 0 ? ` · ${fhss.rateHz.toFixed(0)} hop/с` : ""}
                    {fhss.windowLimited ? " · окно xA4 обрезает 2.4" : ""}
                  </p>
                ) : null}
                {fhss?.hit ? <HopRail fhss={fhss} nowMhz={t.freqMhz} /> : null}
              </article>
            );
          })}
        </div>
      )}
      <div className="rfclass-catalog" aria-label="база протоколов">
        <p className="rfclass-catalog-kicker">БАЗЫ 2026</p>
        <ul>
          {PROTOCOL_CATALOG.map((p) => (
            <li key={p.id} className={seen.has(p.id) ? "on" : ""} title={p.hint}>
              <span>{p.label}</span>
              <small>{p.layer}</small>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
