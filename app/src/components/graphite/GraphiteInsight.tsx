import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AttackAdvice, AttackHintKind } from "../../sense/attackAdvisor";
import type { AttackRow } from "../../sense/attackScene";
import { useLegion } from "../../state/store";

const STEP_MS = 12000;

interface Slide {
  key: string;
  kicker: string;
  title: string;
  text: string;
  why: string;
  freqMhz: number | null;
  typeLabel: string | null;
  applyKind: AttackHintKind | null;
  applyLabel: string | null;
}

function typeOf(row: AttackRow): string {
  return row.look?.label ?? row.atlas.label;
}

function liveRows(rows: readonly AttackRow[]): AttackRow[] {
  return rows
    .filter((row) => row.state === "new" || row.state === "confirmed" || row.state === "held")
    .slice()
    .sort((a, b) => b.powerDbm - a.powerDbm);
}

function signalSlide(row: AttackRow, key: string): Slide {
  const type = typeOf(row);
  const role = row.infoRu ? ` · ${row.infoRu}` : "";
  const family = row.atlas.label !== type ? `${row.atlas.label}. ` : "";
  return {
    key,
    kicker: "Сигнал",
    title: type,
    text: `${row.freqMhz.toFixed(3)} МГц${role}. ${family}${row.atlas.hint}`,
    why: "",
    freqMhz: row.freqMhz,
    typeLabel: type,
    applyKind: null,
    applyLabel: null,
  };
}

function buildAssistantSlides(rows: readonly AttackRow[], advice: AttackAdvice): Slide[] {
  const live = liveRows(rows);
  const primary = live[0];
  if (!primary && !advice.scene && advice.hints.length === 0) {
    return [
      {
        key: "wait",
        kicker: "Помощник",
        title: "Ждёт сигнал",
        text: "Когда в эфире появится след, здесь по очереди будут его тип и совет. Каждый шаг держится 12 секунд.",
        why: "",
        freqMhz: null,
        typeLabel: null,
        applyKind: null,
        applyLabel: null,
      },
    ];
  }

  const slides: Slide[] = [];
  if (primary) {
    slides.push(signalSlide(primary, "signal"));
    if (advice.scene) {
      slides.push({
        key: "scene",
        kicker: `${primary.freqMhz.toFixed(3)} МГц · ${typeOf(primary)}`,
        title: "Эфир",
        text: advice.scene,
        why: "",
        freqMhz: primary.freqMhz,
        typeLabel: typeOf(primary),
        applyKind: null,
        applyLabel: null,
      });
    }
    for (const hint of advice.hints) {
      slides.push({
        key: `hint-${hint.kind}`,
        kicker: `${primary.freqMhz.toFixed(3)} МГц · ${typeOf(primary)}`,
        title: hint.title,
        text: hint.text,
        why: hint.why,
        freqMhz: primary.freqMhz,
        typeLabel: typeOf(primary),
        applyKind: hint.applyLabel ? hint.kind : null,
        applyLabel: hint.applyLabel,
      });
    }
    live.slice(1, 5).forEach((row, index) => slides.push(signalSlide(row, `signal-${index + 2}`)));
  } else {
    slides.push({
      key: "scene",
      kicker: "Помощник",
      title: "Эфир",
      text: advice.scene,
      why: "",
      freqMhz: null,
      typeLabel: null,
      applyKind: null,
      applyLabel: null,
    });
    for (const hint of advice.hints) {
      slides.push({
        key: `hint-quiet-${hint.kind}`,
        kicker: "Совет",
        title: hint.title,
        text: hint.text,
        why: hint.why,
        freqMhz: null,
        typeLabel: null,
        applyKind: hint.applyLabel ? hint.kind : null,
        applyLabel: hint.applyLabel,
      });
    }
  }
  if (advice.after) {
    slides.push({
      key: "after",
      kicker: primary ? `${primary.freqMhz.toFixed(3)} МГц · ${typeOf(primary)}` : "После передачи",
      title: "Остаток",
      text: advice.after,
      why: "",
      freqMhz: primary?.freqMhz ?? null,
      typeLabel: primary ? typeOf(primary) : null,
      applyKind: null,
      applyLabel: null,
    });
  }
  return slides;
}

