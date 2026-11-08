// PISTA · Planejador de sequência (determinístico)
// Implementa a proposta da Parte 03 §4 da análise: curva de energia-alvo por fase,
// pontuação por candidata e busca em feixe (largura 5, profundidade 3) com semente fixa.
// Não depende de rede nem de IA: mesma biblioteca + mesma semente = mesma ordem.

export const PHASE_KINDS = ['warmup', 'peak', 'closing'];
export const PHASE_LABEL = { warmup: 'Aquecimento', peak: 'Pico', closing: 'Fim de noite' };

export const GENRES = [
  'funk', 'pagode/samba', 'sertanejo', 'pop', 'eletrônica', 'rock', 'mpb',
  'hip-hop/rap', 'latino', 'forró/piseiro', 'axé', 'r&b/soul', 'outro',
];

const W = {
  energy: 3,          // w1 · |E_faixa − E_alvo|
  jump: 1.5,          // custo de transição: salto de energia > 2 níveis em relação à anterior
  artistNear: 6,      // w3 · artista repetido nas últimas 3
  artistFar: 3,       //      artista repetido nas últimas 8
  genre: 1.2,         // w4 · troca de gênero (só se o gênero for conhecido)
  played: 100,        // w5 · já tocou nesta festa
  phaseAdjacent: 3,   // faixa presa a uma fase vizinha
  phaseFar: 6,        // faixa presa à fase oposta
  jitter: 0.35,       // desempate determinístico pela semente
};

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Hash determinístico (FNV-1a) → [0, 1)
export function hash01(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % 100000) / 100000;
}

// Modelo padrão (03 §4): Aquecimento 2→3, Pico 4→5, Fim de noite 3→2
export function defaultPhases(durationMin, peakOffsetMin = null) {
  const d = Math.max(30, durationMin);
  let warmEnd = Math.round(d * 0.25);
  let closeStart = Math.round(d * 0.8);
  if (peakOffsetMin != null && peakOffsetMin > 0 && peakOffsetMin < d) {
    // O pico (o "auge" pedido pelo anfitrião) deve cair dentro da fase Pico, mais para o fim dela
    warmEnd = clamp(Math.round(peakOffsetMin - d * 0.35), 15, Math.round(d * 0.5));
    closeStart = clamp(Math.round(peakOffsetMin + d * 0.15), warmEnd + 20, d - 10);
  }
  return [
    { kind: 'warmup', startOffsetMin: 0, energyStart: 2, energyEnd: 3 },
    { kind: 'peak', startOffsetMin: warmEnd, energyStart: 4, energyEnd: 5 },
    { kind: 'closing', startOffsetMin: closeStart, energyStart: 3, energyEnd: 2 },
  ];
}

export function validatePhases(phases, durationMin) {
  if (!Array.isArray(phases) || phases.length !== 3) return 'São necessárias 3 fases.';
  for (let i = 0; i < 3; i++) {
    const p = phases[i];
    if (p.kind !== PHASE_KINDS[i]) return 'As fases precisam estar na ordem Aquecimento, Pico, Fim de noite.';
    if (!(p.energyStart >= 1 && p.energyStart <= 5 && p.energyEnd >= 1 && p.energyEnd <= 5)) return 'Energia precisa ficar entre 1 e 5.';
    if (i === 0 && p.startOffsetMin !== 0) return 'O Aquecimento começa no minuto 0.';
    if (i > 0 && !(p.startOffsetMin > phases[i - 1].startOffsetMin)) return 'Os horários das fases precisam ser crescentes.';
    if (p.startOffsetMin >= durationMin) return 'Uma fase começa depois do fim da festa.';
  }
  return null;
}

export function phaseAt(party, offsetMin) {
  const phases = party.phases;
  let idx = 0;
  for (let i = 0; i < phases.length; i++) if (offsetMin >= phases[i].startOffsetMin) idx = i;
  const start = phases[idx].startOffsetMin;
  const end = idx + 1 < phases.length ? phases[idx + 1].startOffsetMin : party.durationMin;
  const progress = clamp((offsetMin - start) / Math.max(1, end - start), 0, 1);
  return { phase: phases[idx], index: idx, progress, start, end };
}

// Curva de energia-alvo E(t), 1..5. No Pico há um "respiro" de ~6 min a cada ~40 min.
export function targetEnergy(party, offsetMin, bias = 0) {
  const { phase, progress, start } = phaseAt(party, offsetMin);
  let e = phase.energyStart + (phase.energyEnd - phase.energyStart) * progress;
  if (phase.kind === 'peak' && party.breathers !== false) {
    const inPeak = offsetMin - start;
    if (inPeak > 20 && inPeak % 40 >= 34) e -= 1;
  }
  return clamp(e + bias, 1, 5);
}

const PHASE_ORDER = { warmup: 0, peak: 1, closing: 2 };

