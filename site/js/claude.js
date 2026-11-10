// PISTA · Claude (opcional)
// 1) Intérprete de intenção (03 §7.3): recebe SÓ o texto do anfitrião → plano de fases. Permitido pela análise.
// 2) MODO EXPERIMENTAL: envia título/artista das faixas para estimar energia e gênero.
//    Isso CONTRARIA a decisão D-05 da análise (pendência jurídica J-01). Só para teste interno,
//    desligado por padrão e com consentimento explícito na tela.

import { store } from './store.js';
import { GENRES, validatePhases, PHASE_KINDS } from './planner.js';

export const AI_PROVIDERS = [
  { value: 'claude', label: 'Claude (Anthropic)', apiLabel: 'Chave da API da Anthropic', placeholder: 'sk-ant-…', defaultModel: 'claude-haiku-5-5' },
  { value: 'gemini', label: 'Gemini (Google)', apiLabel: 'Chave da API do Gemini', placeholder: 'AIza…', defaultModel: 'gemini-3.8-flash' },
  { value: 'openai', label: 'OpenAI / ChatGPT', apiLabel: 'Chave da API da OpenAI', placeholder: 'sk-…', defaultModel: 'gpt-4o-mini' },
  { value: 'haikai', label: 'Haikai', apiLabel: 'Chave da API do Haikai', placeholder: '…', defaultModel: 'haikai-default' },
];

export const DEFAULT_PROVIDER = 'claude';
export const DEFAULT_MODEL = 'claude-haiku-5-5';

export function getAiProviderMeta(provider = DEFAULT_PROVIDER) {
  return AI_PROVIDERS.find((entry) => entry.value === provider) || AI_PROVIDERS[0];
}

function normalizeProviderModel(provider, value) {
  if (provider !== 'gemini') return value || getAiProviderMeta(provider).defaultModel;
  const raw = String(value || '').trim();
  if (!raw) return getAiProviderMeta(provider).defaultModel;
  const cleaned = raw.replace(/^models\//i, '').replace(/^gemini\//i, '').replace(/\s+/g, '');
  if (cleaned.includes('2.5-flash') || cleaned.includes('2.0-flash') || cleaned.includes('1.5-flash') || cleaned.includes('gemini-')) {
    if (cleaned.includes('3.8-flash')) return 'gemini-3.8-flash';
    return 'gemini-3.8-flash';
  }
  return cleaned || getAiProviderMeta(provider).defaultModel;
}

export function aiSettings() {
  const provider = store.get('aiProvider', store.get('anthropicProvider', DEFAULT_PROVIDER));
  const supportedProvider = AI_PROVIDERS.some((entry) => entry.value === provider) ? provider : DEFAULT_PROVIDER;
  const defaultModel = getAiProviderMeta(supportedProvider).defaultModel;
  const storedModel = store.get('aiModel', store.get('anthropicModel', defaultModel)) || defaultModel;
  const normalizedModel = normalizeProviderModel(supportedProvider, storedModel);
  if (supportedProvider === 'gemini' && normalizedModel !== storedModel) {
    store.set('aiModel', normalizedModel);
    store.set('anthropicModel', normalizedModel);
  }
  return {
    provider: supportedProvider,
    key: store.get('aiKey', store.get('anthropicKey', '')),
    model: normalizedModel,
    experimental: store.get('experimentalAi', false),
  };
}

export const claudeSettings = aiSettings;

function parseJsonResponse(text) {
  if (!text || typeof text !== 'string') return null;
  const compact = text.trim();
  const cleaned = compact.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
    }
    return null;
  }
}

