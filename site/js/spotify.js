// PISTA · Integração com o Spotify (Caminho A, "Modo Condutor")
// Login: Authorization Code + PKCE direto no navegador (versão de teste, sem servidor).
// Na versão de produção a análise pede um BFF para guardar o refresh token (03 §2, RNF-06).

import { store } from './store.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
export const REDIRECT_URI = (typeof location !== 'undefined' && location.origin ? `${location.origin}/callback` : 'http://127.0.0.1:8888/callback');
export const SCOPES = [
  'streaming', 'user-read-email', 'user-read-private',          // Web Playback SDK
  'user-read-playback-state', 'user-modify-playback-state',     // Modo Condutor
  'user-read-currently-playing',
  'playlist-read-private', 'playlist-read-collaborative',       // ler playlists
];

let listeners = [];
export function onSpotifyEvent(fn) { listeners.push(fn); }
function emit(type, data) { for (const fn of listeners) try { fn(type, data); } catch (e) { console.error(e); } }

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function randomString(n = 64) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const v = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(v, (x) => chars[x % chars.length]).join('');
}

export const CLIENT_ID_RE = /^[A-Za-z0-9]{20,64}$/;
export function isClientIdValid(clientId) {
  return typeof clientId === 'string' && CLIENT_ID_RE.test(clientId.trim());
}
export function getClientIdIssue(clientId) {
  const value = String(clientId ?? '').trim();
  if (!value) return 'Falta o Client ID do Spotify. Cole o valor do app de desenvolvedor antes de conectar.';
  if (!CLIENT_ID_RE.test(value)) return 'O Client ID do Spotify precisa ter entre 20 e 64 letras ou números. Copie do painel do Spotify e tente de novo.';
  return '';
}

export function getClientId() { return store.get('clientId', ''); }

export async function startLogin() {
  const clientId = getClientId().trim();
  const issue = getClientIdIssue(clientId);
  if (issue) throw new Error(issue);
  store.set('clientId', clientId);
  const verifier = randomString(64);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const state = randomString(16);
  sessionStorage.setItem('pista.pkce', JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    response_type: 'code', client_id: clientId, scope: SCOPES.join(' '),
    code_challenge_method: 'S256', code_challenge: challenge, redirect_uri: REDIRECT_URI, state,
  });
  location.assign(`${ACCOUNTS}/authorize?${params}`);
}

// Chamado no carregamento quando a URL é /callback?code=...
export async function handleCallback() {
  const url = new URL(location.href);
  if (url.pathname !== '/callback') return false;
  const code = url.searchParams.get('code');
  const err = url.searchParams.get('error');
  const returned = url.searchParams.get('state');
  history.replaceState(null, '', '/');
  if (err) throw new Error(err === 'access_denied' ? 'Você cancelou a autorização no Spotify.' : `Spotify recusou o login: ${err}`);
  const saved = JSON.parse(sessionStorage.getItem('pista.pkce') || 'null');
  sessionStorage.removeItem('pista.pkce');
  if (!code || !saved || saved.state !== returned) throw new Error('Login inválido ou expirado. Tente conectar de novo.');
  const body = new URLSearchParams({
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
    client_id: getClientId(), code_verifier: saved.verifier,
  });
  await tokenRequest(body);
  return true;
}

async function tokenRequest(body) {
  const res = await fetch(`${ACCOUNTS}/api/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json.error_description || json.error || `Erro ${res.status} no login`);
    e.code = json.error;
    throw e;
  }
  const tok = {
    access: json.access_token,
    refresh: json.refresh_token || store.get('token', {}).refresh,
    expiresAt: Date.now() + (json.expires_in || 3600) * 1000,
    scope: json.scope,
  };
  store.set('token', tok);
  return tok;
}

let refreshing = null;
async function refresh() {
  if (refreshing) return refreshing;
  const tok = store.get('token');
  if (!tok?.refresh) throw Object.assign(new Error('Sessão do Spotify expirada.'), { revoked: true });
  refreshing = tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh, client_id: getClientId() }))
    .then((t) => { emit('token_refreshed'); return t; })
    .catch((e) => {
      if (e.code === 'invalid_grant') {
        store.remove('token');
        emit('token_revoked');
        e.revoked = true;
        e.message = 'O acesso ao Spotify foi revogado ou expirou. Reconecte.';
      }
      throw e;
    })
    .finally(() => { refreshing = null; });
  return refreshing;
}

export function isLoggedIn() { return !!store.get('token')?.refresh; }

export async function getAccessToken() {
  let tok = store.get('token');
  if (!tok) throw Object.assign(new Error('Não conectado ao Spotify.'), { revoked: true });
  // Renova com folga de 5 min (RF-14)
  if (Date.now() > tok.expiresAt - 5 * 60 * 1000) tok = await refresh();
  return tok.access;
}

export function logout() { store.remove('token'); }

let backoffUntil = 0;
export function isBackoffActive() { return Date.now() < backoffUntil; }
export function getBackoffRemainingSec() { return Math.max(0, Math.ceil((backoffUntil - Date.now()) / 1000)); }
export async function api(path, { method = 'GET', query, body, retry = true } = {}) {
  const wait = backoffUntil - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const url = new URL(path.startsWith('http') ? path : API + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const token = await getAccessToken();
  const t0 = performance.now();
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const latencyMs = Math.round(performance.now() - t0);
  if (res.status === 429) {
    const after = Number(res.headers.get('Retry-After') || 2);
    backoffUntil = Date.now() + after * 1000;
    emit('spotify_429', { retryAfter: after });
    if (retry) return api(path, { method, query, body, retry: false });
  }
  if (res.status === 401 && retry) {
    await refresh();
    return api(path, { method, query, body, retry: false });
  }
  if (res.status === 204 || res.status === 202) return { ok: true, status: res.status, latencyMs, data: null };
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = data?.error?.message || (typeof data === 'string' ? data : '') || `Erro ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    e.reason = data?.error?.reason;
    throw e;
  }
  return { ok: true, status: res.status, latencyMs, data };
}

