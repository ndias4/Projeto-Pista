// PISTA · interface (versão de teste)
import { store } from './store.js';
import * as S from './spotify.js';
import { defaultPhases, validatePhases, targetEnergy, phaseAt, guessFromTitle, PHASE_LABEL, PHASE_KINDS, hash01, normalizeKey } from './planner.js';
import { Conductor, APP_VERSION } from './conductor.js';
import { SpotifyEngine, DemoEngine, LocalAudioEngine } from './playback.js';
import { demoLibrary } from './demo.js';
import { claudeSettings, interpretIntent, estimateTracks, DEFAULT_MODEL } from './claude.js';
import { parseAudioTags } from './audio.js';

const EXPECTED_ORIGIN = 'http://127.0.0.1:8888';
const ENERGY_WORDS = ['', 'Calma', 'Leve', 'Média', 'Animada', 'Pista cheia'];
const SRC_LABEL = { host: 'você', guess: 'palpite', playlist: 'fase da playlist', claude: 'Claude', demo: 'demo', local: 'arquivo local' };

const app = {
  screen: 'loading',
  demo: false,
  sourceKind: 'spotify', // 'spotify' | 'local' | 'demo'
  me: null,
  playlists: [],
  selected: new Set(store.get('selectedPlaylists', [])),
  playlistPhase: store.get('playlistPhase', {}),
  library: [],
  party: null,
  engine: null,
  engineStatus: '',
  conductor: null,
  device: 'browser',
  devices: [],
  filter: '',
  sort: 'playlist',
  showAll: false,
  demoSpeed: 30,
  intentNotes: '',
  guestRequests: [],
};

// ---------------- utilidades ----------------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtMs = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtMin = (m) => { m = Math.max(0, Math.round(m)); const h = Math.floor(m / 60); return h ? `${h}h${String(m % 60).padStart(2, '0')}` : `${m} min`; };
const uid = () => Math.random().toString(36).slice(2, 10);

function toast(msg, kind = 'info', ms = 4500) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, ms);
}

function go(screen) {
  app.screen = screen;
  render();
  window.scrollTo({ top: 0 });
}

function openOverlay(html, cls = '') {
  const ov = $('#overlay');
  ov.innerHTML = `<div class="sheet ${cls}" role="dialog" aria-modal="true">${html}</div>`;
  ov.hidden = false;
  setTimeout(() => ov.querySelector('input, button, select, textarea')?.focus(), 30);
}
function closeOverlay() { const ov = $('#overlay'); ov.hidden = true; ov.innerHTML = ''; }

function confirmBox(title, text, okLabel, onOk, danger = false) {
  openOverlay(`
    <h2>${esc(title)}</h2><p>${esc(text)}</p>
    <div class="row end"><button class="btn ghost" data-act="close">Cancelar</button>
    <button class="btn ${danger ? 'danger' : 'primary'}" id="confirm-ok">${esc(okLabel)}</button></div>`, 'small');
  $('#confirm-ok').onclick = () => { closeOverlay(); onOk(); };
}

// ---------------- biblioteca e notas de energia (com Memória Musical Canônica) ----------------
function makeCanonicalKey(title, artist) {
  const t = normalizeKey(title || '');
  const a = normalizeKey(artist || '');
  return t ? `${t}|${a}` : '';
}

function tags() { return store.get('tags', {}); }
function saveTag(id, patch, track = null) {
  const all = tags();
  all[id] = { ...(all[id] || {}), ...patch };
  const t = track || app.library?.find((x) => x.id === id);
  if (t) {
    const cKey = makeCanonicalKey(t.title, t.artist);
    if (cKey) all[`c_${cKey}`] = { ...(all[`c_${cKey}`] || {}), ...patch };
  }
  store.set('tags', all);
}
const PHASE_DEFAULT_ENERGY = { warmup: 2, peak: 4, closing: 2 };

function applyTags(track, playlistId = null) {
  const allTags = tags();
  const cKey = makeCanonicalKey(track.title, track.artist);
  const t = allTags[track.id] || (cKey ? allTags[`c_${cKey}`] : null) || {};
  const phase = (playlistId && app.playlistPhase[playlistId]) || null;
  const guess = guessFromTitle(track.title);
  let energy = guess.energy, src = 'guess';
  if (phase) { energy = PHASE_DEFAULT_ENERGY[phase]; src = 'playlist'; }
  if (t.energy && (t.src === 'claude' || t.src === 'host')) { energy = t.energy; src = t.src; }
  return {
    ...track, playlistId, phase,
    energy, energySource: src,
    genre: t.genre || null,
    isLive: t.live ?? guess.live,
    neverPlay: !!t.never,
  };
}

function saveLibrary() {
  if (app.demo) return;
  // guarda só o necessário para retomar a festa depois de recarregar
  store.set('library', app.library.map(({ imageLarge, ...t }) => t));
}

// ---------------- render ----------------
function render() {
  const root = $('#app');
  $('#who').textContent = app.demo ? 'Modo demonstração' : (app.me ? `Spotify: ${app.me.display_name || app.me.id}` : '');
  const fn = { loading: renderLoading, setup: renderSetup, connect: renderConnect, playlists: renderPlaylists, night: renderNight, live: renderLive, summary: renderSummary, resume: renderResume }[app.screen];
  root.innerHTML = fn ? fn() : '';
  if (app.screen === 'live') updateLive();
  if (app.screen === 'night') afterNight();
}

function renderLoading() { return `<section class="center"><div class="spinner"></div><p class="muted">Carregando…</p></section>`; }

function originWarning() {
  if (location.origin === EXPECTED_ORIGIN) return '';
  return `<div class="alert warn"><strong>Endereço diferente do esperado.</strong> Para o login do Spotify funcionar, abra o PISTA em <code>${EXPECTED_ORIGIN}</code> (com o arquivo INICIAR-PISTA.bat). O Spotify não aceita <code>localhost</code>.</div>`;
}

function renderSetup() {
  const cid = S.getClientId();
  return `
  <section class="hero">
    <p class="eyebrow">Condutor musical para festas em casa</p>
    <h1>Escolha as músicas.<br>O PISTA conduz a noite.</h1>
    <p class="lead">Você conecta o Spotify, escolhe a playlist e marca a energia das músicas. O PISTA monta o aquecimento, o pico e o fim de noite, coloca a próxima faixa na fila e você só mexe no clima com um toque.</p>
  </section>
  ${originWarning()}
  <section class="grid2">
    <article class="card">
      <h2>Conectar meu Spotify</h2>
      <p class="muted">Precisa de conta <strong>Premium</strong> e de um app de desenvolvedor (5 minutos, uma vez só).</p>
      <ol class="steps">
        <li>Abra <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a>, entre com sua conta e clique em <strong>Create app</strong>.</li>
        <li>Em <strong>Redirect URIs</strong>, cole exatamente:
          <div class="copy"><code id="ruri">${esc(S.REDIRECT_URI)}</code><button class="btn ghost sm" data-act="copy" data-target="ruri">Copiar</button></div></li>
        <li>Marque <strong>Web API</strong> e <strong>Web Playback SDK</strong>, aceite os termos e salve.</li>
        <li>Em <strong>User Management</strong>, adicione o e-mail Spotify de cada amigo que vai testar (o modo de desenvolvimento aceita poucas pessoas).</li>
        <li>Copie o <strong>Client ID</strong> e cole aqui:</li>
      </ol>
      <form class="row" data-form="clientId">
        <input id="clientId" class="input grow" placeholder="Client ID (32 caracteres)" value="${esc(cid)}" autocomplete="off" spellcheck="false" required minlength="20">
        <button class="btn primary">Salvar e conectar</button>
      </form>
    </article>
    <article class="card alt">
      <h2>Músicas do seu Computador (Caminho B)</h2>
      <p class="muted">Mixagem real de arquivos locais (MP3, WAV, FLAC, M4A) com Web Audio: dois decks, equal-power crossfade e normalização de volume, 100% offline.</p>
      <div class="row wrap gap-2" style="margin: 12px 0 16px;">
        <label class="btn primary" style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
          📁 Selecionar pasta de músicas
          <input type="file" id="local-dir-input" webkitdirectory directory multiple accept="audio/*" hidden>
        </label>
        <label class="btn ghost sm" style="cursor: pointer; display: inline-flex; align-items: center; gap: 8px;">
          Selecionar arquivos…
          <input type="file" id="local-files-input" multiple accept="audio/*,.mp3,.wav,.flac,.m4a,.ogg" hidden>
        </label>
      </div>
      <hr>
      <h2>Testar sem Spotify</h2>
      <p class="muted">Uma festa simulada com músicas fictícias e o relógio acelerado. Serve para ver como o DJ conduz as fases e testar os controles.</p>
      <button class="btn ghost sm" data-act="demo">Abrir demonstração</button>
      <hr>
      <h3>O que o PISTA faz</h3>
      <ul class="plain">
        <li>✔ Ordena as músicas pela energia e pela hora da festa.</li>
        <li>✔ Mantém a próxima faixa sempre na fila: sem silêncio.</li>
        <li>✔ Controles de clima: mais energia, menos energia, pular.</li>
        <li>✔ Mixagem com crossfade de potência constante para arquivos locais.</li>
      </ul>
    </article>
  </section>`;
}

