// PISTA · Controlador da festa
// Máquina de estados: pronta → tocando ⇄ pausada → encerrando → encerrada.
// Mantém sempre 1 faixa comprometida na fila do Spotify (a fila do Spotify não pode ser reordenada
// nem esvaziada pela API — por isso o lookahead é curto) e replaneja o resto a cada evento.

import { nextTrack, planAhead, phaseAt, targetEnergy, clamp, PHASE_LABEL } from './planner.js';

export const APP_VERSION = '0.1.0-teste';

export class Conductor {
  constructor({ party, library, engine, onChange = () => {}, onToast = () => {}, saved = null }) {
    this.party = party;
    this.library = library;
    this.byId = new Map(library.map((t) => [t.id, t]));
    this.engine = engine;
    this.clock = engine.clock;
    this.onChange = onChange;
    this.onToast = onToast;
    this.live = {
      ...(saved?.live || {
        status: 'ready', currentId: null, committedId: null, committedReason: null,
        played: [], bias: 0, startedAt: null, lastPhase: null, pausedByHost: false,
      }),
      priority: Array.isArray(saved?.live?.priority) ? [...saved.live.priority] : [],
    };
    this.log = saved?.log || [];
    this.stateCache = null;
    this.idleSince = null;
    this.busy = false;
    this.timer = null;
    this.lastSave = 0;
    this.graceUntil = 0;
    this.connectionState = 'online'; // 'online' | 'limited' | 'offline'
  }

  // Depois de um comando, o estado do Spotify leva ~1-2 s para refletir a mudança
  grace(ms = 3500) { this.graceUntil = Date.now() + ms; this.idleSince = null; }

  // ---------- tempo ----------
  elapsedMin() {
    if (!this.live.startedAt) return 0;
    return (this.clock.now() - this.live.startedAt) / 60000;
  }
  phaseInfo(offset = this.elapsedMin()) { return phaseAt(this.party, offset); }
  target(offset = this.elapsedMin()) { return targetEnergy(this.party, offset, this.live.bias); }

  // ---------- log (05 §3) ----------
  event(type, data = {}) {
    const t = this.live.startedAt ? Math.round(this.clock.now() - this.live.startedAt) : 0;
    this.log.push({ type, t, partyId: this.party.id, appVersion: APP_VERSION, ...data });
    if (this.log.length > 5000) this.log.splice(0, this.log.length - 5000);
  }

  track(id) { return this.byId.get(id); }

  history() {
    const h = this.live.played.slice();
    if (this.live.committedId) h.push(this.live.committedId);
    return h;
  }

  remainingCurrentMin() {
    const s = this.stateCache;
    const cur = this.track(this.live.currentId);
    if (!cur) return 0;
    const pos = s && this.matches(s, this.live.currentId) ? s.positionMs : 0;
    return Math.max(0, (cur.durationMs - pos) / 60000);
  }

  pickNext(offsetMin) {
    return nextTrack({ party: this.party, library: this.library, byId: this.byId, history: this.history(), offsetMin, bias: this.live.bias });
  }

  preview(n = 5) {
    const committed = this.track(this.live.committedId);
    const out = [];
    if (committed) out.push({ track: committed, committed: true, reason: this.live.committedReason || [], offsetMin: this.elapsedMin() + this.remainingCurrentMin() });

    const priorityQueue = [];
    for (const id of this.live.priority || []) {
      const track = this.track(id);
      if (!track || track.neverPlay || this.live.played.includes(id)) continue;
      priorityQueue.push({ track, committed: false, reason: ['pedido de convidado'], offsetMin: this.elapsedMin() + this.remainingCurrentMin() + (committed ? committed.durationMs / 60000 : 0) + priorityQueue.length * (track.durationMs / 60000) });
    }
    if (priorityQueue.length) {
      out.push(...priorityQueue.slice(0, Math.max(0, n - out.length)));
    }

    const start = this.elapsedMin() + this.remainingCurrentMin() + (committed ? committed.durationMs / 60000 : 0);
    const more = planAhead({ party: this.party, library: this.library, byId: this.byId, history: this.history(), offsetMin: start, bias: this.live.bias }, Math.max(0, n - out.length));
    return out.concat(more.map((m) => ({ ...m, committed: false })));
  }

