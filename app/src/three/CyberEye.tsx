// ============================================================================
// LEGION — CyberEye (hero): «живое» глазное яблоко на кастомном шейдере.
// Покой: медленный дрейф взгляда, микротремор, редкие моргания, бирюза.
// Боевой режим (rfVisual.corridorActive = «ПОДАВИТЬ ЦЕЛЬ»): краснеет, зрачок
// сужается, резкие саккады «в разные стороны», держится красным до «СТОП».
// Читает состояние из rfVisual (мутируемый мост) — без React-ре-рендеров.
// ============================================================================
import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

import { rfVisual } from "./rfVisual";
import { EYE_ALERT, EYE_IRIS, EYE_SCLERA, eyeFrag, eyeVert } from "./eyeShaders";

interface Props {
  tier: "low" | "high";
}

export function CyberEye({ tier }: Props) {
  const meshRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);

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

  const look = useRef({
    yaw: 0,
    pitch: 0,
    tYaw: 0,
    tPitch: 0,
    next: 0,
    blinkT: 0,
    nextBlink: 2.5,
  });
  const tmp = useMemo(() => new THREE.Vector3(), []);

  useFrame((state, delta) => {
    const u = matRef.current?.uniforms;
    if (!u) return;
    const t = state.clock.elapsedTime;
    // Сглаживание, независимое от FPS (на слабых машинах анимация не «отстаёт»)
    const k = (rate: number) => 1 - Math.exp(-delta * rate);
    const alert = rfVisual.corridorActive; // «подавить цель»
    const a = look.current;

    // Новая цель взгляда: в боевом — часто и широко, в покое — редко и мелко
    if (t > a.next) {
      const range = alert ? 0.5 : 0.15;
      a.tYaw = (Math.random() * 2 - 1) * range;
      a.tPitch = (Math.random() * 2 - 1) * range * 0.7;
      a.next = t + (alert ? 0.22 + Math.random() * 0.35 : 1.6 + Math.random() * 2.2);
    }
    const sp = alert ? 26 : 5; // саккада: резкая в бою, плавная в покое
    a.yaw += (a.tYaw - a.yaw) * k(sp);
    a.pitch += (a.tPitch - a.pitch) * k(sp);

    const tremor = alert ? 0.02 : 0.005;
    const yaw = a.yaw + Math.sin(t * (alert ? 30 : 3)) * tremor;
    const pitch = a.pitch + Math.cos(t * (alert ? 26 : 2.3)) * tremor;
    if (meshRef.current) {
      meshRef.current.rotation.y = yaw;
      meshRef.current.rotation.x = -pitch;
      meshRef.current.getWorldPosition(tmp);
      tmp.applyMatrix4(state.camera.matrixWorldInverse);
      u.uEyeCenterView.value.copy(tmp);
    }

    // Моргание: фаза 0→1→0 за ~0.16с; в бою реже (злой прищур)
    if (t > a.nextBlink) {
      a.blinkT = 0.0001;
      a.nextBlink = t + (alert ? 4 + Math.random() * 3 : 2.4 + Math.random() * 3.4);
    }
    if (a.blinkT > 0) {
      a.blinkT += delta;
      const p = a.blinkT / 0.16;
      if (p >= 1) {
        a.blinkT = 0;
        u.uBlink.value = 0;
      } else {
        u.uBlink.value = Math.sin(p * Math.PI);
      }
    }

    u.uTime.value = t;
    u.uAlert.value += ((alert ? 1 : 0) - u.uAlert.value) * k(3.5);
    const pupilTarget = alert ? 0.17 : 0.3 + 0.02 * Math.sin(t * 1.5);
    u.uPupil.value += (pupilTarget - u.uPupil.value) * k(5);
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, tier === "low" ? 48 : 96, tier === "low" ? 48 : 96]} />
      <shaderMaterial
        ref={matRef}
        vertexShader={eyeVert}
        fragmentShader={eyeFrag}
        uniforms={uniforms}
      />
    </mesh>
  );
}