function renderConnect() {
  return `
  ${originWarning()}
  <section class="center narrow">
    <h1>Conectar ao Spotify</h1>
    <p class="lead">Você vai para a página do Spotify, autoriza o PISTA e volta para cá.</p>
    <button class="btn primary big" data-act="login">Conectar com Spotify</button>
    <p class="muted small">Permissões pedidas: ler suas playlists e controlar a reprodução. Nada é enviado a outro servidor: o acesso fica só neste navegador.</p>
    <button class="btn ghost sm" data-act="change-client">Trocar Client ID</button>
  </section>`;
}

function renderPlaylists() {
  const items = app.playlists.map((p) => {
    const sel = app.selected.has(p.id);
    const own = app.me && (p.owner?.id === app.me.id || p.collaborative);
    const total = S.playlistTotal(p);
    const img = p.images?.[p.images.length > 1 ? 1 : 0]?.url || '';
    return `
    <div class="pl ${sel ? 'on' : ''} ${own ? '' : 'foreign'}">
      <button class="pl-hit" data-act="toggle-pl" data-id="${esc(p.id)}" aria-pressed="${sel}">
        <span class="pl-cover">${img ? `<img src="${esc(img)}" alt="" loading="lazy">` : ''}</span>
        <span class="pl-name">${esc(p.name)}</span>
        <span class="pl-meta">${total != null ? `${total} faixas · ` : ''}${own ? (p.collaborative ? 'colaborativa' : 'sua') : `de ${esc(p.owner?.display_name || 'outra pessoa')}`}</span>
      </button>
      ${sel ? `<select class="input sm" data-change="pl-phase" data-id="${esc(p.id)}" aria-label="Fase desta playlist">
        <option value="">Qualquer fase</option>
        ${PHASE_KINDS.map((k) => `<option value="${k}" ${app.playlistPhase[p.id] === k ? 'selected' : ''}>Só no ${PHASE_LABEL[k]}</option>`).join('')}
      </select>` : ''}
    </div>`;
  }).join('');
  return `
  <section class="head">
    <p class="eyebrow">Passo 1 de 2</p>
    <h1>Escolha as playlists da festa</h1>
    <p class="muted">Uma playlist já basta. Se você tiver uma playlist para cada momento, marque a fase de cada uma. Desde 2026 o Spotify só libera as músicas de playlists <strong>suas ou colaborativas</strong>; playlists do próprio Spotify ou de outras pessoas não carregam (copie as músicas para uma playlist sua).</p>
  </section>
  <div class="row between sticky-bar">
    <span>${app.selected.size} selecionada(s)</span>
    <div class="row"><button class="btn ghost sm" data-act="reload-pl">Atualizar lista</button>
    <button class="btn primary" data-act="load-library" ${app.selected.size ? '' : 'disabled'}>Carregar músicas →</button></div>
  </div>
  <div class="pl-grid">${items || '<p class="muted">Nenhuma playlist encontrada nesta conta.</p>'}</div>`;
}

// ---------- Montar a noite ----------
function partyDraft() {
  if (!app.party) {
    const saved = store.get('partyDraft');
    app.party = saved && !app.demo ? saved : {
      name: app.demo ? 'Festa de demonstração' : 'Minha festa',
      durationMin: app.demo ? 180 : 240,
      peakOffsetMin: null,
      phases: defaultPhases(app.demo ? 180 : 240),
      breathers: true,
    };
  }
  return app.party;
}

function curveSvg(party, { nowMin = null, played = [], bias = 0, h = 140 } = {}) {
  const W = 640, H = h, pad = 22;
  const x = (m) => pad + (m / party.durationMin) * (W - pad * 2);
  const y = (e) => H - 18 - ((e - 1) / 4) * (H - 36);
  let bands = '';
  party.phases.forEach((p, i) => {
    const end = party.phases[i + 1]?.startOffsetMin ?? party.durationMin;
    bands += `<rect x="${x(p.startOffsetMin)}" y="4" width="${Math.max(0, x(end) - x(p.startOffsetMin))}" height="${H - 22}" class="band b${i}"/>`;
    bands += `<text x="${x(p.startOffsetMin) + 6}" y="18" class="band-label">${PHASE_LABEL[p.kind]}</text>`;
  });
  let d = '';
  for (let m = 0; m <= party.durationMin; m += 2) d += `${m ? 'L' : 'M'}${x(m).toFixed(1)},${y(targetEnergy(party, m, 0)).toFixed(1)}`;
  let dBias = '';
  if (bias && nowMin != null) {
    for (let m = Math.floor(nowMin); m <= party.durationMin; m += 2) dBias += `${dBias ? 'L' : 'M'}${x(m).toFixed(1)},${y(targetEnergy(party, m, bias)).toFixed(1)}`;
  }
  const dots = played.map((p) => `<circle cx="${x(p.min).toFixed(1)}" cy="${y(p.energy).toFixed(1)}" r="3.5" class="dot"/>`).join('');
  const grid = [1, 2, 3, 4, 5].map((e) => `<line x1="${pad}" x2="${W - pad}" y1="${y(e)}" y2="${y(e)}" class="grid"/><text x="4" y="${y(e) + 4}" class="axis">${e}</text>`).join('');
  const hours = [];
  for (let m = 60; m < party.durationMin; m += 60) hours.push(`<text x="${x(m)}" y="${H - 3}" class="axis" text-anchor="middle">${m / 60}h</text>`);
  const now = nowMin != null ? `<line x1="${x(nowMin)}" x2="${x(nowMin)}" y1="4" y2="${H - 18}" class="now"/>` : '';
  return `<svg class="curve" viewBox="0 0 ${W} ${H}" role="img" aria-label="Curva de energia planejada">${bands}${grid}${hours.join('')}<path d="${d}" class="line"/>${dBias ? `<path d="${dBias}" class="line bias"/>` : ''}${dots}${now}</svg>`;
}

function energyButtons(t) {
  return `<div class="ebtns" role="group" aria-label="Energia">${[1, 2, 3, 4, 5].map((v) => `<button class="e e${v} ${t.energy === v ? 'on' : ''}" data-act="energy" data-id="${esc(t.id)}" data-v="${v}" title="${ENERGY_WORDS[v]}">${v}</button>`).join('')}</div>`;
}

function trackRow(t) {
  return `<div class="trow ${t.neverPlay ? 'never' : ''}" data-row="${esc(t.id)}">
    <img class="thumb" src="${esc(t.image)}" alt="" loading="lazy">
    <div class="tinfo"><div class="ttitle">${esc(t.title)}</div><div class="tartist">${esc(t.artist)}${t.genre ? ` · <span class="tag">${esc(t.genre)}</span>` : ''}${t.isLive ? ' · <span class="tag">ao vivo</span>' : ''}</div></div>
    <span class="src" data-src="${esc(t.id)}">${esc(SRC_LABEL[t.energySource] || '')}</span>
    ${energyButtons(t)}
    <button class="btn ghost xs ${t.neverPlay ? 'on' : ''}" data-act="never" data-id="${esc(t.id)}" title="Nunca tocar">${t.neverPlay ? 'Não toca' : 'Nunca'}</button>
  </div>`;
}

function visibleTracks() {
  const f = app.filter.trim().toLowerCase();
  let list = app.library.filter((t) => !f || `${t.title} ${t.artist} ${t.genre || ''}`.toLowerCase().includes(f));
  if (app.sort === 'energy') list = list.slice().sort((a, b) => a.energy - b.energy || a.title.localeCompare(b.title));
  if (app.sort === 'artist') list = list.slice().sort((a, b) => a.artist.localeCompare(b.artist));
  if (app.sort === 'unrated') list = list.slice().sort((a, b) => (a.energySource === 'host') - (b.energySource === 'host'));
  return list;
}

