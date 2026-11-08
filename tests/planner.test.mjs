// Testes de propriedade do planejador (E4-4): determinismo, repetição de artista, aderência à fase, "nunca tocar".
import assert from 'node:assert/strict';
import { nextTrack, defaultPhases, phaseAt, targetEnergy, validatePhases, guessFromTitle, countArtists, chooseTrackPhase } from '../site/js/planner.js';
import { demoLibrary } from '../site/js/demo.js';
import { getClientIdIssue, isClientIdValid } from '../site/js/spotify.js';

function simulate(library, seed, durationMin = 240, bias = 0) {
  const party = { durationMin, phases: defaultPhases(durationMin), seed, breathers: true };
  const byId = new Map(library.map((t) => [t.id, t]));
  const history = [];
  const picks = [];
  let t = 0;
  while (t < durationMin) {
    const p = nextTrack({ party, library, byId, history, offsetMin: t, bias });
    if (!p) break;
    picks.push({ ...p, offsetMin: t });
    history.push(p.track.id);
    t += p.track.durationMs / 60000;
  }
  return { party, picks };
}

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('ok -', name); };

const lib = demoLibrary();

test('fases padrão válidas e curva 2→3, 4→5, 3→2', () => {
  const ph = defaultPhases(240);
  assert.equal(validatePhases(ph, 240), null);
  const party = { durationMin: 240, phases: ph, breathers: false };
  assert.equal(targetEnergy(party, 0), 2);
  assert.ok(Math.abs(targetEnergy(party, ph[1].startOffsetMin) - 4) < 0.01);
  assert.ok(targetEnergy(party, 239) < 2.1);
  assert.equal(phaseAt(party, ph[2].startOffsetMin + 1).phase.kind, 'closing');
});

test('auge pedido cai dentro do Pico', () => {
  for (const d of [120, 180, 240, 360, 600]) for (const peak of [60, 90, 120, 180]) {
    if (peak >= d) continue;
    const ph = defaultPhases(d, peak);
    assert.equal(validatePhases(ph, d), null, `${d}/${peak}`);
    assert.equal(phaseAt({ durationMin: d, phases: ph }, peak).phase.kind, 'peak', `${d}/${peak}`);
  }
});

test('determinismo: mesma semente → mesma ordem', () => {
  const a = simulate(lib, 42).picks.map((p) => p.track.id).join();
  const b = simulate(lib, 42).picks.map((p) => p.track.id).join();
  const c = simulate(lib, 7).picks.map((p) => p.track.id).join();
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('sem artista repetido em 8 faixas quando há ≥ 15 artistas (até a biblioteca esgotar)', () => {
  assert.ok(countArtists(lib) >= 15, `artistas: ${countArtists(lib)}`);
  for (const seed of [1, 2, 3, 4, 5]) {
    const { picks } = simulate(lib, seed, 180);
    const firstPass = picks.slice(0, Math.min(picks.length, 40));
    let violations = 0;
    for (let i = 0; i < firstPass.length; i++) {
      for (let k = Math.max(0, i - 3); k < i; k++) if (firstPass[k].track.artist === firstPass[i].track.artist) violations++;
    }
    assert.equal(violations, 0, `seed ${seed}: artista repetido em ≤3 faixas`);
  }
});

test('nenhuma faixa repete antes de a biblioteca acabar', () => {
  const { picks } = simulate(lib, 9, 240);
  const n = Math.min(picks.length, lib.length);
  assert.equal(new Set(picks.slice(0, n).map((p) => p.track.id)).size, n);
});

test('aderência à fase: energia média segue a curva', () => {
  const { party, picks } = simulate(lib, 11, 240);
  const avg = (k) => { const xs = picks.filter((p) => phaseAt(party, p.offsetMin).phase.kind === k).map((p) => p.track.energy); return xs.reduce((a, b) => a + b, 0) / xs.length; };
  const w = avg('warmup'), p = avg('peak'), c = avg('closing');
  console.log(`   energia média: aquecimento ${w.toFixed(2)} · pico ${p.toFixed(2)} · fim ${c.toFixed(2)}`);
  assert.ok(p > w + 1, 'pico mais forte que o aquecimento');
  assert.ok(p > c + 1, 'pico mais forte que o fim');
});

test('"Mais energia" (+2) sobe a energia escolhida', () => {
  const base = simulate(lib, 3, 120, 0).picks.slice(0, 8).reduce((a, p) => a + p.track.energy, 0);
  const up = simulate(lib, 3, 120, 2).picks.slice(0, 8).reduce((a, p) => a + p.track.energy, 0);
  assert.ok(up > base, `${up} > ${base}`);
});

test('"nunca tocar" é respeitado (100 sorteios)', () => {
  const l2 = lib.map((t, i) => ({ ...t, neverPlay: i % 4 === 0 }));
  for (let s = 0; s < 100; s++) {
    const { picks } = simulate(l2, s, 60);
    assert.ok(picks.every((p) => !p.track.neverPlay));
  }
});

test('playlist presa a uma fase só toca nela enquanto houver alternativa', () => {
  const l2 = lib.map((t, i) => ({ ...t, phase: i % 3 === 0 ? 'closing' : null }));
  const { party, picks } = simulate(l2, 5, 240);
  const early = picks.filter((p) => phaseAt(party, p.offsetMin).phase.kind === 'warmup');
  assert.ok(early.every((p) => p.track.phase !== 'closing'));
});

test('múltiplas playlists por fase elegem uma fase estável para faixas duplicadas', () => {
  assert.equal(chooseTrackPhase(['peak', 'warmup', 'peak']), 'peak');
  assert.equal(chooseTrackPhase(['closing', 'warmup']), 'warmup');
  assert.equal(chooseTrackPhase([]), null);
  assert.equal(chooseTrackPhase(['peak']), 'peak');
});

test('biblioteca pequena (5 faixas) repete sem travar', () => {
  const small = lib.slice(0, 5);
  const { picks } = simulate(small, 1, 60);
  assert.ok(picks.length > 5);
});

test('desempenho: 1000 faixas, escolha < 150 ms', () => {
  const big = [];
  for (let i = 0; i < 1000; i++) big.push({ ...lib[i % lib.length], id: `b${i}`, artistKeys: [`a${i % 220}`] });
  const party = { durationMin: 240, phases: defaultPhases(240), seed: 1 };
  const t0 = performance.now();
  nextTrack({ party, library: big, history: [], offsetMin: 0 });
  const ms = performance.now() - t0;
  console.log(`   ${ms.toFixed(1)} ms`);
  assert.ok(ms < 150);
});

test('palpite pelo título', () => {
  assert.equal(guessFromTitle('Evidências - Acústico').energy, 2);
  assert.equal(guessFromTitle('Música X (Remix)').energy, 4);
  assert.equal(guessFromTitle('Música Y - Ao Vivo').live, true);
  assert.equal(guessFromTitle('Normal').energy, 3);
});

test('validação do Client ID do Spotify é rigorosa e útil', () => {
  assert.equal(isClientIdValid('abcdef0123456789abcdef0123456789'), true);
  assert.equal(isClientIdValid('  abcdef0123456789abcdef0123456789  '), true);
  assert.equal(isClientIdValid('short'), false);
  assert.equal(isClientIdValid('abc!def0123456789abcdef0123456789'), false);
  assert.match(getClientIdIssue(''), /Falta o Client ID/i);
  assert.match(getClientIdIssue('short'), /20 e 64/i);
});

console.log(`\n${passed} testes passaram`);
