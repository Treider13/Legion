import { analogCombRu } from "../sense/analogComb";
import { ATTACK_SILENT_HINT } from "../sense/attackAtlas";
import { lookRu } from "../sense/attackLook";
import type { AttackRow } from "../sense/attackScene";
import type { FpgaObserveClass } from "../sense/fpgaObserveClass";
import { detectorListens, HOST_ATTACK_MODE_RU_CAPS, patternLabelRu, type SdrWalkPattern } from "../sense/modes";

function familyTone(id: string): string {
  if (id === "analog-video") return "rfclass-analog";
  if (id.startsWith("digital") || id === "window-fill") return "rfclass-digital";
  if (id.startsWith("hop") || id.startsWith("rc-") || id === "digital-burst") return "rfclass-hop";
  if (id === "two-floor") return "rfclass-two";
  if (id === "silent") return "rfclass-silent";
  return "rfclass-unknown";
}

function stateRu(state: AttackRow["state"]): string {
  if (state === "held") return "ДЕРЖИМ";
  if (state === "confirmed") return "ЖИВОЙ";
  if (state === "cooled") return "ОСТЫЛ";
  return "НОВЫЙ";
}

export function RfClassCard(props: {
  rows: readonly AttackRow[];
  pattern: SdrWalkPattern;
  fpga?: FpgaObserveClass | null;
  silent?: string;
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
      ? `${HOST_ATTACK_MODE_RU_CAPS}: класс по спектру и IQ. Имя фирмы не пишем.`
      : "СКАНИРОВАТЬ — analog платы. ПЕРЕДАТЬ — слух на часах полки. Засечки в Атаку не идут."
    : "Класс с платы: энергия и полоса. Гребёнка analog — только хост-IQ.";

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
        </article>
      )}
      {!listening && live.length === 0 ? null : live.length === 0 ? (
        <p className="rfclass-empty">{props.silent || ATTACK_SILENT_HINT}</p>
      ) : (
        <div className="rfclass-grid" aria-live="polite">
          {live.map((t) => {
            const comb = analogCombRu(t.look?.analog);
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
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
