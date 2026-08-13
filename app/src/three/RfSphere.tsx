// ============================================================================
// LEGION — RF-СФЕРА (signature moment S2): point-cloud сфера + fresnel rim +
// радарный луч + спектральное кольцо с дугой коридора и маркером частоты.
// Читает rfVisual через useFrame — без React-ре-рендеров.
// ============================================================================
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { freqTo01, rfVisual } from "./rfVisual";
import {
  ACCENT,
  OLIVE,
  PHOSPHOR,
  fresnelFrag,
  fresnelVert,
  pointsFrag,
  pointsVert,
  ringFrag,
  ringVert,
  sweepFrag,
  sweepVert,
} from "./shaders";

interface Props {
  /** low → меньше точек (device-tier деградация, тренд 2026) */
  tier: "low" | "high";
}

export function RfSphere({ tier }: Props) {
  const pointsRef = useRef<THREE.Points>(null);
  const sweepRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const rimRef = useRef<THREE.Mesh>(null);

  // --- Геометрия точек: fibonacci-распределение по сфере ---
  const { positions, scales } = useMemo(() => {
    const count = tier === "low" ? 1400 : 3200;
    const pos = new Float32Array(count * 3);
    const scl = new Float32Array(count);
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 2;
      const rad = Math.sqrt(1 - y * y);
      const th = golden * i;
      pos[i * 3] = Math.cos(th) * rad;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(th) * rad;
      scl[i] = 0.5 + Math.random() * 0.9;
    }
    return { positions: pos, scales: scl };
  }, [tier]);

  // --- Uniforms ---
  const uniforms = useMemo(
    () => ({
      points: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Vector3(...ACCENT) },
        uLock: { value: 0 },
        uLockColor: { value: new THREE.Vector3(...PHOSPHOR) },
      },
      rim: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Vector3(...OLIVE) },
        uLock: { value: 0 },
        uLockColor: { value: new THREE.Vector3(...PHOSPHOR) },
      },
      sweep: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Vector3(...ACCENT) },
        uActive: { value: 0 },
      },
      ring: {
        uTime: { value: 0 },
        uColor: { value: new THREE.Vector3(...ACCENT) },
        uLockColor: { value: new THREE.Vector3(...PHOSPHOR) },
        uLock: { value: 0 },
        uCorrA: { value: 0 },
        uCorrB: { value: 0 },
        uFreq01: { value: 0.6 },
        uHasCorr: { value: 0 },
      },
    }),
    [],
  );

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const v = rfVisual;
    const freq = v.corridorActive && v.telemFreqMhz !== null ? v.telemFreqMhz : v.freqMhz;

    // Плавное приближение uniform'ов (без дёрганий)
    const lerp = (cur: number, target: number, k: number) =>
      cur + (target - cur) * Math.min(1, k * delta * 60);

    uniforms.points.uTime.value = t;
    uniforms.rim.uTime.value = t;
    uniforms.sweep.uTime.value = t;
    uniforms.ring.uTime.value = t;

    const lockT = v.lock ? 1 : 0;
    uniforms.points.uLock.value = lerp(uniforms.points.uLock.value, lockT, 0.08);
    uniforms.rim.uLock.value = lerp(uniforms.rim.uLock.value, lockT, 0.08);
    uniforms.ring.uLock.value = lerp(uniforms.ring.uLock.value, lockT, 0.08);

    uniforms.sweep.uActive.value = lerp(
      uniforms.sweep.uActive.value,
      v.corridorActive ? 1 : 0,
      0.05,
    );

    uniforms.ring.uFreq01.value = lerp(
      uniforms.ring.uFreq01.value,
      freqTo01(freq),
      0.25,
    );
    uniforms.ring.uCorrA.value = freqTo01(v.corrF1);
    uniforms.ring.uCorrB.value = freqTo01(v.corrF2);
    uniforms.ring.uHasCorr.value = lerp(
      uniforms.ring.uHasCorr.value,
      v.corridorActive ? 1 : 0,
      0.1,
    );

    // Медленное вращение сферы
    if (pointsRef.current) {
      pointsRef.current.rotation.y += delta * 0.05;
    }
    if (rimRef.current) {
      rimRef.current.rotation.y -= delta * 0.02;
    }
  });

  return (
    <group rotation={[0.35, 0, 0]} scale={0.82}>
      {/* Базовая сфера с fresnel-обводкой */}
      <mesh ref={rimRef}>
        <sphereGeometry args={[1.0, 48, 48]} />
        <shaderMaterial
          vertexShader={fresnelVert}
          fragmentShader={fresnelFrag}
          uniforms={uniforms.rim}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.BackSide}
        />
      </mesh>

      {/* Точечная сфера */}
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-aScale" args={[scales, 1]} />
        </bufferGeometry>
        <shaderMaterial
          vertexShader={pointsVert}
          fragmentShader={pointsFrag}
          uniforms={uniforms.points}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      {/* Радарный луч — горизонтальный диск */}
      <mesh ref={sweepRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.02, 0]}>
        <planeGeometry args={[2.6, 2.6]} />
        <shaderMaterial
          vertexShader={sweepVert}
          fragmentShader={sweepFrag}
          uniforms={uniforms.sweep}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>

      {/* Спектральное кольцо */}
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.03, 0]}>
        <planeGeometry args={[3.4, 3.4]} />
        <shaderMaterial
          vertexShader={ringVert}
          fragmentShader={ringFrag}
          uniforms={uniforms.ring}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          side={THREE.DoubleSide}
        />
      </mesh>
    </group>
  );
}
