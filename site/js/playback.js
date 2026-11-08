// PISTA · Motores de reprodução
// SpotifyEngine: toca pelo Spotify (neste navegador via Web Playback SDK, ou em outro aparelho via Spotify Connect).
//   Não temos acesso ao áudio: só mandamos comandos (tocar, fila, pular, volume). Sem mixagem (D-01).
// DemoEngine: simula a reprodução, para testar o PISTA sem Spotify e com o tempo acelerado.

import { player as sp, loadSdk, getAccessToken, isBackoffActive } from './spotify.js';
export { LocalAudioEngine } from './audio.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const realClock = { now: () => Date.now(), speed: 1 };

export class SpotifyEngine {
  constructor({ deviceId = null, onEvent = () => {} } = {}) {
    this.kind = 'spotify';
    this.useSdk = !deviceId;
    this.deviceId = deviceId;
    this.onEvent = onEvent;
    this.clock = realClock;
    this.sdk = null;
    this.sdkState = null;
    this.cache = null;
    this.lastPoll = 0;
    this.volume = 0.8;
  }

  // Prepara o player do navegador (pode ser chamado antes do clique em Começar)
  async prepare() {
    if (!this.useSdk || this.sdk) return;
    const Spotify = await loadSdk();
    const p = new Spotify.Player({
      name: 'PISTA (navegador)',
      getOAuthToken: (cb) => { getAccessToken().then(cb).catch((e) => this.onEvent('error', { message: e.message })); },
      volume: this.volume,
    });
    this.sdk = p;
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('O player do Spotify não ficou pronto. Use Chrome ou Edge no computador e confira se a conta é Premium.')), 20000);
      p.addListener('ready', ({ device_id }) => { clearTimeout(timer); this.deviceId = device_id; resolve(); });
      p.addListener('initialization_error', ({ message }) => { clearTimeout(timer); reject(new Error(`Este navegador não suporta o player do Spotify: ${message}`)); });
      p.addListener('authentication_error', ({ message }) => { clearTimeout(timer); reject(new Error(`Falha de autenticação no player: ${message}`)); });
      p.addListener('account_error', () => { clearTimeout(timer); reject(new Error('O Spotify exige conta Premium para controlar a reprodução.')); });
    });
    p.addListener('not_ready', () => this.onEvent('device_lost', {}));
    p.addListener('playback_error', ({ message }) => this.onEvent('track_failed', { reason: message }));
    p.addListener('player_state_changed', (s) => { this.sdkState = s; });
    p.addListener('autoplay_failed', () => this.onEvent('autoplay_failed', {}));
    const ok = await p.connect();
    if (!ok) throw new Error('Não consegui conectar o player do Spotify neste navegador.');
    await ready;
  }

  // Precisa ser chamado dentro do clique (regra de autoplay dos navegadores)
  unlockAudio() { try { this.sdk?.activateElement?.(); } catch { /* ignore */ } }

  label() { return this.useSdk ? 'este navegador' : 'aparelho do Spotify'; }

  async start(uri, positionMs = 0) {
    if (this.useSdk && !this.sdk) await this.prepare();
    await sp.shuffleOff(this.deviceId).catch(() => {});
    await sp.repeatOff(this.deviceId).catch(() => {});
    await sp.play(this.deviceId, [uri], positionMs);
    this.lastPoll = 0;
  }

  async enqueue(uri) { await sp.queue(this.deviceId, uri); }

  async queueContains(uri) {
    try {
      const q = await sp.queueList();
      return (q?.queue || []).slice(0, 3).some((t) => t?.uri === uri);
    } catch { return false; }
  }

  async setVol(v) {
    v = Math.max(0, Math.min(1, v));
    if (this.useSdk && this.sdk) return this.sdk.setVolume(v);
    return sp.volume(this.deviceId, v * 100).catch(() => {});
  }

  async fade(from, to, ms, steps = 12) {
    if (!this.useSdk) steps = Math.min(steps, 5); // poupa a API em aparelho remoto
    for (let i = 1; i <= steps; i++) {
      await this.setVol(from + (to - from) * (i / steps));
      await sleep(ms / steps);
    }
  }

  async skip() {
    if (this.useSdk && this.sdk) {
      await this.fade(this.volume, 0.05, 1200);
      await this.sdk.nextTrack();
      await sleep(600);
      await this.setVol(this.volume);
    } else {
      await sp.next(this.deviceId);
    }
    this.lastPoll = 0;
  }

  async pause() {
    if (this.useSdk && this.sdk) { await this.fade(this.volume, 0.05, 800, 8); await this.sdk.pause(); await this.setVol(this.volume); }
    else await sp.pause(this.deviceId);
    this.lastPoll = 0;
  }

  async resume() {
    if (this.useSdk && this.sdk) await this.sdk.resume(); else await sp.resume(this.deviceId);
    this.lastPoll = 0;
  }

  async finish(fadeMs = 15000) {
    await this.fade(this.volume, 0, fadeMs, 20).catch(() => {});
    if (this.useSdk && this.sdk) await this.sdk.pause().catch(() => {}); else await sp.pause(this.deviceId).catch(() => {});
    await this.setVol(this.volume).catch(() => {});
  }

  async setUserVolume(v) { this.volume = v; await this.setVol(v); }

  // Estado normalizado: { active, paused, ids:[...], uri, positionMs, durationMs }
  async getState() {
    if (this.useSdk && this.sdk) {
      const s = (await this.sdk.getCurrentState().catch(() => null)) || this.sdkState;
      if (!s?.track_window?.current_track) return { active: !!s, paused: true, ids: [], positionMs: 0, durationMs: 0 };
      const ct = s.track_window.current_track;
      return {
        active: true, paused: s.paused, uri: ct.uri,
        ids: [ct.id, ct.linked_from?.id].filter(Boolean),
        name: ct.name,
        positionMs: s.position, durationMs: s.duration || ct.duration_ms,
      };
    }
    // Aparelho remoto: consulta com intervalo adaptativo (5 s, e 2 s perto do fim), respeitando 429
    const now = Date.now();
    const remaining = this.cache ? this.cache.durationMs - this.extrapolate(this.cache, now) : Infinity;
    const interval = remaining < 15000 ? 2000 : 5000;
    if (!this.cache || now - this.lastPoll >= interval) {
      this.lastPoll = now;
      try {
        const res = await sp.state();
        this.onEvent('spotify_poll', { status: res.status, latencyMs: res.latencyMs });
        const d = res.data;
        if (!d || !d.item) this.cache = { active: !!d, paused: true, ids: [], positionMs: 0, durationMs: 0, at: now };
        else this.cache = {
          active: true, paused: !d.is_playing, uri: d.item.uri,
          ids: [d.item.id, d.item.linked_from?.id].filter(Boolean),
          name: d.item.name,
          positionMs: d.progress_ms || 0, durationMs: d.item.duration_ms, at: now,
          deviceId: d.device?.id,
        };
      } catch (e) {
        this.onEvent('spotify_poll', { status: e.status || 0, error: e.message });
        if (!this.cache) return { active: false, paused: true, ids: [], positionMs: 0, durationMs: 0, offline: true };
        return { ...this.cache, positionMs: this.extrapolate(this.cache, now), offline: true };
      }
    }
    return { ...this.cache, positionMs: this.extrapolate(this.cache, now) };
  }

  extrapolate(c, now) { return c.paused ? c.positionMs : Math.min(c.durationMs, c.positionMs + (now - c.at)); }

  isRateLimited() { return isBackoffActive(); }

  destroy() { try { this.sdk?.disconnect(); } catch { /* ignore */ } }
}

