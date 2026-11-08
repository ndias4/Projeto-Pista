// PISTA · Motor de Áudio Local e Análise (Caminho B / Fase 1)
// Implementa Web Audio API: 2 decks, crossfade de potência constante,
// normalização de loudness (ITU-R BS.1770 simplificado / LUFS),
// detecção de silêncio (cue-in/cue-out) e extração de tags ID3 básicas.

export const TARGET_LUFS = -14; // Padrão de loudness para reprodução estável

// ---------- Leitura de Tags ID3 básicas ----------
export function parseAudioTags(buffer, filename = '') {
  const bytes = new Uint8Array(buffer);
  let title = '', artist = '', album = '', year = '', genre = '', coverUrl = '';

  // ID3v2
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const version = bytes[3];
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    let offset = 10;
    const end = Math.min(bytes.length, 10 + size);

    while (offset < end - 10) {
      let frameId = '';
      for (let i = 0; i < 4; i++) frameId += String.fromCharCode(bytes[offset + i]);
      if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

      let frameSize = 0;
      if (version === 4) {
        frameSize = ((bytes[offset + 4] & 0x7f) << 21) | ((bytes[offset + 5] & 0x7f) << 14) | ((bytes[offset + 6] & 0x7f) << 7) | (bytes[offset + 7] & 0x7f);
      } else {
        frameSize = (bytes[offset + 4] << 24) | (bytes[offset + 5] << 16) | (bytes[offset + 6] << 8) | bytes[offset + 7];
      }
      offset += 10;
      if (frameSize <= 0 || offset + frameSize > bytes.length) break;

      const frameData = bytes.subarray(offset, offset + frameSize);
      offset += frameSize;

      // Text decoding
      const decodeText = (d) => {
        if (!d || d.length < 2) return '';
        const enc = d[0];
        try {
          if (enc === 0) return new TextDecoder('iso-8859-1').decode(d.subarray(1)).replace(/\0+$/, '').trim();
          if (enc === 1 || enc === 2) return new TextDecoder('utf-16').decode(d.subarray(1)).replace(/\0+$/, '').trim();
          if (enc === 3) return new TextDecoder('utf-8').decode(d.subarray(1)).replace(/\0+$/, '').trim();
        } catch { /* fallback */ }
        return '';
      };

      if (frameId === 'TIT2') title = decodeText(frameData);
      else if (frameId === 'TPE1') artist = decodeText(frameData);
      else if (frameId === 'TALB') album = decodeText(frameData);
      else if (frameId === 'TYER' || frameId === 'TDRC') year = decodeText(frameData).slice(0, 4);
      else if (frameId === 'TCON') genre = decodeText(frameData);
      else if (frameId === 'APIC' && !coverUrl) {
        // Encontra mimetype e início dos bytes da imagem
        let p = 1;
        let mime = '';
        while (p < frameData.length && frameData[p] !== 0) { mime += String.fromCharCode(frameData[p]); p++; }
        p++; // skip null
        p++; // skip picture type
        while (p < frameData.length && frameData[p] !== 0) p++; // skip desc
        p++;
        if (p < frameData.length) {
          const imgBytes = frameData.subarray(p);
          try {
            const blob = new Blob([imgBytes], { type: mime || 'image/jpeg' });
            coverUrl = URL.createObjectURL(blob);
          } catch { /* ignore */ }
        }
      }
    }
  }

  // Fallback baseado no nome do arquivo: "Artista - Título.mp3" ou "Título.mp3"
  if (!title) {
    const base = filename.replace(/\.[a-zA-Z0-9]+$/, '').trim();
    if (base.includes(' - ')) {
      const parts = base.split(' - ');
      artist = artist || parts[0].trim();
      title = parts.slice(1).join(' - ').trim();
    } else {
      title = base;
      artist = artist || 'Artista Desconhecido';
    }
  }

  return { title, artist, album, year, genre, coverUrl };
}

