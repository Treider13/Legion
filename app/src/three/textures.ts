// ============================================================================
// LEGION — процедурные текстуры для реалистичного глаза (кожа век/оправы).
// Генерируются на canvas в рантайме (без внешних ассетов).
// ============================================================================
import * as THREE from "three";

/** Bump-карта кожи: поры + мелкие морщинки. Возвращает tiled CanvasTexture. */
export function makeSkinBump(size = 512): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#808080";
  ctx.fillRect(0, 0, size, size);

  // поры — множество мелких светлых/тёмных точек
  const pores = Math.floor(size * size * 0.05);
  for (let i = 0; i < pores; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = Math.random() * 1.7 + 0.4;
    const light = Math.random() < 0.5;
    ctx.globalAlpha = 0.06 + Math.random() * 0.12;
    ctx.fillStyle = light ? "#ffffff" : "#000000";
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  // тонкие морщинки-штрихи
  ctx.globalAlpha = 0.08;
  ctx.strokeStyle = "#000000";
  ctx.lineWidth = 1;
  for (let i = 0; i < size * 0.4; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const len = 6 + Math.random() * 26;
    const a = Math.random() * Math.PI;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 3);
  return tex;
}
