// ============================================================================
// LEGION — Boot sequence (signature moment S1): строки самотеста БИУС-стиля,
// логотип LEGION собирается из глитча, прогресс-бар, растворение.
// GSAP timeline; пропуск при prefers-reduced-motion и повторном визите.
// ============================================================================
import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

import { prefersReducedMotion } from "../../hooks/useDeviceTier";

const BOOT_LINES = [
  "LEGION OS // ЯДРО 0.1.0",
  "ПАМЯТЬ ...... 327680 КБ OK",
  "ШИНА SPI .... ADF4351 СВЯЗЬ OK",
  "ФАПЧ ........ FRACTIONAL-N OK",
  "РЧ-КАСКАД ... ГОТОВ",
  "КОРИДОР ..... 2400-2500 МГц ГОТОВ",
  "",
  "ВСЕ СИСТЕМЫ В НОРМЕ",
];

interface Props {
  onDone: () => void;
}

export function BootSequence({ onDone }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const logoRef = useRef<HTMLHeadingElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<string[]>([]);

  useEffect(() => {
    // Повторный визит в сессии или reduced-motion — сразу пропускаем
    if (prefersReducedMotion() || sessionStorage.getItem("legion_booted") === "1") {
      sessionStorage.setItem("legion_booted", "1");
      onDone();
      return;
    }

    const tl = gsap.timeline({
      onComplete: () => {
        sessionStorage.setItem("legion_booted", "1");
        onDone();
      },
    });

    // Строки самотеста — по одной
    BOOT_LINES.forEach((line, i) => {
      tl.call(() => setLines((prev) => [...prev, line]), undefined, 0.22 * i);
    });

    const t0 = 0.22 * BOOT_LINES.length + 0.15;

    // Логотип: глитч-сборка (clip + skew всплески)
    tl.fromTo(
      logoRef.current,
      { opacity: 0, scaleY: 0.2, skewX: 18, filter: "blur(6px)" },
      { opacity: 1, scaleY: 1, skewX: 0, filter: "blur(0px)", duration: 0.5, ease: "power3.out" },
      t0,
    );
    tl.to(logoRef.current, { opacity: 0.25, duration: 0.05, repeat: 3, yoyo: true }, t0 + 0.5);

    // Прогресс-бар
    tl.fromTo(
      barRef.current,
      { scaleX: 0 },
      { scaleX: 1, duration: 0.7, ease: "power2.inOut" },
      t0 + 0.55,
    );

    // Растворение
    tl.to(rootRef.current, { opacity: 0, duration: 0.45, ease: "power2.in" }, t0 + 1.5);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={rootRef} className="boot-overlay">
      <div className="boot-lines">
        {lines.map((l, i) => (
          <div key={i} className="boot-line">
            {l}
          </div>
        ))}
      </div>
      <h1 ref={logoRef} className="boot-logo">
        LEGION
      </h1>
      <div className="boot-bar-track">
        <div ref={barRef} className="boot-bar" />
      </div>
    </div>
  );
}
