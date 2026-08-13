// ============================================================================
// LEGION — RealisticEye (полный 3D): глазное яблоко + роговичный купол +
// анимированные веки (кожа) + металлическая оправа с заклёпками и светящимися
// узлами + кожа-«лицо». Всё в 3D, освещение — IBL (Environment) + ключевой свет.
// Покой: живой взгляд + моргание. Бой (rfVisual.corridorActive): красный, злой
// прищур, резкие саккады, узлы оправы краснеют. До «СТОП».
// ============================================================================
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { rfVisual } from "./rfVisual";
import { EYE_ALERT, EYE_IRIS, EYE_SCLERA, eyeFrag, eyeVert } from "./eyeShaders";
import { makeSkinBump } from "./textures";

interface Props {
  tier: "low" | "high";
}

const SKIN = "#835241";

export function RealisticEye({ tier }: Props) {
  const eyeGroup = useRef<THREE.Group>(null); // саккады (вращается яблоко+роговица)
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const upperLid = useRef<THREE.Group>(null);
  const lowerLid = useRef<THREE.Group>(null);

  const skinBump = useMemo(() => makeSkinBump(), []);
  const tmp = useMemo(() => new THREE.Vector3(), []);
  const nodeMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: "#08302e",
        emissive: new THREE.Color(EYE_IRIS[0], EYE_IRIS[1], EYE_IRIS[2]),
        emissiveIntensity: 2.4,
        roughness: 0.4,
        metalness: 0.2,
      }),
    [],
  );

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uAlert: { value: 0 },
      uBlink: { value: 0 },
      uPupil: { value: 0.3 },
      uIris: { value: new THREE.Vector3(...EYE_IRIS) },
      uAlertCol: { value: new THREE.Vector3(...EYE_ALERT) },
      uSclera: { value: new THREE.Vector3(...EYE_SCLERA) },
      uEyeCenterView: { value: new THREE.Vector3(0, 0, -3.4) },
    }),
    [],
  );

  // Кольцо-оправа: заклёпки (металл) + узлы (светятся)
  const ring = useMemo(() => {
    const R = 1.18;
    const n = 24;
    const items: { x: number; y: number; node: boolean }[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      items.push({ x: Math.cos(a) * R, y: Math.sin(a) * R, node: i % 4 === 0 });
    }
    return items;
  }, []);

  const look = useRef({ yaw: 0, pitch: 0, tYaw: 0, tPitch: 0, next: 0, blinkT: 0, nextBlink: 2.5 });
  const seg = tier === "low" ? 40 : 80;

  useFrame((state, delta) => {
    const u = matRef.current?.uniforms;
    if (!u) return;
    const t = state.clock.elapsedTime;
    const k = (rate: number) => 1 - Math.exp(-delta * rate);
    const alert = rfVisual.corridorActive;
    const a = look.current;

    if (t > a.next) {
      const range = alert ? 0.42 : 0.14;
      a.tYaw = (Math.random() * 2 - 1) * range;
      a.tPitch = (Math.random() * 2 - 1) * range * 0.7;
      a.next = t + (alert ? 0.22 + Math.random() * 0.35 : 1.6 + Math.random() * 2.2);
    }
    a.yaw += (a.tYaw - a.yaw) * k(alert ? 26 : 5);
    a.pitch += (a.tPitch - a.pitch) * k(alert ? 26 : 5);
    const tremor = alert ? 0.02 : 0.005;
    const yaw = a.yaw + Math.sin(t * (alert ? 30 : 3)) * tremor;
    const pitch = a.pitch + Math.cos(t * (alert ? 26 : 2.3)) * tremor;
    if (eyeGroup.current) {
      eyeGroup.current.rotation.y = yaw;
      eyeGroup.current.rotation.x = -pitch;
      eyeGroup.current.getWorldPosition(tmp);
      tmp.applyMatrix4(state.camera.matrixWorldInverse);
      u.uEyeCenterView.value.copy(tmp);
    }

    // Моргание веками (геометрия). В бою — «злой прищур» (приоткрыты меньше).
    if (t > a.nextBlink) {
      a.blinkT = 0.0001;
      a.nextBlink = t + (alert ? 4 + Math.random() * 3 : 2.4 + Math.random() * 3.4);
    }
    let blink = 0;
    if (a.blinkT > 0) {
      a.blinkT += delta;
      const p = a.blinkT / 0.16;
      if (p >= 1) a.blinkT = 0;
      else blink = Math.sin(p * Math.PI);
    }
    const openBase = alert ? 0.5 : 0.72;
    const open = openBase * (1 - blink); // 0 = закрыто
    if (upperLid.current) upperLid.current.rotation.x = -open;
    if (lowerLid.current) lowerLid.current.rotation.x = open * 0.85;

    u.uTime.value = t;
    u.uAlert.value += ((alert ? 1 : 0) - u.uAlert.value) * k(3.5);
    const pupilTarget = alert ? 0.17 : 0.3 + 0.02 * Math.sin(t * 1.5);
    u.uPupil.value += (pupilTarget - u.uPupil.value) * k(5);

    // Узлы оправы: цвет/яркость по тревоге
    if (alert) nodeMat.emissive.setRGB(1.0, 0.14, 0.11);
    else nodeMat.emissive.setRGB(EYE_IRIS[0], EYE_IRIS[1], EYE_IRIS[2]);
    nodeMat.emissiveIntensity = 2.2 + (alert ? 1.6 : 0) + Math.sin(t * 3) * 0.3;
  });

  return (
    <group>
      {/* кожа-«лицо» позади */}
      <mesh position={[0, 0, -1.1]}>
        <planeGeometry args={[20, 13]} />
        <meshStandardMaterial color={SKIN} bumpMap={skinBump} bumpScale={0.015} roughness={0.85} metalness={0} />
      </mesh>

      {/* глазное яблоко + роговичный купол (вращаются вместе — саккады) */}
      <group ref={eyeGroup}>
        <mesh>
          <sphereGeometry args={[1, seg, seg]} />
          <shaderMaterial ref={matRef} vertexShader={eyeVert} fragmentShader={eyeFrag} uniforms={uniforms} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]} scale={1.03}>
          <sphereGeometry args={[1, 48, 32, 0, Math.PI * 2, 0, 0.64]} />
          <meshPhysicalMaterial
            transparent
            opacity={0.16}
            roughness={0.02}
            metalness={0}
            clearcoat={1}
            clearcoatRoughness={0.02}
            ior={1.4}
            envMapIntensity={1.6}
            depthWrite={false}
          />
        </mesh>
      </group>

      {/* металлическая оправа */}
      <mesh position={[0, 0, 0.04]}>
        <torusGeometry args={[1.18, 0.12, 20, 64]} />
        <meshStandardMaterial color="#8b9199" metalness={1} roughness={0.3} envMapIntensity={1.3} />
      </mesh>
      {ring.map((p, i) =>
        p.node ? (
          <mesh key={i} position={[p.x, p.y, 0.12]} material={nodeMat}>
            <sphereGeometry args={[0.05, 16, 16]} />
          </mesh>
        ) : (
          <mesh key={i} position={[p.x, p.y, 0.13]}>
            <sphereGeometry args={[0.035, 12, 12]} />
            <meshStandardMaterial color="#c7ccd2" metalness={1} roughness={0.25} />
          </mesh>
        ),
      )}

      {/* веки (кожа) — моргают вращением вокруг X */}
      <group ref={upperLid}>
        <mesh>
          <sphereGeometry args={[1.05, seg, 48, 0, Math.PI * 2, 0, 1.62]} />
          <meshStandardMaterial
            color={SKIN}
            bumpMap={skinBump}
            bumpScale={0.02}
            roughness={0.8}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
      <group ref={lowerLid}>
        <mesh>
          <sphereGeometry args={[1.05, seg, 48, 0, Math.PI * 2, Math.PI - 1.62, 1.62]} />
          <meshStandardMaterial
            color={SKIN}
            bumpMap={skinBump}
            bumpScale={0.02}
            roughness={0.8}
            metalness={0}
            side={THREE.DoubleSide}
          />
        </mesh>
      </group>
    </group>
  );
}
