import { ENERGY_LABELS, scoresToEnergy } from './ai-energy.js';

const MODEL_ID = 'Xenova/clap-htsat-unfused';
const LABELS = Object.values(ENERGY_LABELS);
let classifierPromise = null;

async function loadClassifier() {
  if (classifierPromise) return classifierPromise;

  classifierPromise = (async () => {
    const transformersModule = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.0');
    const { pipeline, env } = transformersModule;
    env.allowLocalModels = false;
    env.useBrowserCache = true;

    return pipeline('zero-shot-audio-classification', MODEL_ID, {
      dtype: 'q8',
      progress_callback: (progress) => {
        self.postMessage({
          type: 'progress',
          stage: 'download',
          progress,
          model: MODEL_ID,
        });
      },
    });
  })();

  return classifierPromise;
}

function averageScores(list) {
  const byLabel = {};
  for (const item of list) {
    for (const [label, value] of Object.entries(item || {})) {
      byLabel[label] = (byLabel[label] || 0) + Number(value || 0);
    }
  }
  const total = Object.values(byLabel).reduce((sum, value) => sum + value, 0) || 1;
  return Object.fromEntries(Object.entries(byLabel).map(([label, value]) => [label, value / total]));
}

self.addEventListener('message', async (event) => {
  const message = event.data || {};
  if (!message || message.type !== 'estimate') return;

  const { id, windows = [] } = message;
  try {
    const classifier = await loadClassifier();
    const results = [];

    for (const window of windows) {
      if (!(window instanceof Float32Array)) continue;
      const prediction = await classifier(window, { candidate_labels: LABELS, top_k: null });
      const normalized = Array.isArray(prediction) ? prediction : [prediction];
      const perLabel = {};
      for (const item of normalized) {
        const label = item?.label || item?.text || '';
        const score = Number(item?.score ?? 0);
        if (label && Number.isFinite(score)) perLabel[label] = score;
      }
      results.push(perLabel);
    }

    const aggregated = averageScores(results);
    const parsed = scoresToEnergy(aggregated);
    self.postMessage({
      type: 'result',
      id,
      energy: parsed.energy,
      confidence: parsed.confidence,
      scores: aggregated,
      label: parsed.label,
    });
  } catch (error) {
    self.postMessage({
      type: 'error',
      id,
      message: error?.message || 'Erro ao analisar o áudio local com IA.',
    });
  }
});
