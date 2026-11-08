// Teste ponta a ponta com Spotify simulado (rotas interceptadas) e com o modo demonstração.
// Uso: node tests/e2e.mjs  (com o servidor do PISTA rodando em http://127.0.0.1:8888)
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const BASE = 'http://127.0.0.1:8888';
const SHOTS = process.env.SHOTS || '.';
const errors = [];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS' };

async function ensureServer() {
  try {
    const res = await fetch(BASE + '/');
    if (res.ok) return null;
  } catch {
    // servidor não está disponível; será iniciado abaixo
  }

  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'servidor.ps1')], {
    cwd: ROOT,
    windowsHide: true,
    stdio: 'ignore',
  });

  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return child;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  child.kill();
  throw new Error('O servidor local do PISTA não respondeu em 20s.');
}

function fakeTracks(n) {
  const genres = ['funk', 'pagode', 'sertanejo', 'pop', 'eletro'];
  return Array.from({ length: n }, (_, i) => ({
    item: {
      type: 'track', id: `t${i}`, uri: `spotify:track:t${i}`, name: `Faixa ${i}${i % 7 === 0 ? ' (Remix)' : ''}${i % 9 === 0 ? ' - Acústico' : ''}`,
      duration_ms: 150000 + (i % 5) * 20000, explicit: false, is_local: false, is_playable: true,
      artists: [{ id: `a${i % 18}`, name: `Artista ${i % 18} ${genres[i % 5]}` }],
      album: { name: `Álbum ${i}`, release_date: '2024-01-01', images: [{ url: `${BASE}/favicon.svg` }] },
      external_urls: { spotify: `https://open.spotify.com/track/t${i}` },
    },
  }));
}

const FAKE_SDK = `
window.Spotify = { Player: class {
  constructor(o){ this.o=o; this.l={}; }
  addListener(e,f){ this.l[e]=f; return true; }
  connect(){ setTimeout(()=>this.l.ready && this.l.ready({device_id:'sdk-device'}), 50); return Promise.resolve(true); }
  activateElement(){ window.__activated = true; }
  async getCurrentState(){ const r = await fetch('https://api.spotify.com/v1/__fake/state'); const s = await r.json(); if(!s.current) return null;
    return { paused: s.paused, position: s.position, duration: 180000, track_window: { current_track: { id: s.current.split(':').pop(), uri: s.current, name: 'x', duration_ms: 180000 } } }; }
  setVolume(){ return Promise.resolve(); }
  nextTrack(){ return fetch('https://api.spotify.com/v1/__fake/next', {method:'POST'}); }
  pause(){ return fetch('https://api.spotify.com/v1/__fake/pause', {method:'POST'}); }
  resume(){ return fetch('https://api.spotify.com/v1/__fake/resume', {method:'POST'}); }
  disconnect(){}
}};
window.onSpotifyWebPlaybackSDKReady && window.onSpotifyWebPlaybackSDKReady();`;

