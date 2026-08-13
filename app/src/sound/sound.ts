// ============================================================================
// LEGION — звуковой дизайн (S5/S7): синтез через WebAudio, ноль аудио-ассетов
// (офлайн для Tauri/ESP32; отклонение от Howler/Tone.js сознательное —
//  те же звуки без ~100 КБ библиотек и бинарей).
// ============================================================================

let ctx: AudioContext | null = null;
let muted = false;

export function setMuted(m: boolean): void {
  muted = m;
}

function ac(): AudioContext | null {
  if (muted) return null;
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function envelope(gain: GainNode, t0: number, peak: number, dur: number): void {
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(peak, t0 + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
}

/** Механический клик (кнопки) */
export function uiClick(): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(2100, t0);
  osc.frequency.exponentialRampToValueAtTime(1400, t0 + 0.03);
  envelope(g, t0, 0.05, 0.045);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.05);
}

/** Захват петли — восходящий чирp (S5) */
export function lockChirp(): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(820, t0);
  osc.frequency.exponentialRampToValueAtTime(1660, t0 + 0.11);
  envelope(g, t0, 0.08, 0.16);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.17);
}

/** Потеря захвата — нисходящий тик */
export function unlockTick(): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(1500, t0);
  osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.09);
  envelope(g, t0, 0.06, 0.12);
  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + 0.13);
}

/** Радио-шквал (squelch) при старте/стопе коридора */
export function squelch(): void {
  const c = ac();
  if (!c) return;
  const t0 = c.currentTime;
  const len = Math.floor(c.sampleRate * 0.09);
  const buffer = c.createBuffer(1, len, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < len; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  }
  const src = c.createBufferSource();
  src.buffer = buffer;
  const g = c.createGain();
  const f = c.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = 1800;
  f.Q.value = 0.7;
  envelope(g, t0, 0.09, 0.09);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t0);
}
