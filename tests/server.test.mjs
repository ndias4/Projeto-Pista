import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../server.js';
import { resetState } from '../server/state.js';

async function withServer(fn) {
  resetState();
  const server = await startServer(0);
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    await fn({ base, port, server });
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    resetState();
  }
}

test('GET /api/host/requests retorna array vazio, um item e dois itens', async () => {
  await withServer(async ({ base }) => {
    const empty = await fetch(`${base}/api/host/requests`).then((res) => res.json());
    assert.deepEqual(empty, []);

    const first = { trackId: 'track-1', title: 'Primeira', artist: 'A', guestToken: 'guest-1' };
    await fetch(`${base}/api/guest/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(first),
    });

    const oneItem = await fetch(`${base}/api/host/requests`).then((res) => res.json());
    assert.equal(Array.isArray(oneItem), true);
    assert.equal(oneItem.length, 1);

    await fetch(`${base}/api/guest/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...first, title: 'Segunda', trackId: 'track-2' }),
    });

    const twoItems = await fetch(`${base}/api/host/requests`).then((res) => res.json());
    assert.equal(Array.isArray(twoItems), true);
    assert.equal(twoItems.length, 2);
  });
});

test('rejeita payload inválido e limita 3 pedidos pendentes por guestToken', async () => {
  await withServer(async ({ base }) => {
    const invalid = await fetch(`${base}/api/guest/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Sem trackId', guestToken: 'token-x' }),
    });
    assert.equal(invalid.status, 400);

    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${base}/api/guest/suggest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackId: `track-${i}`, title: `Faixa ${i}`, artist: 'Artista', guestToken: 'token-x' }),
      });
      assert.equal(res.status, 200, `esperava 200 para pedido ${i + 1}`);
    }

    const blocked = await fetch(`${base}/api/guest/suggest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackId: 'track-3', title: 'Faixa 3', artist: 'Artista', guestToken: 'token-x' }),
    });
    assert.equal(blocked.status, 429);
    const payload = await blocked.json();
    assert.match(payload.error, /Limite de 3 pedidos/);
  });
});

test('sincroniza payload grande e lê POST com cabeçalho e body em pacotes separados', async () => {
  await withServer(async ({ base, port }) => {
    const bigTracks = Array.from({ length: 320 }, (_, i) => ({
      id: `track-${i}`,
      title: `Musica ${i}`,
      artist: 'Artista',
      image: `https://example.com/${i}.png`,
    }));

    const payload = JSON.stringify({
      partyName: 'Festa grande',
      current: { title: 'Atual', artist: 'Artista', image: 'https://example.com/current.png' },
      phase: 'peak',
      tracks: bigTracks,
    });

    const syncRes = await fetch(`${base}/api/party/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    assert.equal(syncRes.status, 200);

    const catalog = await fetch(`${base}/api/party/catalog`).then((res) => res.json());
    assert.equal(catalog.partyName, 'Festa grande');
    assert.equal(catalog.phase, 'peak');
    assert.equal(catalog.tracks.length, bigTracks.length);
    assert.equal(JSON.stringify(catalog), payload);

    const socket = net.connect(port, '127.0.0.1');
    const body = JSON.stringify({
      trackId: 'track-split',
      title: 'Faixa split',
      artist: 'Artista split',
      guestToken: 'token-split',
    });
    const headers = `POST /api/guest/suggest HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`;

    await new Promise((resolve, reject) => {
      const chunks = [];
      socket.on('data', (chunk) => {
        chunks.push(chunk);
      });
      socket.on('error', reject);
      socket.on('close', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        assert.match(text, /HTTP\/1\.1 200 OK/);
        assert.match(text, /Pedido enviado com sucesso/);
        resolve();
      });
      socket.write(headers);
      setTimeout(() => socket.write(body), 25);
    });
  });
});