  matches(state, id) {
    if (!state || !id) return false;
    const t = this.track(id);
    return state.ids?.includes(id) || (t && state.uri === t.uri);
  }

  // ---------- ciclo ----------
  async begin() {
    if (this.live.status !== 'ready') return;
    this.live.startedAt = this.clock.now();
    this.event('party_started', { librarySize: this.library.length });
    const first = this.pickNext(0);
    if (!first) throw new Error('Nenhuma faixa disponível para tocar.');
    this.live.currentId = first.track.id;
    this.live.played.push(first.track.id);
    this.grace();
    await this.engine.start(first.track.uri);
    this.event('first_audio', { msSincePartyCreated: Date.now() - (this.party.createdAt || Date.now()) });
    this.event('track_started', { trackId: first.track.id, transitionType: 'start', reason: first.reason });
    this.live.status = 'playing';
    await this.commitNext();
    this.startLoop();
    this.save(true);
    this.changed();
  }

  async resumeSaved() {
    // Retomar após recarregar a página (RF-17)
    const cur = this.track(this.live.currentId);
    if (!cur) throw new Error('Não encontrei a faixa da festa salva.');
    const pos = this.live.savedPositionMs || 0;
    this.grace();
    await this.engine.start(cur.uri, pos);
    this.event('party_resumed', { positionMs: pos });
    const committed = this.track(this.live.committedId);
    if (committed && !(await this.engine.queueContains(committed.uri))) await this.engine.enqueue(committed.uri);
    else if (!committed) await this.commitNext();
    this.live.status = 'playing';
    this.live.pausedByHost = false;
    this.startLoop();
    this.changed();
  }

  async commitNext() {
    const offset = this.elapsedMin() + this.remainingCurrentMin();
    let pick = null;

    if (this.live.priority && this.live.priority.length) {
      const remaining = [];
      for (const id of this.live.priority) {
        const track = this.track(id);
        if (!track || track.neverPlay || this.live.played.includes(id) || this.live.currentId === id) {
          continue;
        }
        pick = { track, reason: ['pedido de convidado'], target: offset };
        break;
      }
      this.live.priority = this.live.priority.filter((id) => id !== pick?.track?.id);
    }

    if (!pick) {
      pick = this.pickNext(offset);
      if (!pick) { this.live.committedId = null; this.live.committedReason = null; return; }
    }

    try {
      await this.engine.enqueue(pick.track.uri);
      this.live.committedId = pick.track.id;
      this.live.committedReason = pick.reason;
      this.event('queued', { trackId: pick.track.id, target: Math.round((pick.target ?? offset) * 10) / 10, reason: pick.reason });
    } catch (e) {
      this.live.committedId = null;
      this.live.committedReason = null;
      this.event('track_failed', { trackId: pick.track.id, reason: `fila: ${e.message}` });
      this.onToast(`Não consegui colocar a próxima na fila: ${e.message}`, 'warn');
    }
  }