function artistOverlap(a, b) {
  if (!a || !b) return false;
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

// Custo de uma candidata (menor é melhor) + explicação legível
export function scoreCandidate(track, ctx) {
  const { party, offsetMin, bias, history, byId, seed, distinctArtists } = ctx;
  const target = targetEnergy(party, offsetMin, bias);
  const ph = phaseAt(party, offsetMin).phase.kind;
  const parts = [];
  let cost = W.energy * Math.abs(track.energy - target);

  if (track.phase && track.phase !== ph) {
    const dist = Math.abs(PHASE_ORDER[track.phase] - PHASE_ORDER[ph]);
    cost += dist === 1 ? W.phaseAdjacent : W.phaseFar;
    parts.push('fora da fase');
  }

  const prev = history.length ? byId.get(history[history.length - 1]) : null;
  if (prev) {
    const jump = Math.abs(track.energy - prev.energy);
    if (jump > 2) cost += W.jump * (jump - 2);
    if (prev.genre && track.genre && prev.genre !== track.genre) { cost += W.genre; parts.push('troca de gênero'); }
  }

  const window = distinctArtists >= 15 ? 8 : 3;
  for (let k = 1; k <= Math.min(window, history.length); k++) {
    const h = byId.get(history[history.length - k]);
    if (h && artistOverlap(h.artistKeys, track.artistKeys)) {
      cost += k <= 3 ? W.artistNear : W.artistFar;
      parts.push('artista recente');
      break;
    }
  }

  const lastIdx = history.lastIndexOf(track.id);
  if (lastIdx >= 0) {
    // Só repete se a biblioteca acabar; prefere a que tocou há mais tempo
    const ago = history.length - lastIdx;
    cost += W.played + 50 / ago;
    parts.push('repetida');
  }

  cost += W.jitter * hash01(`${seed}|${track.id}|${history.length}`);
  return { cost, target, reason: parts };
}

function rank(library, ctx, limit) {
  const out = [];
  for (const t of library) {
    if (t.neverPlay) continue;
    const s = scoreCandidate(t, ctx);
    out.push({ track: t, ...s });
  }
  out.sort((a, b) => a.cost - b.cost || (a.track.id < b.track.id ? -1 : 1));
  return out.slice(0, limit);
}

export function countArtists(library) {
  const set = new Set();
  for (const t of library) if (!t.neverPlay) for (const a of t.artistKeys || []) set.add(a);
  return set.size;
}

/**
 * Escolhe a próxima faixa.
 * state = { party, library, byId, history: string[] (ids já tocados/agendados, em ordem),
 *           offsetMin (minuto previsto em que a faixa vai começar), bias (−2..+2) }
 */
export function nextTrack(state, width = 5, depth = 3) {
  const { party, library } = state;
  const byId = state.byId || new Map(library.map((t) => [t.id, t]));
  const distinctArtists = countArtists(library);
  const playable = library.filter((t) => !t.neverPlay);
  if (!playable.length) return null;

  let beams = [{ seq: [], cost: 0, hist: state.history.slice(), offset: state.offsetMin, first: null }];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const b of beams) {
      const ctx = { party, offsetMin: b.offset, bias: state.bias || 0, history: b.hist, byId, seed: party.seed, distinctArtists };
      for (const c of rank(playable, ctx, width * 2)) {
        next.push({
          seq: [...b.seq, c.track.id],
          cost: b.cost + c.cost * (d === 0 ? 1 : 0.7),
          hist: [...b.hist, c.track.id],
          offset: b.offset + (c.track.durationMs || 180000) / 60000,
          first: b.first || c,
        });
      }
    }
    next.sort((a, b) => a.cost - b.cost || (a.seq.join() < b.seq.join() ? -1 : 1));
    beams = next.slice(0, width);
    if (!beams.length) break;
  }
  const best = beams[0];
  const first = best.first;
  return { track: first.track, target: first.target, reason: first.reason, cost: first.cost };
}

// Prévia das próximas n faixas (não agenda nada)
export function planAhead(state, n = 5) {
  const out = [];
  const hist = state.history.slice();
  let offset = state.offsetMin;
  for (let i = 0; i < n; i++) {
    const pick = nextTrack({ ...state, history: hist, offsetMin: offset });
    if (!pick) break;
    out.push({ ...pick, offsetMin: offset });
    hist.push(pick.track.id);
    offset += (pick.track.durationMs || 180000) / 60000;
  }
  return out;
}

// Palpite inicial de energia só pelo título (sem IA, sem dados de áudio). O anfitrião corrige.
export function guessFromTitle(title = '') {
  const t = title.toLowerCase();
  const live = /\bao vivo\b|\(live\)|- live\b|\blive at\b|\bao-vivo\b/.test(t);
  if (/ac[uú]stic|acoustic|piano|lo-?fi|unplugged|voz e viol[aã]o|slowed/.test(t)) return { energy: 2, live };
  if (/remix|club mix|extended|bootleg|edit\b|vip mix|rework/.test(t)) return { energy: 4, live };
  return { energy: 3, live };
}

export function normalizeKey(s = '') {
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
}