// ---------------- Demonstração (sem Spotify) ----------------
export class DemoEngine {
  constructor({ library, speed = 1, onEvent = () => {} }) {
    this.kind = 'demo';
    this.byUri = new Map(library.map((t) => [t.uri, t]));
    this.onEvent = onEvent;
    this.queue = [];
    this.current = null;
    this.pos = 0;
    this.paused = true;
    this.speed = speed;
    this.sim = Date.now();
    this.lastReal = performance.now();
    this.volume = 0.8;
    const self = this;
    this.clock = { now: () => { self.advance(); return self.sim; }, get speed() { return self.speed; } };
  }
  label() { return 'simulação'; }
  async prepare() {}
  unlockAudio() {}
  setSpeed(s) { this.advance(); this.speed = s; }
  advance() {
    const real = performance.now();
    let dt = (real - this.lastReal) * this.speed;
    this.lastReal = real;
    this.sim += dt;
    while (!this.paused && this.current && dt > 0) {
      const left = this.current.durationMs - this.pos;
      if (dt < left) { this.pos += dt; dt = 0; break; }
      dt -= left;
      const nextUri = this.queue.shift();
      if (!nextUri) { this.current = null; this.pos = 0; this.paused = true; break; }
      this.current = this.byUri.get(nextUri);
      this.pos = 0;
    }
  }
  async start(uri, positionMs = 0) { this.advance(); this.current = this.byUri.get(uri); this.pos = positionMs; this.paused = false; }
  async enqueue(uri) { this.queue.push(uri); }
  async queueContains(uri) { return this.queue.includes(uri); }
  async skip() {
    this.advance();
    const nextUri = this.queue.shift();
    this.current = nextUri ? this.byUri.get(nextUri) : null;
    this.pos = 0;
    if (!this.current) this.paused = true;
  }
  async pause() { this.advance(); this.paused = true; }
  async resume() { this.advance(); if (this.current) this.paused = false; }
  async finish() { this.advance(); this.paused = true; }
  async setUserVolume(v) { this.volume = v; }
  isRateLimited() { return false; }
  async getState() {
    this.advance();
    if (!this.current) return { active: true, paused: true, ids: [], positionMs: 0, durationMs: 0 };
    return { active: true, paused: this.paused, uri: this.current.uri, ids: [this.current.id], name: this.current.title, positionMs: this.pos, durationMs: this.current.durationMs };
  }
  destroy() {}
}