async function callTool({ system, user, tool, maxTokens = 4096, timeoutMs = 45000 }) {
  const { key, model, provider } = aiSettings();
  const providerMeta = getAiProviderMeta(provider);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    if (provider === 'gemini') {
      if (!key) throw new Error(`Configure a chave da API do ${providerMeta.label} em Configurações.`);
      const normalizedModel = String(model || '').trim().replace(/^models\//i, '').replace(/^gemini\//i, '').replace(/\s+/g, '');
      if (!normalizedModel) throw new Error('Informe um modelo válido do Gemini, por exemplo: gemini-2.5-flash.');
      const payload = {
        contents: [{
          role: 'user',
          parts: [{
            text: `${system}\n\n${user}\n\nResponda SOMENTE em JSON válido, sem explicações, sem markdown e sem texto extra.`,
          }],
        }],
        generationConfig: { responseMimeType: 'application/json' },
      };
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(normalizedModel)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error?.message || `Gemini respondeu com erro ${res.status}`);
      const text = (json.candidates || []).map((c) => (c.content?.parts || []).map((p) => p.text || '').join('')).join('');
      const parsed = parseJsonResponse(text);
      if (!parsed) throw new Error('Gemini não devolveu um JSON válido para a solicitação.');
      return parsed;
    }

    if (provider !== 'claude') {
      throw new Error(`O provedor ${providerMeta.label} ainda não está integrado ao fluxo de IA do PISTA. Use Claude para gerar o plano e a estimativa por enquanto.`);
    }

    if (!key) throw new Error(`Configure a chave da API do ${providerMeta.label} em Configurações.`);

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system,
        tools: [tool],
        tool_choice: { type: 'tool', name: tool.name },
        messages: [{ role: 'user', content: user }],
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.message || `Claude respondeu com erro ${res.status}`);
    const block = (json.content || []).find((b) => b.type === 'tool_use');
    if (!block) throw new Error('Claude não devolveu a resposta no formato esperado.');
    return block.input;
  } catch (e) {
    if (e.name === 'AbortError') throw new Error('A IA demorou demais para responder. A festa segue com o modelo padrão.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 1) Intérprete de intenção ----------
const PLAN_TOOL = {
  name: 'plano_da_festa',
  description: 'Devolve o plano de fases da festa em formato estruturado.',
  input_schema: {
    type: 'object',
    properties: {
      phases: {
        type: 'array', minItems: 3, maxItems: 3,
        items: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: PHASE_KINDS },
            startOffsetMin: { type: 'integer', minimum: 0 },
            energyStart: { type: 'integer', minimum: 1, maximum: 5 },
            energyEnd: { type: 'integer', minimum: 1, maximum: 5 },
          },
          required: ['kind', 'startOffsetMin', 'energyStart', 'energyEnd'],
        },
      },
      notes: { type: 'string', description: 'Uma ou duas frases em português explicando o plano para o anfitrião.' },
    },
    required: ['phases', 'notes'],
  },
};

export async function interpretIntent(text, durationMin, startTimeLabel) {
  const input = await callTool({
    system: 'Você ajuda um anfitrião brasileiro a planejar a música de uma festa em casa. Converta o pedido em exatamente 3 fases na ordem warmup (aquecimento), peak (pico), closing (fim de noite). Energia vai de 1 (bem calma) a 5 (pista cheia). startOffsetMin é em minutos desde o início; warmup começa em 0; os inícios são crescentes e menores que a duração total. Responda só pela ferramenta.',
    user: `Duração da festa: ${durationMin} minutos. Início: ${startTimeLabel}.\nPedido do anfitrião: """${String(text).slice(0, 1500)}"""`,
    tool: PLAN_TOOL,
    maxTokens: 800,
    timeoutMs: 20000,
  });
  const order = { warmup: 0, peak: 1, closing: 2 };
  const phases = (input.phases || []).slice().sort((a, b) => order[a.kind] - order[b.kind]).map((p) => ({
    kind: p.kind, startOffsetMin: Math.round(p.startOffsetMin), energyStart: Math.round(p.energyStart), energyEnd: Math.round(p.energyEnd),
  }));
  if (phases[0]) phases[0].startOffsetMin = 0;
  const err = validatePhases(phases, durationMin);
  if (err) throw new Error(`O plano sugerido veio inválido (${err}). Mantive o padrão.`);
  return { phases, notes: String(input.notes || '').slice(0, 400) };
}

// ---------- 2) EXPERIMENTAL: energia e gênero por título/artista ----------
const ENERGY_TOOL = {
  name: 'registrar_faixas',
  description: 'Registra a energia estimada e o gênero de cada faixa.',
  input_schema: {
    type: 'object',
    properties: {
      faixas: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            i: { type: 'integer', description: 'índice recebido' },
            energia: { type: 'integer', minimum: 1, maximum: 5 },
            genero: { type: 'string', enum: GENRES },
            ao_vivo: { type: 'boolean' },
          },
          required: ['i', 'energia', 'genero'],
        },
      },
    },
    required: ['faixas'],
  },
};

export async function estimateTracks(tracks, onProgress = () => {}) {
  const results = new Map();
  const BATCH = 60;
  for (let s = 0; s < tracks.length; s += BATCH) {
    const batch = tracks.slice(s, s + BATCH);
    const lines = batch.map((t, i) => `${i}\t${t.title}\t${t.artist}\t${t.year || ''}`).join('\n');
    const input = await callTool({
      system: 'Você é um DJ brasileiro experiente. Para cada faixa (índice, título, artista, ano), estime a energia para pista de dança de 1 (bem calma, para conversar) a 5 (auge da festa) e o gênero mais provável dentro da lista permitida. Se não conhecer a faixa, use o artista e o título como pista e escolha energia 3. Marque ao_vivo quando o título indicar gravação ao vivo. Responda só pela ferramenta, cobrindo todos os índices.',
      user: `Faixas:\n${lines}`,
      tool: ENERGY_TOOL,
      maxTokens: 4000,
    });
    for (const r of input.faixas || []) {
      const t = batch[r.i];
      if (!t) continue;
      const energia = Math.round(Number(r.energia));
      if (!(energia >= 1 && energia <= 5)) continue;
      results.set(t.id, { energy: energia, genre: GENRES.includes(r.genero) ? r.genero : 'outro', live: !!r.ao_vivo });
    }
    onProgress(Math.min(tracks.length, s + BATCH), tracks.length);
  }
  return results;
}
