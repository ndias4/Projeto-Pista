import test from 'node:test';
import assert from 'node:assert/strict';
import { scoresToEnergy, ENERGY_LABELS } from '../site/js/ai-energy.js';

test('score concentrado num rótulo → a energia daquele rótulo', () => {
  const scores = { [ENERGY_LABELS[5]]: 0.9, [ENERGY_LABELS[4]]: 0.05, [ENERGY_LABELS[3]]: 0.05 };
  const result = scoresToEnergy(scores);
  assert.equal(result.energy, 5);
  assert.ok(result.confidence > 0.8);
});

test('scores uniformes → 3', () => {
  const scores = {
    [ENERGY_LABELS[1]]: 0.2,
    [ENERGY_LABELS[2]]: 0.2,
    [ENERGY_LABELS[3]]: 0.2,
    [ENERGY_LABELS[4]]: 0.2,
    [ENERGY_LABELS[5]]: 0.2,
  };
  const result = scoresToEnergy(scores);
  assert.equal(result.energy, 3);
});

test('limites 1 e 5 respeitados', () => {
  const low = scoresToEnergy({ [ENERGY_LABELS[1]]: 1 });
  const high = scoresToEnergy({ [ENERGY_LABELS[5]]: 1 });
  assert.equal(low.energy, 1);
  assert.equal(high.energy, 5);
});

test('confidence correto', () => {
  const result = scoresToEnergy({ [ENERGY_LABELS[2]]: 0.7, [ENERGY_LABELS[3]]: 0.3 });
  assert.ok(Math.abs(result.confidence - 0.7) < 0.0001);
});
