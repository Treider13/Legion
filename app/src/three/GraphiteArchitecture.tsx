import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

/** Decorative geometry behind the original eye. No telemetry, lights or controls. */
export function GraphiteArchitecture({ motion }: { motion: boolean }) {
  const dust = useRef<THREE.Points>(null);
  const visible = useRef(!document.hidden);
  const time = useRef(0);
  const positions = useMemo(() => {
    const points = new Float32Array(100 * 3);
    // Stable visual seed prevents a new background on every render.
    let seed = 13031;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    for (let i = 0; i < points.length; i += 3) {
      points[i] = (random() - 0.5) * 22;
      points[i + 1] = (random() - 0.5) * 10;
      points[i + 2] = -4 - random() * 5;
    }
    return points;
  }, []);

  useEffect(() => {
    const update = () => { visible.current = !document.hidden; };
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useFrame((_, delta) => {
    if (!motion || !visible.current) return;
    time.current += Math.min(delta, 0.05);
    const t = time.current;
    if (dust.current) {
      dust.current.rotation.z = t * 0.0014;
      dust.current.position.y = Math.sin(t * 0.04) * 0.12;
    }
  });

  return <group name="graphite-decoration">
    <points ref={dust} frustumCulled={false}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]}/></bufferGeometry>
      <pointsMaterial size={0.016} color="#aeb6bb" transparent opacity={0.4} depthWrite={false} sizeAttenuation/>
    </points>
  </group>;
}