// ---------- Análise de Loudness (ITU-R BS.1770 simplificado) ----------
export function measureLoudness(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  if (length === 0) return { lufs: -24, gainCorrection: 1, cueInSec: 0, cueOutSec: 0 };

  const left = audioBuffer.getChannelData(0);
  const right = numChannels > 1 ? audioBuffer.getChannelData(1) : left;

  // Detecção de Cue-In e Cue-Out (limiar de silêncio: -50 dBFS)
  const silenceThreshold = 0.003; // ~ -50 dB
  const step = Math.max(1, Math.floor(sampleRate * 0.05)); // blocos de 50ms
  let cueInSample = 0;
  for (let i = 0; i < length; i += step) {
    let max = 0;
    const end = Math.min(length, i + step);
    for (let k = i; k < end; k += 4) {
      const s = Math.abs(left[k]);
      if (s > max) max = s;
    }
    if (max > silenceThreshold) { cueInSample = i; break; }
  }

  let cueOutSample = length;
  for (let i = length - 1; i >= 0; i -= step) {
    let max = 0;
    const start = Math.max(0, i - step);
    for (let k = start; k <= i; k += 4) {
      const s = Math.abs(left[k]);
      if (s > max) max = s;
    }
    if (max > silenceThreshold) { cueOutSample = i; break; }
  }

  const cueInSec = Math.max(0, cueInSample / sampleRate);
  const cueOutSec = Math.min(length / sampleRate, cueOutSample / sampleRate);

  // Cálculo de RMS ponderado sobre amostras ativas
  let sumSquare = 0;
  let count = 0;
  const startIdx = cueInSample;
  const endIdx = cueOutSample;
  const stride = 8; // amostragem veloz para não bloquear a UI

  for (let i = startIdx; i < endIdx; i += stride) {
    const s = 0.5 * (left[i] + right[i]);
    sumSquare += s * s;
    count++;
  }

  const meanSquare = count > 0 ? sumSquare / count : 0.0001;
  const rmsDb = 10 * Math.log10(Math.max(1e-9, meanSquare));
  // Aproximação do LUFS integrado com ganho compensatório de ponderação K
  const lufs = Math.max(-60, Math.min(0, rmsDb + 0.691));

  // Ganho para atingir TARGET_LUFS (-14 LUFS) com segurança de limite (máx +6 dB)
  const deltaDb = Math.max(-12, Math.min(6, TARGET_LUFS - lufs));
  const gainCorrection = Math.pow(10, deltaDb / 20);

  return {
    lufs: Math.round(lufs * 10) / 10,
    gainCorrection: Math.round(gainCorrection * 100) / 100,
    cueInSec: Math.round(cueInSec * 10) / 10,
    cueOutSec: Math.round(cueOutSec * 10) / 10,
  };
}

// ---------- Motor de Reprodução com 2 Decks (Web Audio) ----------
export class LocalAudioEngine {
  constructor({ onEvent = () => {} } = {}) {
    this.kind = 'local';
    this.onEvent = onEvent;
    this.ctx = null;
    this.masterGain = null;
    this.limiter = null;
    this.volume = 0.8;

    // Dois decks (Deck A e Deck B)
    this.decks = {
      A: { id: 'A', source: null, gain: null, track: null, startCtxTime: 0, positionSec: 0, buffer: null },
      B: { id: 'B', source: null, gain: null, track: null, startCtxTime: 0, positionSec: 0, buffer: null },
    };
    this.activeDeckKey = 'A';
    this.queuedDeckKey = 'B';

    this.buffers = new Map(); // uri -> AudioBuffer
    this.files = new Map(); // uri -> File
    this.paused = true;
    this.pauseCtxTime = 0;
    this.clock = { now: () => Date.now(), speed: 1 };
  }

  label() { return 'áudio local (Web Audio)'; }

  isRateLimited() { return false; }

  async initAudioContext() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AudioCtx();

    // Limitador de saída (DynamicsCompressorNode) para evitar clipping digital
    this.limiter = this.ctx.createDynamicsCompressor();
    this.limiter.threshold.setValueAtTime(-1.0, this.ctx.currentTime);
    this.limiter.knee.setValueAtTime(0.0, this.ctx.currentTime);
    this.limiter.ratio.setValueAtTime(20.0, this.ctx.currentTime);
    this.limiter.attack.setValueAtTime(0.002, this.ctx.currentTime);
    this.limiter.release.setValueAtTime(0.1, this.ctx.currentTime);

