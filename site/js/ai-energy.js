export const ENERGY_LABELS = {
  1: 'calm slow acoustic music',
  2: 'relaxed mellow music',
  3: 'groovy mid-tempo music',
  4: 'upbeat energetic music',
  5: 'intense dance music with a heavy beat',
};

export function normalizeScores(scores) {
  const entries = Object.entries(scores || {}).filter(([, value]) => Number.isFinite(Number(value)) && Number(value) >= 0);
  if (!entries.length) return {};
  const total = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  if (total <= 0) return Object.fromEntries(entries.map(([label]) => [label, 1 / entries.length]));
  return Object.fromEntries(entries.map(([label, value]) => [label, Number(value) / total]));
}

export function scoresToEnergy(scores) {
  const normalized = normalizeScores(scores);
  const entries = Object.entries(normalized);
  if (!entries.length) {
    return { energy: 3, confidence: 0, label: ENERGY_LABELS[3] };
  }

  const maxEntry = entries.reduce((best, current) => (current[1] > best[1] ? current : best), entries[0]);
  const weighted = entries.reduce((sum, [label, value]) => {
    const energy = Number(Object.keys(ENERGY_LABELS).find((key) => ENERGY_LABELS[key] === label) || 3);
    return sum + (energy * value);
  }, 0);
  const totalWeight = entries.reduce((sum, [, value]) => sum + value, 0) || 1;
  const energy = Math.min(5, Math.max(1, Math.round(weighted / totalWeight)));

  return {
    energy,
    confidence: Number(maxEntry[1]),
    label: maxEntry[0],
  };
}
