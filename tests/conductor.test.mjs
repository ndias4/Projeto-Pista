import assert from 'node:assert/strict';
import { Conductor } from '../site/js/conductor.js';

const makeConductor = () => {
  const engine = {
    kind: 'demo',
    clock: { now: () => 0 },
    enqueue: async () => {},
    start: async () => {},
    pause: async () => {},
    resume: async () => {},
    skip: async () => {},
    getState: async () => ({ active: true, ids: ['a1'], positionMs: 0, offline: false, paused: false }),
    destroy: () => {},
    queueContains: async () => false,
    finish: async () => {},
  };

  const party = {
    id: 'party-1',
    name: 'Festa de teste',
    durationMin: 240,
    createdAt: Date.now(),
    phases: [],
    seed: 7,
  };

  const library = [
    { id: 'a1', uri: 'spotify:track:a1', title: 'Faixa 1', artist: 'Artista 1', durationMs: 180000, energy: 3 },
    { id: 'a2', uri: 'spotify:track:a2', title: 'Faixa 2', artist: 'Artista 2', durationMs: 180000, energy: 3 },
  ];

  return new Conductor({ party, library, engine });
};

const c = makeConductor();
c.live.currentId = 'a1';
c.live.played = ['a1'];

c.playNext('a2');
await c.commitNext();

assert.equal(c.live.priority.length, 0, 'fila de prioridade deve limpar o item usado');
assert.equal(c.live.committedId, 'a2', 'commitNext() deve escolher a faixa marcada com playNext()');
assert.deepEqual(c.live.committedReason, ['pedido de convidado']);

console.log('ok - conductor prioriza playNext()');