  startLoop() {
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 1000);
  }
  stopLoop() { clearInterval(this.timer); this.timer = null; }

  async tick() {
    if (this.busy || !['playing', 'paused'].includes(this.live.status)) return;
    this.busy = true;
    try {
      const s = await this.engine.getState();
      this.stateCache = s;
      const elapsed = this.elapsedMin();

      if (s.offline) this.connectionState = 'offline';
      else if (this.engine.isRateLimited?.()) this.connectionState = 'limited';
      else this.connectionState = 'online';

      // Mudança de fase
      const ph = this.phaseInfo(elapsed).phase.kind;
      if (this.live.lastPhase !== ph) {
        if (this.live.lastPhase) { this.event('phase_changed', { phase: ph }); this.onToast(`Agora: ${PHASE_LABEL[ph]}`, 'info'); this.live.bias = 0; }
        this.live.lastPhase = ph;
      }

      // Fim automático da festa
      if (elapsed >= this.party.durationMin && this.live.status === 'playing') {
        await this.end('auto');
        return;
      }

      if (this.live.status === 'playing' && Date.now() >= this.graceUntil) {
        if (!this.live.committedId && s.active) {
          await this.commitNext();
        }

        if (s.active && s.ids?.length && !this.matches(s, this.live.currentId)) {
          if (this.matches(s, this.live.committedId)) await this.advance();
          else this.externalTrack(s);
          this.idleSince = null;
        } else if (!s.active || s.paused || !s.ids?.length) {
          // Silêncio inesperado: espera 3 s (troca de faixa) e então recupera tocando a comprometida
          if (!this.idleSince) this.idleSince = Date.now();
          const idle = Date.now() - this.idleSince;
          if (idle > 3000 && !s.offline) {
            this.event('silence_detected', { ms: idle });
            await this.recover(s);
            this.idleSince = null;
          }
        } else {
          this.idleSince = null;
        }
      }
      this.save();
      this.changed();
    } catch (e) {
      if (e.revoked) { this.onToast(e.message, 'error'); this.event('token_revoked'); }
      else console.warn('tick', e);
    } finally {
      this.busy = false;
    }
  }

  async advance() {
    const prev = this.live.currentId;
    this.live.currentId = this.live.committedId;
    this.live.played.push(this.live.committedId);
    this.event('transition_executed', { from: prev, to: this.live.currentId, transitionType: 'spotify_queue' });
    this.event('track_started', { trackId: this.live.currentId, transitionType: 'queue', reason: this.live.committedReason });
    this.live.committedId = null;
    await this.commitNext();
  }

  externalTrack(s) {
    const id = s.ids[0];
    this.event('external_track', { trackId: id });
    this.live.currentId = id;
    if (this.byId.has(id)) this.live.played.push(id);
    else this.byId.set(id, { id, uri: s.uri, title: s.name || 'Faixa fora do plano', artist: '', artistKeys: [], durationMs: s.durationMs, energy: 3, external: true });
    this.onToast('O Spotify tocou uma faixa fora do plano (talvez havia algo na fila antiga). Use Pular se quiser.', 'warn');
  }

  async recover(s) {
    let id = this.live.committedId;
    if (!id) { const p = this.pickNext(this.elapsedMin()); id = p?.track.id; }
    const t = this.track(id);
    if (!t) return;
    this.onToast('Silêncio detectado: retomando a música.', 'warn');
    try {
      this.grace();
      await this.engine.start(t.uri);
      this.live.currentId = id;
      this.live.played.push(id);
      this.live.committedId = null;
      this.event('track_started', { trackId: id, transitionType: 'recovery' });
      await this.commitNext();
    } catch (e) {
      this.onToast(`Não consegui retomar: ${e.message}`, 'error');
      if (!s.active) this.event('output_device_changed', { lost: true });
    }
  }

  // ---------- controles do anfitrião (RF-10) ----------
  intervention(kind, extra = {}) { this.event('intervention', { kind, ...extra }); }

  async pause() {
    if (this.live.status !== 'playing') return;
    this.intervention('pause');
    this.live.status = 'paused';
    this.live.pausedByHost = true;
    this.changed();
    await this.engine.pause();
  }
  async resume() {
    if (this.live.status !== 'paused') return;
    this.intervention('resume');
    this.live.status = 'playing';
    this.live.pausedByHost = false;
    this.grace(2500);
    this.changed();
    await this.engine.resume();
  }
  async skip() {
    if (this.live.status !== 'playing') return;
    this.intervention('skip', { trackId: this.live.currentId });
    this.grace(4000); // dá tempo para a troca acontecer
    await this.engine.skip();
  }
  energy(delta) {
    this.live.bias = clamp(this.live.bias + delta, -2, 2);
    this.intervention(delta > 0 ? 'energy_up' : 'energy_down', { bias: this.live.bias });
    this.save(true);
    this.changed();
  }
  async playNow(id) {
    const t = this.track(id);
    if (!t) return;
    this.intervention('play_now', { targetTrackId: id });
    this.grace();
    await this.engine.start(t.uri);
    this.live.currentId = id;
    this.live.played.push(id);
    this.event('track_started', { trackId: id, transitionType: 'play_now' });
    if (this.live.status === 'paused') { this.live.status = 'playing'; this.live.pausedByHost = false; }
    this.idleSince = null;
    // A comprometida continua na fila do Spotify e toca em seguida.
    this.save(true);
    this.changed();
  }

  playNext(id) {
    const t = this.track(id);
    if (!t) return;
    if (!this.live.priority) this.live.priority = [];
    if (!this.live.priority.includes(id)) this.live.priority.push(id);
    this.intervention('play_next', { targetTrackId: id });
    this.save(true);
    this.changed();
  }
  async neverAgain(trackId = null) {
    const id = trackId || this.live.currentId;
    const t = this.track(id);
    if (!t) return;
    t.neverPlay = true;
    this.intervention('never_again', { trackId: t.id });
    this.onToast(`"${t.title}" não toca mais.`, 'info');
    if (!trackId || id === this.live.currentId) {
      await this.skip();
    } else {
      if (this.live.committedId === id) {
        this.live.committedId = null;
        await this.commitNext();
      }
      this.save(true);
      this.changed();
    }
  }
  badTransition() {
    const last = [...this.log].reverse().find((e) => e.type === 'track_started');
    this.intervention('bad_transition', { trackId: last?.trackId });
    this.event('bad_transition', { trackId: last?.trackId });
    this.onToast('Anotado: transição ruim.', 'info');
    this.save(true);
  }

  async end(reason = 'host') {
    if (['ending', 'closed'].includes(this.live.status)) return;
    this.live.status = 'ending';
    this.changed();
    this.stopLoop();
    if (reason === 'host') this.intervention('end');
    try { await this.engine.finish(this.engine.kind === 'demo' ? 0 : 15000); } catch { /* ignore */ }
    this.live.status = 'closed';
    this.event('party_closed', { reason });
    this.save(true);
    this.changed();
  }

  summary() {
    const iv = this.log.filter((e) => e.type === 'intervention' && !['end', 'resume'].includes(e.kind));
    const byKind = {};
    for (const e of iv) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    const lastT = this.log.length ? this.log[this.log.length - 1].t : 0;
    const hours = Math.max(lastT / 3600000, 1 / 60);
    const started = this.log.filter((e) => e.type === 'track_started').length;
    return {
      tracksPlayed: started,
      minutes: Math.round(lastT / 60000),
      interventions: iv.length,
      perHour: Math.round((iv.length / hours) * 10) / 10,
      byKind,
      badTransitions: this.log.filter((e) => e.type === 'bad_transition').length,
      silences: this.log.filter((e) => e.type === 'silence_detected').length,
      external: this.log.filter((e) => e.type === 'external_track').length,
    };
  }

  snapshot() {
    return {
      party: this.party,
      live: { ...this.live, priority: [...(this.live.priority || [])], savedPositionMs: this.stateCache?.positionMs || 0 },
      log: this.log,
      engine: this.engine.kind,
    };
  }
  save(force = false) {
    if (!force && Date.now() - this.lastSave < 5000) return;
    this.lastSave = Date.now();
    this.onSave?.(this.snapshot());
  }
  changed() { try { this.onChange(this); } catch (e) { console.error(e); } }
  destroy() { this.stopLoop(); this.engine.destroy?.(); }
}
