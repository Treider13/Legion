import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

const KEY = "legion.graphite.motion";

/** Appearance preference only. Never changes the eye clock or data refresh. */
export function useGraphiteMotion() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [requested, setRequested] = useState(() => {
    try { return localStorage.getItem(KEY) !== "off"; } catch { return true; }
  });
  const [reduced, setReduced] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  const motion = requested && !reduced;

  useEffect(() => {
    const update = () => { if (rootRef.current) rootRef.current.dataset.visible = String(!document.hidden); };
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !motion) return;
    const ctx = gsap.context(() => {
      gsap.fromTo(".graphite-console", { y: 14 }, { y: 0, duration: 1.2, ease: "power3.out", clearProps: "transform" });
      gsap.fromTo(".graphite-stat", { opacity: 0.55 }, { opacity: 1, duration: 0.8, stagger: 0.07, clearProps: "opacity" });
    }, root);
    return () => ctx.revert();
  }, [motion]);

  const toggleMotion = () => setRequested(previous => {
    const next = !previous;
    try { localStorage.setItem(KEY, next ? "on" : "off"); } catch { /* Session preference still works. */ }
    return next;
  });
  return { rootRef, motion, reduced, toggleMotion };
}