function histogram() {
  const c = [0, 0, 0, 0, 0, 0];
  let never = 0, host = 0;
  for (const t of app.library) { if (t.neverPlay) never++; else c[t.energy]++; if (t.energySource === 'host') host++; }
  const max = Math.max(1, ...c);
  return `<div class="histo">${[1, 2, 3, 4, 5].map((e) => `<div class="hbar"><span class="hfill e${e}" style="height:${(c[e] / max) * 100}%"></span><b>${c[e]}</b><small>${e}</small></div>`).join('')}</div>
  <p class="muted small">${host} de ${app.library.length} marcadas por você${never ? ` · ${never} nunca tocam` : ''}</p>`;
}

function renderNight() {
  const p = partyDraft();
  const cs = claudeSettings();
  const list = visibleTracks();
  const shown = app.showAll ? list : list.slice(0, 150);
  const peakOpts = [null, 60, 90, 120, 150, 180, 240, 300].filter((v) => v == null || v < p.durationMin);
  return `
  <section class="head">
    <p class="eyebrow">${app.demo ? 'Demonstração' : 'Passo 2 de 2'}</p>
    <h1>Montar a noite</h1>
  </section>

  <section class="card">
    <h2>A festa</h2>
    <div class="form-grid">
      <label>Nome<input class="input" data-change="party-name" value="${esc(p.name)}" maxlength="60"></label>
      <label>Duração
        <select class="input" data-change="party-duration">${[60, 90, 120, 180, 240, 300, 360, 480, 600].map((m) => `<option value="${m}" ${p.durationMin === m ? 'selected' : ''}>${fmtMin(m)}</option>`).join('')}</select>
      </label>
      <label>Auge da festa
        <select class="input" data-change="party-peak">${peakOpts.map((v) => `<option value="${v ?? ''}" ${p.peakOffsetMin === v ? 'selected' : ''}>${v == null ? 'Automático' : `Depois de ${fmtMin(v)}`}</option>`).join('')}</select>
      </label>
    </div>
    <div id="curve-wrap">${curveSvg(p)}</div>
    <div class="phases">
      ${p.phases.map((ph, i) => `
        <div class="phase b${i}">
          <strong>${PHASE_LABEL[ph.kind]}</strong>
          <label>começa em <input class="input xs" type="number" min="0" max="${p.durationMin - 5}" step="5" value="${ph.startOffsetMin}" data-change="phase-start" data-i="${i}" ${i === 0 ? 'disabled' : ''}> min</label>
          <label>energia <select class="input xs" data-change="phase-e0" data-i="${i}">${[1, 2, 3, 4, 5].map((e) => `<option ${ph.energyStart === e ? 'selected' : ''}>${e}</option>`).join('')}</select>
          → <select class="input xs" data-change="phase-e1" data-i="${i}">${[1, 2, 3, 4, 5].map((e) => `<option ${ph.energyEnd === e ? 'selected' : ''}>${e}</option>`).join('')}</select></label>
        </div>`).join('')}
    </div>
    <details class="claude-box" ${app.intentNotes ? 'open' : ''}>
      <summary>Descrever a noite para o Claude (opcional)</summary>
      <p class="muted small">Envia <strong>só o texto abaixo</strong> para a Anthropic (nenhum dado do Spotify). O Claude devolve as fases e você revisa antes de usar.</p>
      <textarea id="intent" class="input" rows="2" placeholder="Ex.: começa bem leve no churrasco, pico à meia-noite com funk e pagode, fim tranquilo">${esc(store.get('intentText', ''))}</textarea>
      <div class="row"><button class="btn sm" data-act="intent" ${cs.key ? '' : 'disabled'}>Pedir plano ao Claude</button>
      ${cs.key ? '' : '<span class="muted small">Coloque sua chave da API do Claude em Configurações.</span>'}</div>
      ${app.intentNotes ? `<p class="note">${esc(app.intentNotes)}</p>` : ''}
    </details>
  </section>

  <section class="card">
    <div class="row between wrap">
      <h2>Energia das músicas <span class="muted">(${app.library.length})</span></h2>
      <div id="histo-wrap">${histogram()}</div>
    </div>
    <p class="muted">O Spotify não fornece mais BPM nem energia para apps novos, então o DJ usa a sua nota: <strong>1</strong> calma · <strong>3</strong> média · <strong>5</strong> pista cheia. As notas começam com um palpite (pelo título ou pela fase da playlist) e ficam salvas para as próximas festas.</p>
    ${cs.experimental ? `
      <div class="alert exp">
        <strong>Modo experimental ligado.</strong> Este botão envia título, artista e ano das faixas para o Claude estimar energia e gênero. Isso contraria a decisão D-05 da análise (pendente de parecer jurídico): use só em teste interno. Suas notas manuais não são sobrescritas.
        <div class="row"><button class="btn sm" data-act="claude-estimate">Estimar energia com Claude</button><span id="est-progress" class="muted small"></span></div>
      </div>` : ''}
    <div class="row wrap toolbar">
      <input class="input grow" type="search" placeholder="Filtrar por título, artista ou gênero" value="${esc(app.filter)}" data-input="filter">
      <select class="input" data-change="sort">
        ${[['playlist', 'Ordem da playlist'], ['energy', 'Energia'], ['artist', 'Artista'], ['unrated', 'Não marcadas primeiro']].map(([v, l]) => `<option value="${v}" ${app.sort === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="muted small">Marcar as ${list.length} visíveis:</span>
      <div class="ebtns">${[1, 2, 3, 4, 5].map((v) => `<button class="e e${v}" data-act="bulk-energy" data-v="${v}">${v}</button>`).join('')}</div>
    </div>
    <div class="tracks" id="tracks">${shown.map(trackRow).join('')}</div>
    ${list.length > shown.length ? `<button class="btn ghost" data-act="show-all">Mostrar todas (${list.length})</button>` : ''}
  </section>

  <section class="card">
    <h2>Onde tocar</h2>
    ${app.demo ? `
      <p class="muted">Na demonstração não sai som: a reprodução é simulada. Escolha a velocidade do relógio:</p>
      <div class="seg">${[1, 10, 30, 60].map((s) => `<button class="${app.demoSpeed === s ? 'on' : ''}" data-act="speed" data-v="${s}">${s}×</button>`).join('')}</div>` : `
      <div class="devices">
        <label class="radio"><input type="radio" name="dev" value="browser" ${app.device === 'browser' ? 'checked' : ''} data-change="device">
          <span><strong>Este navegador</strong> <em class="muted">(recomendado: notebook na tomada, ligado na caixa de som por cabo)</em><br><small id="engine-status" class="muted">${esc(app.engineStatus)}</small></span></label>
        ${app.devices.filter((d) => !d.name?.startsWith('PISTA')).map((d) => `<label class="radio"><input type="radio" name="dev" value="${esc(d.id)}" ${app.device === d.id ? 'checked' : ''} data-change="device"><span><strong>${esc(d.name)}</strong> <em class="muted">${esc(d.type)}${d.is_active ? ' · ativo' : ''}</em></span></label>`).join('')}
      </div>
      <button class="btn ghost sm" data-act="refresh-devices">Procurar aparelhos (abra o app do Spotify no aparelho)</button>
      <p class="muted small">Dica: antes de começar, deixe a fila do Spotify vazia (o PISTA não consegue apagar itens antigos da fila). Se tocar num aparelho com o app do Spotify, o crossfade configurado nele pode suavizar as trocas.</p>`}
  </section>

  <div class="start-bar">
    <button class="btn primary huge" data-act="start">Começar a festa</button>
  </div>`;
}

function afterNight() {
  if (!app.demo && app.device === 'browser') prepareBrowserEngine();
}

async function prepareBrowserEngine() {
  if (app.engine?.kind === 'spotify' && app.engine.useSdk) return;
  app.engine = new SpotifyEngine({ onEvent: engineEvent });
  setEngineStatus('Preparando o player do Spotify neste navegador…');
  try {
    await app.engine.prepare();
    setEngineStatus('Player pronto ✓');
  } catch (e) {
    setEngineStatus(`Player indisponível: ${e.message}`);
    app.engine = null;
  }
}
function setEngineStatus(t) { app.engineStatus = t; const el = $('#engine-status'); if (el) el.textContent = t; }

function engineEvent(type, data) {
  if (type === 'spotify_poll' && data.status === 200 && (data.latencyMs || 0) < 1500 && Math.random() > 0.1) return;
  if (type === 'track_failed') toast(`Falha ao tocar: ${data.reason}`, 'warn');
  if (type === 'device_lost') toast('O player deste navegador ficou offline. Verifique a internet.', 'warn');
  if (type === 'autoplay_failed') toast('O navegador bloqueou o som. Toque em Retomar.', 'warn');
  if (type === 'error') toast(data.message, 'error');
  app.conductor?.event(type, data);
}

// ---------- Ao vivo ----------
function renderLive() {
  const c = app.conductor;
  return `
  <section class="live">
    <div class="live-head">
      <div>
        <div class="live-status-row">
          <p class="eyebrow" id="lv-phase"></p>
          <span id="lv-conn" class="conn-badge online"><span class="conn-dot on"></span> Conectado</span>
          <button class="btn ghost xs" data-act="guest-qr" id="btn-guest-qr" title="Pedidos de convidados">
            📱 Convidados <span id="guest-req-badge" class="pill up" style="display:none; font-size:11px; margin-left:4px;"></span>
          </button>
        </div>
        <h1 id="lv-name">${esc(c.party.name)}</h1>
      </div>
      <div class="clock"><span id="lv-elapsed">0 min</span><small>de ${fmtMin(c.party.durationMin)}</small></div>
    </div>
    <div class="now-card">
      <img id="lv-cover" class="cover" alt="">
      <div class="now-info">
        <p class="eyebrow">Tocando agora · <span id="lv-device"></span></p>
        <h2 id="lv-title">—</h2>
        <p id="lv-artist" class="muted"></p>
        <div class="progress"><span id="lv-bar"></span></div>
        <div class="row between small muted"><span id="lv-pos">0:00</span><span id="lv-energy"></span><span id="lv-dur">0:00</span></div>
        <a id="lv-open" class="small" target="_blank" rel="noopener" hidden>Abrir no Spotify ↗</a>
      </div>
    </div>
    <div class="controls">
      <button class="ctl" data-act="lv-pause" id="lv-pause" title="Tecla de atalho: Espaço">Pausar <kbd>Espaço</kbd></button>
      <button class="ctl" data-act="lv-skip" id="lv-skip" title="Tecla de atalho: N ou Seta Direita">Pular <kbd>N</kbd></button>
      <button class="ctl up" data-act="lv-up" id="lv-up" title="Tecla de atalho: + ou Seta Cima">Mais energia <kbd>+</kbd></button>
      <button class="ctl down" data-act="lv-down" id="lv-down" title="Tecla de atalho: - ou Seta Baixo">Menos energia <kbd>-</kbd></button>
      <button class="ctl" data-act="lv-search" title="Tecla de atalho: S ou /">Tocar agora… <kbd>S</kbd></button>
      <button class="ctl" data-act="lv-never" title="Tecla de atalho: Delete">Nunca mais esta <kbd>Del</kbd></button>
      <button class="ctl warn" data-act="lv-bad" id="lv-bad" title="Tecla de atalho: B">Transição ruim <kbd>B</kbd></button>
    </div>
    <div class="grid2">
      <div class="card">
        <div class="row between"><h3>Próximas</h3><span id="lv-bias" class="pill"></span></div>
        <ol id="lv-next" class="next"></ol>
      </div>
      <div class="card">
        <h3>Energia da noite</h3>
        <div id="lv-curve"></div>
        ${app.demo ? `<div class="row"><span class="muted small">Velocidade:</span><div class="seg sm">${[1, 10, 30, 60].map((s) => `<button class="${app.demoSpeed === s ? 'on' : ''}" data-act="speed" data-v="${s}">${s}×</button>`).join('')}</div></div>` : ''}
        ${!app.demo && c.engine.useSdk ? `<label class="row small muted">Volume <input type="range" min="0" max="100" value="${Math.round(c.engine.volume * 100)}" data-input="volume"></label>` : ''}
      </div>
    </div>
    <div class="row end"><button class="btn ghost sm" data-act="lv-export">Exportar log</button><button class="btn danger sm" data-act="lv-end">Encerrar festa</button></div>
  </section>`;
}

let liveFrame = 0;
function scheduleLive() {
  if (liveFrame) return;
  liveFrame = requestAnimationFrame(() => { liveFrame = 0; if (app.screen === 'live') updateLive(); });
}

function updateLive() {
  const c = app.conductor;
  if (!c) return;
  if (c.live.status === 'closed') { go('summary'); return; }
  const el = (id) => document.getElementById(id);
  if (!el('lv-title')) return;
  const elapsed = c.elapsedMin();
  const ph = c.phaseInfo(elapsed);
  const target = c.target(elapsed);
  el('lv-phase').textContent = `${PHASE_LABEL[ph.phase.kind]} · energia-alvo ${target.toFixed(1)}${c.live.status === 'paused' ? ' · PAUSADA' : ''}${c.live.status === 'ending' ? ' · encerrando…' : ''}`;
  el('lv-elapsed').textContent = fmtMin(elapsed);
  el('lv-device').textContent = c.engine.label();

  const conn = el('lv-conn');
  if (conn) {
    const cs = c.connectionState || 'online';
    if (cs === 'offline') {
      conn.className = 'conn-badge offline';
      conn.innerHTML = '<span class="conn-dot off"></span> Offline (tocando fila)';
    } else if (cs === 'limited') {
      conn.className = 'conn-badge limited';
      conn.innerHTML = '<span class="conn-dot lim"></span> Rate limit';
    } else {
      conn.className = 'conn-badge online';
      conn.innerHTML = '<span class="conn-dot on"></span> Conectado';
    }
  }

  const t = c.track(c.live.currentId);
  const s = c.stateCache;
  if (t) {
    el('lv-title').textContent = t.title;
    el('lv-artist').textContent = t.artist;
    if (el('lv-cover').getAttribute('src') !== (t.imageLarge || t.image)) el('lv-cover').src = t.imageLarge || t.image || 'favicon.svg';
    el('lv-energy').textContent = `energia ${t.energy} · ${ENERGY_WORDS[t.energy] || ''}`;
    const open = el('lv-open');
    if (t.url) { open.href = t.url; open.hidden = false; } else open.hidden = true;
    const pos = s && c.matches(s, t.id) ? s.positionMs : 0;
    const dur = t.durationMs || s?.durationMs || 1;
    el('lv-bar').style.width = `${Math.min(100, (pos / dur) * 100)}%`;
    el('lv-pos').textContent = fmtMs(pos);
    el('lv-dur').textContent = fmtMs(dur);
  }
  el('lv-pause').innerHTML = `${c.live.status === 'paused' ? 'Retomar' : 'Pausar'} <kbd>Espaço</kbd>`;
  el('lv-pause').classList.toggle('on', c.live.status === 'paused');
  const b = c.live.bias;
  el('lv-bias').textContent = b ? `clima ${b > 0 ? '+' : ''}${b}` : 'clima normal';
  el('lv-bias').className = `pill ${b > 0 ? 'up' : b < 0 ? 'down' : ''}`;

  const sig = `${c.live.currentId}|${c.live.committedId}|${b}|${Math.floor(elapsed)}|${c.library.filter((x) => x.neverPlay).length}`;
  if (el('lv-next').dataset.sig !== sig) {
    el('lv-next').dataset.sig = sig;
    const prev = c.preview(5);
    el('lv-next').innerHTML = prev.map((p) => {
      const reasonLabel = (p.reason || []).join(' · ');
      return `
      <li class="${p.committed ? 'committed' : ''}" data-id="${esc(p.track.id)}">
        <img src="${esc(p.track.image)}" alt="" class="thumb">
        <div class="tinfo">
          <div class="ttitle">${esc(p.track.title)}</div>
          <div class="tartist">${esc(p.track.artist)}${reasonLabel ? ` <span class="tag reason">${esc(reasonLabel)}</span>` : ''}</div>
        </div>
        <span class="echip e${p.track.energy}">${p.track.energy}</span>
        <div class="next-actions">
          <button class="btn ghost xs" data-act="play-now" data-id="${esc(p.track.id)}" title="Tocar agora imediatamente">Tocar</button>
          <button class="btn ghost xs" data-act="never-specific" data-id="${esc(p.track.id)}" title="Nunca mais tocar esta">✕</button>
        </div>
        <small class="muted timing">${p.committed ? (app.demo ? 'na fila' : 'na fila do Spotify') : `~${fmtMin(p.offsetMin)}`}</small>
      </li>`;
    }).join('') || '<li class="muted">Sem próximas faixas.</li>';
    const played = c.log.filter((e) => e.type === 'track_started').map((e) => ({ min: e.t / 60000, energy: c.track(e.trackId)?.energy || 3 }));
    el('lv-curve').innerHTML = curveSvg(c.party, { nowMin: elapsed, played, bias: b, h: 150 });
  }

  // Sincroniza estado para convidados (RF-21)
  syncPartyToServer();
}

// ---------- Resumo ----------
function renderSummary() {
  const c = app.conductor;
  const s = c.summary();
  const kinds = { skip: 'Pular', energy_up: 'Mais energia', energy_down: 'Menos energia', play_now: 'Tocar agora', never_again: 'Nunca mais', bad_transition: 'Transição ruim', pause: 'Pausar' };
  return `
  <section class="head"><p class="eyebrow">Festa encerrada</p><h1>${esc(c.party.name)}</h1></section>
  <section class="stats">
    <div class="stat"><b>${s.tracksPlayed}</b><span>faixas</span></div>
    <div class="stat"><b>${fmtMin(s.minutes)}</b><span>de festa</span></div>
    <div class="stat"><b>${s.perHour}</b><span>intervenções por hora</span></div>
    <div class="stat"><b>${s.badTransitions}</b><span>transições ruins</span></div>
    <div class="stat"><b>${s.silences}</b><span>silêncios recuperados</span></div>
  </section>
  <section class="card">
    <div class="row between">
      <h3>Curva de Energia da Noite (Planejado vs. Executado)</h3>
      <span class="muted small">${s.tracksPlayed} faixas tocadas</span>
    </div>
    <div style="margin: 12px 0;">
      ${curveSvg(c.party, { nowMin: s.minutes, played: c.log.filter((e) => e.type === 'track_started').map((e) => ({ min: e.t / 60000, energy: c.track(e.trackId)?.energy || 3 })), h: 160 })}
    </div>
  </section>
  <section class="card">
    <h3>Intervenções</h3>
    <p>${Object.entries(s.byKind).map(([k, v]) => `${kinds[k] || k}: <b>${v}</b>`).join(' · ') || 'Nenhuma. O DJ conduziu sozinho.'}</p>
  </section>
  <section class="card">
    <h2>3 perguntas rápidas</h2>
    <form data-form="feedback" class="feedback">
      <label>Nota da música na festa (0 a 10)
        <input class="input" type="number" name="nota" min="0" max="10" required></label>
      <fieldset><legend>Você usaria de novo na próxima festa?</legend>
        ${['sim', 'talvez', 'não'].map((v) => `<label class="radio inline"><input type="radio" name="denovo" value="${v}" required> ${v}</label>`).join('')}
      </fieldset>
      <label>O que mais incomodou?
        <textarea class="input" name="incomodo" rows="2" maxlength="500"></textarea></label>
      <button class="btn primary">Salvar respostas</button>
    </form>
  </section>
  <div class="row end wrap gap-2">
    <button class="btn primary sm" data-act="share-whatsapp">📱 Compartilhar no WhatsApp</button>
    <button class="btn ghost sm" data-act="lv-export">Exportar log (JSON)</button>
    <button class="btn primary" data-act="new-party">Nova festa</button>
  </div>`;
}

function renderResume() {
  const snap = store.get('live');
  return `
  <section class="center narrow">
    <p class="eyebrow">Festa em andamento</p>
    <h1>${esc(snap?.party?.name || 'Festa')}</h1>
    <p class="lead">A página foi recarregada. Quer continuar de onde parou?</p>
    <button class="btn primary huge" data-act="resume-party">Retomar</button>
    <button class="btn ghost" data-act="discard-party">Encerrar e ver o resumo</button>
  </section>`;
}

// ---------------- configurações ----------------
function openSettings() {
  const cs = claudeSettings();
  openOverlay(`
    <div class="row between"><h2>Configurações</h2><button class="btn ghost sm" data-act="close">Fechar</button></div>
    <form data-form="settings" class="stack">
      <h3>Spotify</h3>
      <label>Client ID do app de desenvolvedor<input class="input" name="clientId" value="${esc(S.getClientId())}" autocomplete="off" spellcheck="false"></label>
      <p class="muted small">Redirect URI cadastrado no Spotify: <code>${esc(S.REDIRECT_URI)}</code></p>
      <h3>Claude (opcional)</h3>
      <label>Chave da API da Anthropic<input class="input" name="anthropicKey" type="password" value="${esc(cs.key)}" placeholder="sk-ant-…" autocomplete="off"></label>
      <p class="muted small">Fica salva só neste navegador. Use uma chave de teste com limite de gasto.</p>
      <label>Modelo<input class="input" name="anthropicModel" value="${esc(cs.model)}" placeholder="${DEFAULT_MODEL}"></label>
      <label class="check"><input type="checkbox" name="experimental" ${cs.experimental ? 'checked' : ''}>
        <span><strong>Modo experimental:</strong> deixar o Claude ler título e artista das faixas do Spotify para estimar energia. Contraria a decisão D-05 da análise (pendente de parecer jurídico sobre os termos do Spotify). Só para testes internos.</span></label>
      <div class="row end"><button class="btn primary">Salvar</button></div>
    </form>
    <hr>
    <h3>Dados</h3>
    <div class="row wrap">
      ${S.isLoggedIn() ? '<button class="btn ghost sm" data-act="logout">Desconectar Spotify</button>' : ''}
      <button class="btn danger sm" data-act="wipe">Excluir todos os dados do PISTA</button>
    </div>
    <p class="muted small">Versão ${APP_VERSION}. Tudo (notas de energia, festas, logs, acesso ao Spotify) fica só neste navegador.</p>`);
}

// ---------------- fluxos ----------------
async function boot() {
  try {
    if (location.pathname === '/callback') {
      go('loading');
      await S.handleCallback();
      toast('Spotify conectado.', 'ok');
    }
  } catch (e) {
    toast(e.message, 'error', 8000);
  }
  if (location.pathname !== '/' && location.pathname !== '/index.html') history.replaceState(null, '', '/');

  const snap = store.get('live');
  if (snap && ['playing', 'paused', 'ending'].includes(snap.live?.status) && snap.engine === 'spotify' && S.isLoggedIn()) {
    try { app.me = await S.getMe(); } catch { /* segue */ }
    return go('resume');
  }
  if (!S.getClientId()) return go('setup');
  if (!S.isLoggedIn()) return go('connect');
  await enterSpotify();
}

async function enterSpotify() {
  go('loading');
  try {
    app.me = await S.getMe();
    app.playlists = await S.getMyPlaylists();
    go('playlists');
  } catch (e) {
    toast(e.message, 'error', 8000);
    if (e.revoked || e.status === 401) return go('connect');
    if (e.status === 403) toast('O Spotify recusou o acesso. Confira se o seu e-mail está em "User Management" no app de desenvolvedor e se o dono do app tem Premium.', 'error', 12000);
    go('connect');
  }
}

async function loadLibrary() {
  go('loading');
  const seen = new Map();
  const failures = [];
  for (const p of app.playlists.filter((x) => app.selected.has(x.id))) {
    try {
      const { tracks } = await S.getPlaylistTracks(p.id);
      if (!tracks.length) failures.push(p.name);
      for (const raw of tracks) {
        if (seen.has(raw.id)) continue;
        seen.set(raw.id, applyTags(S.toTrack(raw), p.id));
      }
    } catch (e) {
      failures.push(p.name);
      console.warn(p.name, e);
    }
  }
  if (failures.length) toast(`Não consegui ler: ${failures.join(', ')}. Provavelmente não são suas. Copie as músicas para uma playlist sua.`, 'warn', 10000);
  app.library = [...seen.values()];
  if (!app.library.length) { toast('Nenhuma música carregada.', 'error'); return go('playlists'); }
  saveLibrary();
  try { app.devices = await S.player.devices(); } catch { app.devices = []; }
  go('night');
}

function startDemo() {
  app.demo = true;
  app.sourceKind = 'demo';
  app.library = demoLibrary();
  app.party = null;
  go('night');
}

async function handleLocalFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => {
    const ext = f.name.toLowerCase();
    return /\.(mp3|wav|flac|m4a|ogg|aac|webm)$/.test(ext);
  });
  if (!files.length) return toast('Nenhum arquivo de áudio suportado encontrado (.mp3, .wav, .flac, .m4a).', 'warn');

  go('loading');
  toast(`Lendo tags de ${files.length} arquivos de áudio…`, 'info');

  const tracks = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const id = `loc_${uid()}_${i}`;
    let tags = { title: '', artist: '', album: '', year: '', genre: '', coverUrl: '' };

    try {
      const slice = f.slice(0, 262144);
      const ab = await slice.arrayBuffer();
      tags = parseAudioTags(ab, f.name);
    } catch {
      tags = parseAudioTags(new ArrayBuffer(0), f.name);
    }

    const t = applyTags({
      id,
      uri: `local:${id}`,
      title: tags.title || f.name.replace(/\.[^.]+$/, ''),
      artist: tags.artist || 'Desconhecido',
      artistKeys: [normalizeKey(tags.artist || '')],
      album: tags.album || 'Arquivos Locais',
      year: tags.year || '2026',
      image: tags.coverUrl || 'favicon.svg',
      imageLarge: tags.coverUrl || '',
      durationMs: 210000,
      neverPlay: false,
      _file: f,
    });
    tracks.push(t);
  }

  app.sourceKind = 'local';
  app.demo = false;
  app.library = tracks;
  app.party = null;
  saveLibrary();
  toast(`${tracks.length} músicas carregadas da pasta local!`, 'ok');
  go('night');
}

async function startParty() {
  const draft = partyDraft();
  const err = validatePhases(draft.phases, draft.durationMin);
  if (err) return toast(err, 'error');
  if (!app.library.some((t) => !t.neverPlay)) return toast('Todas as músicas estão marcadas como "nunca tocar".', 'error');
  const party = { ...draft, id: uid(), seed: Math.floor(Math.random() * 1e9), createdAt: Date.now(), sourceKind: app.demo ? 'demo' : (app.sourceKind || 'spotify') };

  let engine;
  if (app.demo) {
    engine = new DemoEngine({ library: app.library, speed: app.demoSpeed });
  } else if (app.sourceKind === 'local') {
    engine = new LocalAudioEngine({ onEvent: engineEvent });
    for (const t of app.library) engine.registerFile(t);
    engine.unlockAudio();
  } else if (app.device === 'browser') {
    engine = app.engine && app.engine.useSdk ? app.engine : new SpotifyEngine({ onEvent: engineEvent });
    engine.unlockAudio(); // ainda dentro do clique (regra de autoplay)
  } else {
    engine = new SpotifyEngine({ deviceId: app.device, onEvent: engineEvent });
  }
  const btn = $('[data-act="start"]');
  if (btn) { btn.disabled = true; btn.textContent = 'Começando…'; }
  try {
    await engine.prepare();
    engine.unlockAudio();
    const c = new Conductor({ party, library: app.library, engine, onChange: scheduleLive, onToast: toast });
    c.onSave = (snap) => { if (!app.demo) store.set('live', snap); };
    app.conductor = c;
    await c.begin();
    requestWakeLock();
    go('live');
  } catch (e) {
    toast(e.message, 'error', 9000);
    if (btn) { btn.disabled = false; btn.textContent = 'Começar a festa'; }
  }
}

async function resumeParty() {
  const snap = store.get('live');
  const lib = store.get('library', []);
  if (!snap || !lib.length) { store.remove('live'); return boot(); }
  app.library = lib;
  const engine = snap.live && store.get('lastDevice') && store.get('lastDevice') !== 'browser'
    ? new SpotifyEngine({ deviceId: store.get('lastDevice'), onEvent: engineEvent })
    : new SpotifyEngine({ onEvent: engineEvent });
  try {
    await engine.prepare();
    engine.unlockAudio();
    const c = new Conductor({ party: snap.party, library: lib, engine, onChange: scheduleLive, onToast: toast, saved: snap });
    c.onSave = (s) => store.set('live', s);
    app.conductor = c;
    await c.resumeSaved();
    requestWakeLock();
    go('live');
  } catch (e) {
    toast(e.message, 'error', 9000);
  }
}

function discardParty() {
  const snap = store.get('live');
  store.remove('live');
  if (snap) {
    const c = new Conductor({ party: snap.party, library: store.get('library', []), engine: { clock: { now: Date.now }, kind: 'none' }, saved: snap });
    c.live.status = 'closed';
    c.event('party_closed', { reason: 'discarded_after_reload' });
    app.conductor = c;
    return go('summary');
  }
  boot();
}

function exportLog() {
  const c = app.conductor;
  if (!c) return;
  const data = {
    schema: 'pista.log.v1', appVersion: APP_VERSION, exportedAt: new Date().toISOString(),
    party: { id: c.party.id, name: c.party.name, durationMin: c.party.durationMin, phases: c.party.phases, seed: c.party.seed, sourceKind: c.party.sourceKind },
    summary: c.summary(),
    events: c.log,
    feedback: store.get(`feedback.${c.party.id}`) || null,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pista-log-${(c.party.name || 'festa').replace(/[^\w-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator) { wakeLock = await navigator.wakeLock.request('screen'); app.conductor?.event('wakelock_acquired'); wakeLock.addEventListener('release', () => app.conductor?.event('wakelock_lost')); } } catch { /* ignore */ }
}
document.addEventListener('visibilitychange', () => {
  app.conductor?.event('visibility_changed', { state: document.visibilityState });
  if (document.visibilityState === 'visible' && app.screen === 'live') requestWakeLock();
});
window.addEventListener('beforeunload', (e) => {
  if (app.conductor && ['playing', 'paused'].includes(app.conductor.live.status)) {
    app.conductor.save(true);
    e.preventDefault();
  }
});

function openSearch() {
  openOverlay(`
    <div class="row between"><h2>Tocar agora</h2><button class="btn ghost sm" data-act="close">Fechar</button></div>
    <input class="input" type="search" id="q" placeholder="Buscar nas músicas da festa" data-input="search">
    <ul id="results" class="results"></ul>`, 'tall');
  runSearch('');
}
function runSearch(q) {
  const c = app.conductor;
  const f = q.trim().toLowerCase();
  const list = c.library.filter((t) => !t.neverPlay && (!f || `${t.title} ${t.artist}`.toLowerCase().includes(f))).slice(0, 40);
  $('#results').innerHTML = list.map((t) => `<li><button data-act="play-now" data-id="${esc(t.id)}"><img class="thumb" src="${esc(t.image)}" alt=""><span class="tinfo"><span class="ttitle">${esc(t.title)}</span><span class="tartist">${esc(t.artist)}</span></span><span class="echip e${t.energy}">${t.energy}</span></button></li>`).join('') || '<li class="muted">Nada encontrado.</li>';
}

// ---------- Sincronização e Pedidos de Convidados (RF-21) ----------
let lastSync = 0;
async function syncPartyToServer() {
  const now = Date.now();
  if (now - lastSync < 3500) return;
  lastSync = now;
  const c = app.conductor;
  if (!c) return;

  const curTrack = c.track(c.live.currentId);
  const payload = {
    partyName: c.party.name,
    current: curTrack ? { title: curTrack.title, artist: curTrack.artist, image: curTrack.image } : null,
    phase: PHASE_LABEL[c.phaseInfo(c.elapsedMin()).phase.kind],
    tracks: app.library.slice(0, 150).map((t) => ({ id: t.id, title: t.title, artist: t.artist, image: t.image })),
  };

  try {
    await fetch('/api/party/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const reqRes = await fetch('/api/host/requests');
    if (reqRes.ok) {
      app.guestRequests = (await reqRes.json()) || [];
      const pending = app.guestRequests.filter((r) => r.status === 'pending');
      const badge = $('#guest-req-badge');
      if (badge) {
        badge.textContent = pending.length ? `${pending.length} novo(s)` : '';
        badge.style.display = pending.length ? 'inline-block' : 'none';
      }
    }
  } catch { /* offline / ignorar */ }
}

function openGuestRequestsModal() {
  const c = app.conductor;
  const host = location.hostname === '127.0.0.1' || location.hostname === 'localhost' ? location.host : location.host;
  const guestLink = `http://${host}/guest`;
  const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(guestLink)}`;

  const pending = (app.guestRequests || []).filter((r) => r.status === 'pending');
  const items = pending.length ? pending.map((r) => `
    <div class="row between wrap items-center guest-req-card" style="background:#1b1922; padding:10px 14px; border-radius:10px; border:1px solid var(--line); margin-bottom:8px;">
      <div>
        <strong>${esc(r.title)}</strong><br>
        <span class="muted small">${esc(r.artist)} · às ${esc(r.time)}</span>
      </div>
      <div class="row gap-2">
        <button class="btn primary xs" data-act="guest-play" data-id="${esc(r.trackId)}" data-req="${esc(r.id)}">Tocar agora</button>
        <button class="btn ghost xs" data-act="guest-decline" data-req="${esc(r.id)}">Dispensar</button>
      </div>
    </div>
  `).join('') : '<p class="muted">Nenhum pedido de convidado pendente no momento.</p>';

  openOverlay(`
    <div class="row between"><h2>📱 Pedidos de Convidados (RF-21)</h2><button class="btn ghost sm" data-act="close">Fechar</button></div>
    <p class="muted">Convidados no mesmo Wi-Fi podem escanear o QR Code ou acessar o link para buscar músicas e sugerir:</p>
    <div class="row center wrap gap-4" style="margin: 14px 0; background:#14121a; padding:16px; border-radius:14px; text-align:center;">
      <img src="${qrUrl}" alt="QR Code para convidados" style="width:160px; height:160px; border-radius:8px; background:#fff; padding:6px;" onerror="this.style.display='none'">
      <div style="text-align:left; max-width:320px;">
        <p class="small muted" style="margin-bottom:6px;">Link direto para o celular:</p>
        <code style="display:block; padding:8px 10px; background:#201d29; border-radius:8px; word-break:break-all;">${esc(guestLink)}</code>
        <button class="btn ghost xs" style="margin-top:8px;" data-act="copy-guest-link" data-link="${esc(guestLink)}">Copiar link</button>
      </div>
    </div>
    <h3>Pedidos pendentes (${pending.length})</h3>
    <div style="max-height:220px; overflow:auto;">${items}</div>
  `, 'tall');
}

// ---------------- eventos ----------------
document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el) { if (ev.target.id === 'overlay') closeOverlay(); return; }
  const act = el.dataset.act;
  const c = app.conductor;
  if (el.tagName === 'A') ev.preventDefault();
  switch (act) {
    case 'home':
      if (app.screen === 'live') return;
      app.demo = false; app.party = null; return boot();
    case 'settings': return openSettings();
    case 'close': return closeOverlay();
    case 'copy': {
      const text = document.getElementById(el.dataset.target)?.textContent || '';
      try { await navigator.clipboard.writeText(text); toast('Copiado.', 'ok', 1500); } catch { toast(text, 'info'); }
      return;
    }
    case 'demo': return startDemo();
    case 'login':
      try { await S.startLogin(); } catch (e) { toast(e.message, 'error'); }
      return;
    case 'change-client': return go('setup');
    case 'toggle-pl': {
      const id = el.dataset.id;
      if (app.selected.has(id)) app.selected.delete(id); else app.selected.add(id);
      store.set('selectedPlaylists', [...app.selected]);
      return render();
    }
    case 'reload-pl': return enterSpotify();
    case 'load-library': return loadLibrary();
    case 'energy': {
      const t = app.library.find((x) => x.id === el.dataset.id);
      if (!t) return;
      t.energy = Number(el.dataset.v); t.energySource = 'host';
      if (!app.demo) { saveTag(t.id, { energy: t.energy, src: 'host' }); saveLibrary(); }
      const row = document.querySelector(`[data-row="${CSS.escape(t.id)}"]`);
      row?.querySelectorAll('.e').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === t.energy));
      const src = row?.querySelector('.src'); if (src) src.textContent = SRC_LABEL.host;
      const hw = $('#histo-wrap'); if (hw) hw.innerHTML = histogram();
      return;
    }
    case 'bulk-energy': {
      const v = Number(el.dataset.v);
      const list = visibleTracks();
      confirmBox('Marcar todas as visíveis', `Definir energia ${v} (${ENERGY_WORDS[v]}) para ${list.length} faixas?`, 'Marcar', () => {
        for (const t of list) { t.energy = v; t.energySource = 'host'; if (!app.demo) saveTag(t.id, { energy: v, src: 'host' }); }
        saveLibrary(); render();
      });
      return;
    }
    case 'never': {
      const t = app.library.find((x) => x.id === el.dataset.id);
      if (!t) return;
      t.neverPlay = !t.neverPlay;
      if (!app.demo) { saveTag(t.id, { never: t.neverPlay }); saveLibrary(); }
      const row = document.querySelector(`[data-row="${CSS.escape(t.id)}"]`);
      if (row) row.outerHTML = trackRow(t);
      return;
    }
    case 'show-all': app.showAll = true; return render();
    case 'speed':
      app.demoSpeed = Number(el.dataset.v);
      if (c?.engine.kind === 'demo') c.engine.setSpeed(app.demoSpeed);
      document.querySelectorAll('[data-act="speed"]').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === app.demoSpeed));
      return;
    case 'refresh-devices':
      try { app.devices = await S.player.devices(); render(); if (!app.devices.length) toast('Nenhum aparelho encontrado. Abra o app do Spotify no celular ou no PC e toque algo por um segundo.', 'info', 7000); } catch (e) { toast(e.message, 'error'); }
      return;
    case 'intent': {
      const text = $('#intent').value.trim();
      if (!text) return toast('Escreva como deve ser a noite.', 'info');
      store.set('intentText', text);
      el.disabled = true; el.textContent = 'Pensando…';
      try {
        const p = partyDraft();
        const res = await interpretIntent(text, p.durationMin, new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));
        confirmBox('Plano sugerido pelo Claude', `${res.notes}\n\n${res.phases.map((ph) => `${PHASE_LABEL[ph.kind]}: a partir de ${fmtMin(ph.startOffsetMin)}, energia ${ph.energyStart}→${ph.energyEnd}`).join(' · ')}`, 'Usar este plano', () => {
          p.phases = res.phases; app.intentNotes = res.notes; store.set('partyDraft', p); render();
        });
      } catch (e) { toast(e.message, 'error', 8000); }
      el.disabled = false; el.textContent = 'Pedir plano ao Claude';
      return;
    }
    case 'claude-estimate': {
      const todo = app.library.filter((t) => t.energySource !== 'host');
      if (!todo.length) return toast('Todas as faixas já têm nota sua.', 'info');
      if (!claudeSettings().key) return toast('Coloque a chave da API do Claude em Configurações.', 'error');
      confirmBox('Enviar faixas ao Claude?', `Título, artista e ano de ${todo.length} faixas vão para a API da Anthropic. Isso contraria a decisão D-05 da análise. Continuar só para teste interno?`, 'Enviar e estimar', async () => {
        const prog = $('#est-progress');
        try {
          const res = await estimateTracks(todo, (done, total) => { if (prog) prog.textContent = `${done}/${total}…`; });
          for (const t of app.library) {
            const r = res.get(t.id);
            if (!r || t.energySource === 'host') continue;
            t.energy = r.energy; t.energySource = 'claude'; t.genre = r.genre; t.isLive = r.live;
            if (!app.demo) saveTag(t.id, { energy: r.energy, src: 'claude', genre: r.genre, live: r.live });
          }
          saveLibrary();
          toast(`Claude estimou ${res.size} faixas. Revise o que achar estranho.`, 'ok');
          render();
        } catch (e) { toast(e.message, 'error', 8000); if (prog) prog.textContent = ''; }
      }, true);
      return;
    }
    case 'start': return startParty();
    // ao vivo
    case 'lv-pause': return c.live.status === 'paused' ? c.resume() : c.pause();
    case 'lv-skip': {
      const btn = $('#lv-skip');
      if (btn) {
        btn.disabled = true;
        btn.classList.add('loading');
        btn.innerHTML = 'Pulando… <kbd>N</kbd>';
      }
      toast('Pulando faixa…', 'info', 1800);
      try {
        await c.skip();
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setTimeout(() => {
          if (btn) {
            btn.disabled = false;
            btn.classList.remove('loading');
            btn.innerHTML = 'Pular <kbd>N</kbd>';
          }
        }, 2200);
      }
      return;
    }
    case 'lv-up': {
      c.energy(+1);
      const b = c.live.bias;
      toast(`Clima: ${b > 0 ? '+' : ''}${b} (${b > 0 ? 'mais animada' : 'normal'})`, 'ok', 1800);
      return;
    }
    case 'lv-down': {
      c.energy(-1);
      const b = c.live.bias;
      toast(`Clima: ${b > 0 ? '+' : ''}${b} (${b < 0 ? 'mais calma' : 'normal'})`, 'info', 1800);
      return;
    }
    case 'lv-search': return openSearch();
    case 'play-now': {
      closeOverlay();
      toast('Tocando faixa agora…', 'ok', 2000);
      return c.playNow(el.dataset.id).catch((e) => toast(e.message, 'error'));
    }
    case 'never-specific': {
      const id = el.dataset.id;
      if (!id) return;
      if (!app.demo) saveTag(id, { never: true });
      await c.neverAgain(id).catch((e) => toast(e.message, 'error'));
      saveLibrary();
      updateLive();
      return;
    }
    case 'lv-never':
      if (!app.demo) saveTag(c.live.currentId, { never: true });
      await c.neverAgain().catch((e) => toast(e.message, 'error'));
      saveLibrary();
      return;
    case 'lv-bad': {
      c.badTransition();
      const btn = $('#lv-bad');
      if (btn) {
        btn.classList.add('marked');
        btn.innerHTML = 'Anotado! ✓ <kbd>B</kbd>';
        setTimeout(() => {
          if (btn) {
            btn.classList.remove('marked');
            btn.innerHTML = 'Transição ruim <kbd>B</kbd>';
          }
        }, 3000);
      }
      return;
    }
    case 'lv-export': return exportLog();
    case 'guest-qr': return openGuestRequestsModal();
    case 'guest-play': {
      const trackId = el.dataset.id;
      const reqId = el.dataset.req;
      fetch('/api/host/requests/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: reqId, action: 'played' }),
      }).catch(() => {});
      closeOverlay();
      toast('Tocando pedido de convidado!', 'ok');
      return c.playNow(trackId).catch((e) => toast(e.message, 'error'));
    }
    case 'guest-decline': {
      const reqId = el.dataset.req;
      fetch('/api/host/requests/resolve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: reqId, action: 'decline' }),
      }).catch(() => {});
      el.closest('.guest-req-card')?.remove();
      toast('Pedido dispensado.', 'info');
      return;
    }
    case 'copy-guest-link': {
      const link = el.dataset.link;
      try { await navigator.clipboard.writeText(link); toast('Link copiado!', 'ok'); } catch { toast(link, 'info'); }
      return;
    }
    case 'share-whatsapp': {
      const s = c.summary();
      const txt = `🎉 *Resumo da Festa: ${c.party.name}*\n⏱ Duração: ${fmtMin(s.minutes)}\n🎵 Músicas tocadas: ${s.tracksPlayed} faixas\n⚡ Intervenções do anfitrião: ${s.perHour}/hora\n✨ Conduzido pelo PISTA`;
      try {
        await navigator.clipboard.writeText(txt);
        toast('Resumo copiado para o WhatsApp!', 'ok');
      } catch {
        toast('Não foi possível copiar.', 'warn');
      }
      return;
    }
    case 'lv-end': return confirmBox('Encerrar a festa?', 'A música vai baixar devagar e parar.', 'Encerrar', async () => { await c.end('host'); store.remove('live'); });
    case 'new-party':
      app.conductor?.destroy(); app.conductor = null; app.engine = null; store.remove('live');
      if (app.demo) return startDemo();
      return go('night');
    case 'resume-party': return resumeParty();
    case 'discard-party': return discardParty();
    case 'logout': S.logout(); closeOverlay(); app.me = null; toast('Spotify desconectado.', 'ok'); return boot();
    case 'wipe':
      return confirmBox('Excluir todos os dados?', 'Apaga notas de energia, playlists escolhidas, festas, logs, chaves e o acesso ao Spotify deste navegador. Não dá para desfazer.', 'Excluir tudo', () => {
        app.conductor?.destroy(); store.clearAll(); sessionStorage.clear(); location.href = '/';
      }, true);
    default:
  }
});

document.addEventListener('change', (ev) => {
  if (ev.target.id === 'local-dir-input' || ev.target.id === 'local-files-input') {
    if (ev.target.files && ev.target.files.length) {
      handleLocalFiles(ev.target.files);
    }
    return;
  }
  const el = ev.target.closest('[data-change]');
  if (!el) return;
  const p = app.party;
  const k = el.dataset.change;
  const persist = () => { if (!app.demo) store.set('partyDraft', p); };
  switch (k) {
    case 'pl-phase':
      if (el.value) app.playlistPhase[el.dataset.id] = el.value; else delete app.playlistPhase[el.dataset.id];
      store.set('playlistPhase', app.playlistPhase);
      return;
    case 'party-name': p.name = el.value.trim() || 'Minha festa'; persist(); return;
    case 'party-duration':
      p.durationMin = Number(el.value);
      if (p.peakOffsetMin && p.peakOffsetMin >= p.durationMin) p.peakOffsetMin = null;
      p.phases = defaultPhases(p.durationMin, p.peakOffsetMin); app.intentNotes = ''; persist(); return render();
    case 'party-peak':
      p.peakOffsetMin = el.value ? Number(el.value) : null;
      p.phases = defaultPhases(p.durationMin, p.peakOffsetMin); app.intentNotes = ''; persist(); return render();
    case 'phase-start': case 'phase-e0': case 'phase-e1': {
      const i = Number(el.dataset.i);
      const next = p.phases.map((x) => ({ ...x }));
      if (k === 'phase-start') next[i].startOffsetMin = Number(el.value);
      if (k === 'phase-e0') next[i].energyStart = Number(el.value);
      if (k === 'phase-e1') next[i].energyEnd = Number(el.value);
      const err = validatePhases(next, p.durationMin);
      if (err) { toast(err, 'error'); return render(); }
      p.phases = next; persist();
      $('#curve-wrap').innerHTML = curveSvg(p);
      return;
    }
    case 'sort': app.sort = el.value; return render();
    case 'device':
      app.device = el.value;
      store.set('lastDevice', app.device);
      if (app.device === 'browser') prepareBrowserEngine();
      return;
    default:
  }
});

let filterTimer = 0;
document.addEventListener('input', (ev) => {
  const el = ev.target.closest('[data-input]');
  if (!el) return;
  if (el.dataset.input === 'filter') {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(() => {
      app.filter = el.value;
      const list = visibleTracks();
      const shown = app.showAll ? list : list.slice(0, 150);
      $('#tracks').innerHTML = shown.map(trackRow).join('');
    }, 150);
  }
  if (el.dataset.input === 'search') runSearch(el.value);
  if (el.dataset.input === 'volume') app.conductor?.engine.setUserVolume(Number(el.value) / 100);
});

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form) return;
  ev.preventDefault();
  const fd = new FormData(form);
  switch (form.dataset.form) {
    case 'clientId': {
      const v = $('#clientId').value.trim();
      if (!/^[a-zA-Z0-9]{20,64}$/.test(v)) return toast('Esse Client ID não parece válido. Copie de novo do painel do Spotify.', 'error');
      store.set('clientId', v);
      return S.startLogin().catch((e) => toast(e.message, 'error'));
    }
    case 'settings': {
      const cid = String(fd.get('clientId') || '').trim();
      if (cid && cid !== S.getClientId()) { store.set('clientId', cid); S.logout(); }
      store.set('anthropicKey', String(fd.get('anthropicKey') || '').trim());
      store.set('anthropicModel', String(fd.get('anthropicModel') || '').trim() || DEFAULT_MODEL);
      store.set('experimentalAi', fd.get('experimental') === 'on');
      closeOverlay();
      toast('Configurações salvas.', 'ok');
      return render();
    }
    case 'feedback': {
      const c = app.conductor;
      const fb = { nota: Number(fd.get('nota')), denovo: fd.get('denovo'), incomodo: String(fd.get('incomodo') || '').slice(0, 500) };
      store.set(`feedback.${c.party.id}`, fb);
      c.event('feedback', fb);
      toast('Obrigado! As respostas entram no log exportado.', 'ok');
      form.querySelector('button').disabled = true;
      return;
    }
    default:
  }
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && !$('#overlay').hidden) return closeOverlay();
  const tag = (ev.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.target.isContentEditable) return;
  if (app.screen !== 'live') return;
  const c = app.conductor;
  if (!c) return;

  switch (ev.code) {
    case 'Space':
      ev.preventDefault();
      c.live.status === 'paused' ? c.resume() : c.pause();
      break;
    case 'KeyN':
    case 'ArrowRight':
      ev.preventDefault();
      $('#lv-skip')?.click();
      break;
    case 'ArrowUp':
    case 'Equal':
    case 'NumpadAdd':
      ev.preventDefault();
      $('#lv-up')?.click();
      break;
    case 'ArrowDown':
    case 'Minus':
    case 'NumpadSubtract':
      ev.preventDefault();
      $('#lv-down')?.click();
      break;
    case 'KeyS':
    case 'Slash':
      ev.preventDefault();
      openSearch();
      break;
    case 'KeyB':
      ev.preventDefault();
      $('#lv-bad')?.click();
      break;
    case 'Delete':
    case 'Backspace':
      ev.preventDefault();
      $('[data-act="lv-never"]')?.click();
      break;
  }
});

// suporte
if (!window.isSecureContext || !crypto?.subtle) {
  document.body.insertAdjacentHTML('afterbegin', `<div class="alert warn">Abra o PISTA em ${EXPECTED_ORIGIN} pelo Chrome ou Edge.</div>`);
}

void hash01; void phaseAt;
boot();
