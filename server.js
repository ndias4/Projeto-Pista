import express from 'express';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  addGuestRequest,
  getGuestRequests,
  getPartyCatalog,
  pendingGuestCountForToken,
  resetState,
  resolveGuestRequest,
  setPartyCatalog,
} from './server/state.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const siteDir = path.join(__dirname, 'site');
const DEFAULT_PORT = 8888;

function firstLocalIPv4() {
  const ifaces = networkInterfaces();
  const seen = new Set();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      if (seen.has(entry.address)) continue;
      seen.add(entry.address);
      return entry.address;
    }
  }
  return '127.0.0.1';
}

function getGuestUrl(port) {
  const publicUrl = process.env.PUBLIC_URL?.trim();
  if (publicUrl) return `${publicUrl.replace(/\/+$/, '')}/guest`;
  return `http://${firstLocalIPv4()}:${port}/guest`;
}

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '1mb' }));
app.use(express.static(siteDir, { index: false }));

app.get('/api/network-info', (req, res) => {
  const port = req.socket.localPort || Number(process.env.PORT || DEFAULT_PORT);
  res.json({
    localIp: firstLocalIPv4(),
    port,
    guestUrl: getGuestUrl(port),
  });
});

app.post('/api/party/sync', (req, res) => {
  setPartyCatalog(req.body || {});
  res.json({ ok: true });
});

app.get('/api/party/catalog', (req, res) => {
  res.json(getPartyCatalog());
});

app.post('/api/guest/suggest', (req, res) => {
  const { trackId, title, artist, guestToken } = req.body || {};

  if (typeof trackId !== 'string' || !trackId.trim()) {
    return res.status(400).json({ error: 'trackId inválido' });
  }
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title inválido' });
  }
  if (typeof guestToken !== 'string' || !guestToken.trim()) {
    return res.status(400).json({ error: 'guestToken inválido' });
  }

  if (pendingGuestCountForToken(guestToken) >= 3) {
    return res.status(429).json({ error: 'Limite de 3 pedidos atingido. Aguarde o DJ tocar algum!' });
  }

  const request = {
    id: `req-${Math.random().toString(36).slice(2, 10)}`,
    trackId: trackId.trim(),
    title: title.trim(),
    artist: typeof artist === 'string' ? artist.trim() : '',
    guestToken: guestToken.trim(),
    status: 'pending',
    time: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false }),
  };

  addGuestRequest(request);
  res.json({ ok: true, message: 'Pedido enviado com sucesso!' });
});

app.get('/api/host/requests', (req, res) => {
  res.json(getGuestRequests());
});

app.post('/api/host/requests/resolve', (req, res) => {
  const { requestId, action } = req.body || {};
  if (!requestId) return res.status(400).json({ error: 'requestId obrigatório' });

  if (action === 'remove' || action === 'decline') {
    resolveGuestRequest(requestId, action);
    return res.json({ ok: true });
  }

  resolveGuestRequest(requestId, action || 'queued');
  return res.json({ ok: true });
});

app.get(['/', '/callback', '/callback/', '/guest', '/guest/', '/pedir'], (req, res) => {
  const target = req.path === '/guest' || req.path === '/guest/' || req.path === '/pedir' ? 'guest.html' : 'index.html';
  res.sendFile(path.join(siteDir, target));
});

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

export function startServer(port = Number(process.env.PORT || DEFAULT_PORT)) {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, '0.0.0.0', () => {
      const actualPort = server.address().port;
      const guestUrl = getGuestUrl(actualPort);
      console.log('');
      console.log('  ========================================================');
      console.log('   PISTA (versao Node/Express) esta rodando');
      console.log(`   Painel do Anfitriao: http://127.0.0.1:${actualPort}/`);
      console.log(`   Link para Convidados: ${guestUrl}`);
      console.log('  ========================================================');
      console.log('');
      resolve(server);
    });

    server.on('error', reject);
  });
}

export { app };

const isDirectExecution = Boolean(process.argv[1]) && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectExecution) {
  startServer(Number(process.env.PORT || DEFAULT_PORT)).catch((error) => {
    console.error('Erro ao iniciar o servidor:', error);
    process.exitCode = 1;
  });
}