async function spotifyFlow(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(`console: ${m.text()}`); });

  const fake = { current: null, queue: [], paused: true, position: 0, calls: [] };
  const tracks = fakeTracks(40);
  await ctx.route('https://sdk.scdn.co/**', (r) => r.fulfill({ contentType: 'text/javascript', body: FAKE_SDK }));
  await ctx.route('https://accounts.spotify.com/api/token', (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill({ json: { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600, scope: 'x' }, headers: CORS }));
  await ctx.route('https://api.spotify.com/v1/**', async (r) => {
    const u = new URL(r.request().url());
    const m = r.request().method();
    const p = u.pathname.replace('/v1', '');
    fake.calls.push(`${m} ${p}${u.search}`);
    if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    const json = (j, status = 200) => r.fulfill({ status, json: j, headers: CORS });
    if (p === '/__fake/state') return json(fake);
    if (p === '/__fake/next') { fake.current = fake.queue.shift() || null; fake.position = 0; return json({}); }
    if (p === '/__fake/pause') { fake.paused = true; return json({}); }
    if (p === '/__fake/resume') { fake.paused = false; return json({}); }
    if (p === '/me') return json({ id: 'u1', display_name: 'Daniel' });
    if (p === '/me/playlists') return json({ items: [
      { id: 'p1', name: 'Festa de sábado', owner: { id: 'u1', display_name: 'Daniel' }, items: { total: 40 }, images: [] },
      { id: 'p2', name: 'Top Brasil', owner: { id: 'spotify', display_name: 'Spotify' }, items: { total: 50 }, images: [] },
    ], next: null });
    if (p === '/playlists/p1/items') return json({ items: tracks, next: null });
    if (p === '/playlists/p2/items') return json({ error: { status: 403, message: 'Forbidden' } }, 403);
    if (p === '/me/player/devices') return json({ devices: [{ id: 'phone', name: 'Celular', type: 'Smartphone', is_active: false }] });
    if (p === '/me/player/play' && m === 'PUT') { const b = JSON.parse(r.request().postData() || '{}'); if (b.uris) fake.current = b.uris[0]; fake.paused = false; fake.position = b.position_ms || 0; return r.fulfill({ status: 204, headers: CORS }); }
    if (p === '/me/player/queue' && m === 'POST') { fake.queue.push(u.searchParams.get('uri')); return r.fulfill({ status: 204, headers: CORS }); }
    if (p === '/me/player/queue') return json({ queue: fake.queue.map((uri) => ({ uri })) });
    return r.fulfill({ status: 204, headers: CORS });
  });

  // 1) Tela inicial → salvar Client ID dispara o login (interceptado)
  await ctx.route('https://accounts.spotify.com/authorize**', (r) => {
    const u = new URL(r.request().url());
    assert.equal(u.searchParams.get('redirect_uri'), `${BASE}/callback`);
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(u.searchParams.get('scope').includes('streaming'));
    return r.fulfill({ status: 302, headers: { location: `${BASE}/callback?code=CODE123&state=${u.searchParams.get('state')}` } });
  });
  await page.goto(BASE + '/');
  await page.waitForSelector('text=Conectar meu Spotify');
  await page.screenshot({ path: `${SHOTS}/01-inicio.png`, fullPage: true });
  await page.fill('#clientId', 'abcdef0123456789abcdef0123456789');
  await page.click('text=Salvar e conectar');
  await page.waitForSelector('text=Escolha as playlists da festa');
  console.log('ok - login PKCE (autorização → callback → token) e lista de playlists');

  await page.click('[data-id="p1"].pl-hit');
  await page.click('[data-id="p2"].pl-hit');
  await page.selectOption('select[data-id="p1"]', '');
  await page.screenshot({ path: `${SHOTS}/02-playlists.png`, fullPage: true });
  await page.click('text=Carregar músicas →');
  await page.waitForSelector('text=Montar a noite');
  assert.equal(await page.locator('.trow').count(), 40);
  assert.ok(await page.locator('.toast', { hasText: 'Top Brasil' }).count(), 'avisa playlist que não carregou');
  console.log('ok - músicas carregadas (formato item de 2026) e aviso para playlist de terceiros');

  // marcar energia
  await page.click('[data-row="t3"] .e5');
  assert.ok(await page.locator('[data-row="t3"] .e5.on').count());
  const tags = await page.evaluate(() => JSON.parse(localStorage.getItem('pista.tags')));
  assert.equal(tags.t3.energy, 5);
  await page.click('[data-row="t4"] [data-act="never"]');
  await page.waitForFunction(() => document.querySelector('#engine-status')?.textContent.includes('pronto'));
  await page.screenshot({ path: `${SHOTS}/03-montar-noite.png`, fullPage: true });
  console.log('ok - marcação de energia salva, "nunca tocar" e player do navegador pronto');

  await page.click('[data-act="start"]');
  await page.waitForSelector('#lv-title');
  await page.waitForTimeout(1500);
  const first = fake.current;
  assert.ok(first, 'começou a tocar');
  assert.equal(fake.queue.length, 1, 'uma faixa comprometida na fila');
  assert.ok(fake.calls.some((c) => c.startsWith('PUT /me/player/play?device_id=sdk-device')));
  assert.equal(await page.evaluate(() => window.__activated), true, 'activateElement no clique');
  await page.screenshot({ path: `${SHOTS}/04-ao-vivo.png`, fullPage: true });
  console.log('ok - festa começou no player do navegador com 1 faixa na fila');

  // fim natural da faixa: Spotify passa para a da fila → PISTA avança e enfileira a seguinte
  const committed = fake.queue[0];
  fake.current = fake.queue.shift();
  await page.waitForFunction((id) => document.querySelector('#lv-title').textContent && window.document.querySelector('#lv-next li'), committed);
  await page.waitForTimeout(4000);
  assert.equal(fake.queue.length, 1, 'enfileirou a próxima depois da troca');
  assert.notEqual(fake.queue[0], committed);
  console.log('ok - troca de faixa detectada e próxima enfileirada');

  // pular
  await page.click('[data-act="lv-skip"]');
  await page.waitForTimeout(6500);
  assert.equal(fake.queue.length, 1);
  // mais energia
  await page.click('[data-act="lv-up"]');
  await page.waitForFunction(() => /\+1/.test(document.querySelector('#lv-bias').textContent), null, { timeout: 3000 });
  // tocar agora
  await page.click('[data-act="lv-search"]');
  await page.fill('#q', 'Faixa 2');
  await page.click('#results button >> nth=0');
  await page.waitForTimeout(500);
  assert.ok(fake.calls.filter((c) => c.startsWith('PUT /me/player/play')).length >= 2);
  // silêncio: Spotify para do nada → PISTA recupera
  fake.current = null; fake.queue = [];
  await page.waitForTimeout(9000);
  assert.ok(fake.current, 'recuperou do silêncio');
  console.log('ok - pular, mais energia, tocar agora e recuperação de silêncio');

  // recarregar a página → retomar
  const before = fake.current;
  await page.reload();
  await page.waitForSelector('text=Festa em andamento');
  await page.click('[data-act="resume-party"]');
  await page.waitForSelector('#lv-title');
  assert.equal(fake.current, before);
  console.log('ok - retomar depois de recarregar');

  await page.click('[data-act="lv-end"]');
  await page.click('#confirm-ok');
  await page.waitForSelector('text=Festa encerrada', { timeout: 30000 });
  await page.fill('input[name="nota"]', '8');
  await page.check('input[name="denovo"][value="sim"]');
  await page.click('text=Salvar respostas');
  const dl = page.waitForEvent('download');
  await page.click('text=Exportar log (JSON)');
  const file = await dl;
  const path = `${SHOTS}/log.json`;
  await file.saveAs(path);
  const log = JSON.parse(require('fs').readFileSync(path, 'utf8'));
  const types = new Set(log.events.map((e) => e.type));
  for (const t of ['party_started', 'track_started', 'queued', 'intervention', 'silence_detected', 'party_resumed', 'party_closed', 'feedback']) assert.ok(types.has(t), `log tem ${t}`);
  assert.ok(!JSON.stringify(log).includes('AT2'), 'token não vai para o log');
  await page.screenshot({ path: `${SHOTS}/05-resumo.png`, fullPage: true });
  console.log('ok - encerrar, questionário e log exportado (sem token)');

  // excluir dados
  await page.click('[data-act="settings"]');
  await page.click('[data-act="wipe"]');
  await page.click('#confirm-ok');
  await page.waitForSelector('text=Conectar meu Spotify');
  const left = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('pista.')));
  assert.equal(left.length, 0);
  console.log('ok - excluir todos os dados');
  await ctx.close();
}

