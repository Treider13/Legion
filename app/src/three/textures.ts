// ============================================================================
// LEGION — процедурные текстуры кибер-глаза (canvas, без внешних ассетов):
// «цифровые» дорожки-схемы (emissive/bump) и карта шероховатости металла.
// ============================================================================
import * as THREE from "three";

/** Дорожки-схемы: ломаные под 90° с контактными площадками + панельные швы.
 *  Используется как emissiveMap (светится) и bumpMap (гравировка). */
export function makeCircuitTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 2048;
  c.height = 1024;
  const g = c.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, c.width, c.height);

  // панельные швы — слабые линии
  g.strokeStyle = "rgba(255,255,255,0.16)";
  g.lineWidth = 3;
  for (let i = 0; i < 7; i++) {
    const y = ((i + 0.5) * c.height) / 7 + (Math.random() - 0.5) * 40;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(c.width, y);
    g.stroke();
  }
  for (let i = 0; i < 12; i++) {
    const x = Math.random() * c.width;
    g.beginPath();
    g.moveTo(x, Math.random() * c.height * 0.4);
    g.lineTo(x, Math.random() * c.height * 0.6 + c.height * 0.4);
    g.stroke();
  }

  // дорожки
  for (let t = 0; t < 90; t++) {
    let x = Math.random() * c.width;
    let y = Math.random() * c.height;
    const bright = Math.random() < 0.45;
    g.strokeStyle = bright ? "rgba(255,255,255,0.95)" : "rgba(255,255,255,0.4)";
    g.lineWidth = bright ? 3 : 2;
    g.beginPath();
    g.moveTo(x, y);
    const steps = 3 + Math.floor(Math.random() * 5);
    for (let s = 0; s < steps; s++) {
      const len = 20 + Math.random() * 90;
      if (s % 2 === 0) x += (Math.random() < 0.5 ? -1 : 1) * len;
      else y += (Math.random() < 0.5 ? -1 : 1) * len;
      g.lineTo(x, y);
    }
    g.stroke();
    if (bright) {
      g.fillStyle = "rgba(255,255,255,0.95)";
      g.fillRect(x - 4, y - 4, 8, 8);
    }
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 1);
  return tex;
}

/** Пятнистая карта шероховатости металла (микро-вариации бликов). */
export function makeMetalRoughness(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const g = c.getContext("2d")!;
  g.fillStyle = "#5a5a5a";
  g.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < 2600; i++) {
    const v = Math.floor(60 + Math.random() * 120);
    g.fillStyle = `rgba(${v},${v},${v},0.25)`;
    const r = 1 + Math.random() * 14;
    g.beginPath();
    g.arc(Math.random() * c.width, Math.random() * c.height, r, 0, 7);
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  return tex;
}

/** Круглый спрайт для частиц (иначе Points рисуются квадратами). */
export function makeDotSprite(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.6)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