// ---------- Leitura ----------

export async function getMe() { return (await api('/me')).data; }

export async function getMyPlaylists() {
  const out = [];
  let next = '/me/playlists?limit=50';
  while (next && out.length < 500) {
    const { data } = await api(next);
    out.push(...(data.items || []).filter(Boolean));
    next = data.next;
  }
  return out;
}

export function playlistTotal(p) {
  // fev/2026: o campo "tracks" do objeto playlist virou "items"
  return p?.items?.total ?? p?.tracks?.total ?? null;
}

export async function getPlaylistTracks(playlistId) {
  const tracks = [];
  let skipped = 0;
  let next = `/playlists/${playlistId}/items?limit=50&market=from_token&additional_types=track`;
  while (next && tracks.length < 2000) {
    const { data } = await api(next);
    for (const entry of data.items || []) {
      const t = entry?.item || entry?.track; // fev/2026: "track" → "item"
      if (!t || t.type !== 'track' || t.is_local || t.is_playable === false || !t.id) { skipped++; continue; }
      tracks.push(t);
    }
    next = data.next;
  }
  return { tracks, skipped };
}

// ---------- Reprodução (exige Premium) ----------

export const player = {
  devices: async () => (await api('/me/player/devices')).data?.devices || [],
  state: async () => api('/me/player', { query: { additional_types: 'track' } }),
  queueList: async () => (await api('/me/player/queue')).data,
  transfer: (deviceId, play = false) => api('/me/player', { method: 'PUT', body: { device_ids: [deviceId], play } }),
  play: (deviceId, uris, positionMs = 0) => api('/me/player/play', { method: 'PUT', query: { device_id: deviceId }, body: { uris, position_ms: positionMs } }),
  resume: (deviceId) => api('/me/player/play', { method: 'PUT', query: { device_id: deviceId } }),
  pause: (deviceId) => api('/me/player/pause', { method: 'PUT', query: { device_id: deviceId } }),
  next: (deviceId) => api('/me/player/next', { method: 'POST', query: { device_id: deviceId } }),
  queue: (deviceId, uri) => api('/me/player/queue', { method: 'POST', query: { uri, device_id: deviceId } }),
  volume: (deviceId, pct) => api('/me/player/volume', { method: 'PUT', query: { volume_percent: Math.round(pct), device_id: deviceId } }),
  shuffleOff: (deviceId) => api('/me/player/shuffle', { method: 'PUT', query: { state: false, device_id: deviceId } }),
  repeatOff: (deviceId) => api('/me/player/repeat', { method: 'PUT', query: { state: 'off', device_id: deviceId } }),
};

let sdkPromise = null;
export function loadSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    if (window.Spotify?.Player) return resolve(window.Spotify);
    window.onSpotifyWebPlaybackSDKReady = () => resolve(window.Spotify);
    const s = document.createElement('script');
    s.src = 'https://sdk.scdn.co/spotify-player.js';
    s.onerror = () => { sdkPromise = null; reject(new Error('Não consegui carregar o player do Spotify. Verifique a internet.')); };
    document.head.appendChild(s);
    setTimeout(() => reject(new Error('O player do Spotify demorou demais para carregar.')), 20000);
  });
  return sdkPromise;
}

// Converte o objeto de faixa da Web API no formato interno do PISTA
export function toTrack(t) {
  return {
    id: t.id,
    uri: t.uri,
    title: t.name,
    artist: (t.artists || []).map((a) => a.name).join(', '),
    artistKeys: (t.artists || []).map((a) => (a.id || a.name || '').toLowerCase()),
    album: t.album?.name || '',
    year: (t.album?.release_date || '').slice(0, 4),
    image: (t.album?.images || []).slice(-1)[0]?.url || t.album?.images?.[0]?.url || '',
    imageLarge: t.album?.images?.[0]?.url || '',
    durationMs: t.duration_ms,
    explicit: !!t.explicit,
    url: t.external_urls?.spotify || `https://open.spotify.com/track/${t.id}`,
  };
}