async function demoFlow(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`demo pageerror: ${e.message}`));
  await page.goto(BASE + '/');
  await page.click('text=Abrir demonstração');
  await page.waitForSelector('text=Montar a noite');
  await page.click('[data-act="speed"][data-v="60"]');
  await page.screenshot({ path: `${SHOTS}/06-demo-celular.png`, fullPage: false });
  await page.click('[data-act="start"]');
  await page.waitForSelector('#lv-title');
  const t1 = await page.textContent('#lv-title');
  await page.waitForTimeout(9000);
  const t2 = await page.textContent('#lv-title');
  assert.notEqual(t1, t2, 'demo avança faixas');
  const w = await page.evaluate(() => document.documentElement.scrollWidth);
  assert.ok(w <= 391, `sem rolagem horizontal (${w})`);
  await page.screenshot({ path: `${SHOTS}/07-demo-ao-vivo-celular.png`, fullPage: true });
  console.log('ok - demonstração avança sozinha e cabe no celular');
  await ctx.close();
}

let serverProcess = null;
try {
  serverProcess = await ensureServer();
  const browser = await chromium.launch();
  try {
    await spotifyFlow(browser);
    await demoFlow(browser);
  } finally {
    await browser.close();
  }
  if (errors.length) { console.error('ERROS NO NAVEGADOR:\n' + errors.join('\n')); process.exit(1); }
  console.log('\nTodos os testes ponta a ponta passaram.');
} finally {
  if (serverProcess) {
    serverProcess.kill();
  }
}