    // Ganho mestre
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);

    // Conexões
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.ctx.destination);

    // Inicializa nós de ganho dos decks
    for (const k of ['A', 'B']) {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, this.ctx.currentTime);
      g.connect(this.masterGain);
      this.decks[k].gain = g;
    }
  }

  unlockAudio() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  async prepare() {
    await this.initAudioContext();
  }

  registerFile(track) {
    if (track._file) this.files.set(track.uri, track._file);
  }

  async loadBuffer(uri) {
    if (this.buffers.has(uri)) return this.buffers.get(uri);
    const file = this.files.get(uri);
    if (!file) throw new Error(`Arquivo não encontrado para: ${uri}`);

    await this.initAudioContext();
    const arrayBuffer = await file.arrayBuffer();
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.buffers.set(uri, audioBuffer);
    return audioBuffer;
  }

  // Inicia uma faixa no deck ativo
  async start(uri, positionMs = 0) {
    await this.initAudioContext();
    const active = this.decks[this.activeDeckKey];
    const buffer = await this.loadBuffer(uri);

    // Para qualquer reprodução anterior no deck ativo
    if (active.source) {
      try { active.source.stop(); active.source.disconnect(); } catch { /* ignore */ }
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(active.gain);

    const now = this.ctx.currentTime;
    const posSec = (positionMs || 0) / 1000;

    active.source = src;
    active.buffer = buffer;
    active.startCtxTime = now - posSec;
    active.gain.gain.cancelScheduledValues(now);
    active.gain.gain.setValueAtTime(1.0, now);

    src.start(now, posSec);
    this.paused = false;
  }

  // Enfileira a próxima no deck inativo e pré-carrega o áudio
  async enqueue(uri) {
    const buffer = await this.loadBuffer(uri);
    const queued = this.decks[this.queuedDeckKey];
    queued.buffer = buffer;
  }

  async queueContains(uri) {
    const queued = this.decks[this.queuedDeckKey];
    return queued.buffer && queued.track?.uri === uri;
  }

  // Crossfade de potência constante para a próxima música
  async crossfadeToNext(nextUri, durationSec = 4) {
    await this.initAudioContext();
    const fromDeck = this.decks[this.activeDeckKey];
    const toDeck = this.decks[this.queuedDeckKey];
    const buffer = await this.loadBuffer(nextUri);

    if (toDeck.source) {
      try { toDeck.source.stop(); toDeck.source.disconnect(); } catch { /* ignore */ }
    }

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(toDeck.gain);

    const now = this.ctx.currentTime;
    const dur = Math.max(1, durationSec);

    // Rampas de ganho de potência constante (Equal-Power Curve)
    const steps = 30;
    const outCurve = new Float32Array(steps);
    const inCurve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const frac = i / (steps - 1);
      outCurve[i] = Math.cos((frac * Math.PI) / 2);
      inCurve[i] = Math.sin((frac * Math.PI) / 2);
    }

    fromDeck.gain.gain.cancelScheduledValues(now);
    fromDeck.gain.gain.setValueCurveAtTime(outCurve, now, dur);

    toDeck.gain.gain.cancelScheduledValues(now);
    toDeck.gain.gain.setValueCurveAtTime(inCurve, now, dur);

    toDeck.source = src;
    toDeck.buffer = buffer;
    toDeck.startCtxTime = now;
    src.start(now, 0);

    // Ao fim do crossfade, desativa o deck antigo e troca as chaves
    setTimeout(() => {
      try { fromDeck.source?.stop(); fromDeck.source?.disconnect(); } catch { /* ignore */ }
      fromDeck.source = null;
      fromDeck.gain.gain.setValueAtTime(0, this.ctx.currentTime);
    }, dur * 1000 + 100);

    const temp = this.activeDeckKey;
    this.activeDeckKey = this.queuedDeckKey;
    this.queuedDeckKey = temp;
  }

  async skip() {
    const queued = this.decks[this.queuedDeckKey];
    if (queued.buffer) {
      await this.crossfadeToNext(queued.track?.uri, 2.0);
    } else {
      await this.fadeVolume(this.volume, 0.05, 500);
      this.pause();
    }
  }

  async pause() {
    if (!this.ctx || this.paused) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.linearRampToValueAtTime(0.01, now + 0.3);
    setTimeout(async () => {
      if (this.ctx.state === 'running') await this.ctx.suspend();
      this.paused = true;
    }, 320);
  }

  async resume() {
    if (!this.ctx) await this.initAudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(0.01, now);
    this.masterGain.gain.linearRampToValueAtTime(this.volume, now + 0.3);
    this.paused = false;
  }

  async finish(fadeMs = 12000) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const durSec = fadeMs / 1000;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.linearRampToValueAtTime(0.0, now + durSec);
    setTimeout(() => {
      this.pause();
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }, fadeMs + 200);
  }

  async setUserVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setValueAtTime(this.volume, this.ctx.currentTime);
    }
  }

  async fadeVolume(from, to, ms) {
    if (!this.masterGain || !this.ctx) return;
    const now = this.ctx.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setValueAtTime(from, now);
    this.masterGain.gain.linearRampToValueAtTime(to, now + ms / 1000);
  }

  async getState() {
    if (!this.ctx || this.paused) {
      return { active: true, paused: true, ids: [], positionMs: 0, durationMs: 0 };
    }
    const active = this.decks[this.activeDeckKey];
    if (!active.source || !active.buffer) {
      return { active: true, paused: true, ids: [], positionMs: 0, durationMs: 0 };
    }

    const elapsedSec = Math.max(0, this.ctx.currentTime - active.startCtxTime);
    const durationMs = Math.round(active.buffer.duration * 1000);
    const positionMs = Math.min(durationMs, Math.round(elapsedSec * 1000));

    return {
      active: true,
      paused: this.ctx.state === 'suspended',
      ids: active.track ? [active.track.id] : [],
      uri: active.track?.uri,
      name: active.track?.title,
      positionMs,
      durationMs,
    };
  }

  destroy() {
    try {
      this.decks.A.source?.stop();
      this.decks.B.source?.stop();
      this.ctx?.close();
    } catch { /* ignore */ }
  }
}