function useAssistantCue() {
  const rows = useLegion((s) => s.attackRows);
  const advice = useLegion((s) => s.attackAdvice);
  const transmitArmed = useLegion((s) => s.transmitArmed);
  const applyAttackHint = useLegion((s) => s.applyAttackHint);
  const slides = useMemo(() => buildAssistantSlides(rows, advice), [rows, advice]);
  const slidesRef = useRef(slides);
  slidesRef.current = slides;
  const dueRef = useRef(Date.now() + STEP_MS);
  const [stepKey, setStepKey] = useState<string | null>(null);
  const stepKeyRef = useRef<string | null>(null);
  const heldRef = useRef<Slide | null>(null);
  const [paused, setPaused] = useState(false);

  // Двенадцать секунд — сколько одна карточка остаётся на экране.
  // Смена самого громкого следа обновляет текст и не перелистывает раньше срока.
  useEffect(() => {
    if (paused) return;
    dueRef.current = Date.now() + STEP_MS;
    const id = window.setInterval(() => {
      const list = slidesRef.current;
      if (list.length < 2) {
        dueRef.current = Date.now() + STEP_MS;
        return;
      }
      const at = list.findIndex((item) => item.key === stepKeyRef.current);
      if (at < 0) {
        if (stepKeyRef.current == null) {
          stepKeyRef.current = list[0].key;
          setStepKey(list[0].key);
          return;
        }
        if (Date.now() < dueRef.current) return;
        dueRef.current = Date.now() + STEP_MS;
        stepKeyRef.current = list[0].key;
        setStepKey(list[0].key);
        return;
      }
      if (Date.now() < dueRef.current) return;
      dueRef.current = Date.now() + STEP_MS;
      const next = list[(at + 1) % list.length].key;
      stepKeyRef.current = next;
      setStepKey(next);
    }, 200);
    return () => window.clearInterval(id);
  }, [paused]);

  const showKey = (key: string) => {
    dueRef.current = Date.now() + STEP_MS;
    stepKeyRef.current = key;
    setStepKey(key);
  };

  const matched = stepKey ? slides.find((item) => item.key === stepKey) : undefined;
  if (matched) heldRef.current = matched;
  const slide = matched ?? heldRef.current ?? slides[0];
  return { slide, slides, paused, setPaused, showKey, transmitArmed, applyAttackHint };
}

function SignalStat({ typeLabel, freqMhz }: { typeLabel: string | null; freqMhz: number | null }) {
  return (
    <div className="graphite-stat">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
        <path d="M5 18V7m7 11V4m7 14v-8" />
      </svg>
      <div>
        <span className="graphite-stat-label">Сигнал</span>
        <span className="graphite-stat-value">{typeLabel ?? "нет сигнала"}</span>
      </div>
      <small>{freqMhz != null ? `${freqMhz.toFixed(3)} МГц` : "ожидание"}</small>
    </div>
  );
}

export function GraphiteFacts({
  source,
  sourceNote,
  range,
  rangeNote,
}: {
  source: string;
  sourceNote: string;
  range: string;
  rangeNote: string;
}) {
  const cue = useAssistantCue();
  const slide = cue.slide;
  return (
    <>
      <div className="graphite-stats">
        <div className="graphite-stat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
            <path d="M12 13v7m-3 0h6M8.5 15a5 5 0 0 1 0-7M15.5 8a5 5 0 0 1 0 7M5.5 18a9 9 0 0 1 0-13M18.5 5a9 9 0 0 1 0 13" />
            <circle cx="12" cy="11.5" r="1.5" />
          </svg>
          <div>
            <span className="graphite-stat-label">Подключение</span>
            <span className="graphite-stat-value">{source}</span>
          </div>
          <small>{sourceNote}</small>
        </div>
        <div className="graphite-stat">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" aria-hidden="true">
            <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 9h6v6H9z" />
          </svg>
          <div>
            <span className="graphite-stat-label">Диапазон</span>
            <span className="graphite-stat-value">{range}</span>
          </div>
          <small>{rangeNote}</small>
        </div>
        <SignalStat typeLabel={slide?.typeLabel ?? null} freqMhz={slide?.freqMhz ?? null} />
      </div>
      {slide && (
        <section
          className={cue.paused ? "graphite-assist is-paused" : "graphite-assist"}
          style={{ "--graphite-cue-ms": `${STEP_MS}ms` } as CSSProperties}
          aria-live="polite"
          aria-atomic="true"
          aria-label="Советы помощника"
          onMouseEnter={() => cue.setPaused(true)}
          onMouseLeave={() => cue.setPaused(false)}
        >
          <div className="graphite-assist-kicker">
            <span>Помощник</span>
            <span>{slide.kicker}</span>
          </div>
          <div key={slide.key} className="graphite-assist-body">
            <h2>{slide.title}</h2>
            <p>{slide.text}</p>
            {slide.why && <small>{slide.why}</small>}
          </div>
          <div className="graphite-assist-side">
            {slide.applyLabel && slide.applyKind && (
              <button
                type="button"
                className="graphite-assist-apply"
                disabled={cue.transmitArmed}
                onClick={() => {
                  if (slide.applyKind) cue.applyAttackHint(slide.applyKind);
                }}
              >
                {slide.applyLabel}
              </button>
            )}
            {cue.slides.length > 1 && (
              <div className="graphite-assist-dots">
                {cue.slides.map((item, n) => (
                  <button
                    key={item.key}
                    type="button"
                    className={item.key === slide.key ? "on" : ""}
                    aria-label={`Шаг ${n + 1}: ${item.title}`}
                    aria-current={item.key === slide.key ? "step" : undefined}
                    onClick={() => cue.showKey(item.key)}
                  />
                ))}
              </div>
            )}
          </div>
          {cue.slides.length > 1 && <span key={`meter-${slide.key}`} className="graphite-assist-meter" aria-hidden="true" />}
        </section>
      )}
    </>
  );
}
