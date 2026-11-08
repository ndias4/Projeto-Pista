// Biblioteca fictícia para o modo demonstração (nomes inventados; não são músicas reais).
import { hash01 } from './planner.js';

const ARTISTS = {
  'funk': ['MC Exemplo', 'Baile Fictício', 'DJ Teste 150'],
  'pagode/samba': ['Grupo Roda Imaginária', 'Pagode da Laje Demo'],
  'sertanejo': ['Dupla Estrada de Teste', 'Viola Inventada'],
  'pop': ['Luna Demo', 'Os Protótipos', 'Clara Placeholder'],
  'eletrônica': ['Kollektiv Sample', 'Nave 128', 'Synth Fantasia'],
  'mpb': ['Marina do Exemplo', 'Trio Varanda'],
  'forró/piseiro': ['Piseiro Simulado'],
  'hip-hop/rap': ['Rima Fictícia'],
};
const WORDS = ['Luz', 'Quintal', 'Madrugada', 'Calor', 'Varanda', 'Neon', 'Saudade', 'Batida', 'Verão', 'Lua', 'Estrada', 'Rua', 'Fogo', 'Brisa', 'Céu', 'Laje', 'Ritmo', 'Pista', 'Maré', 'Cidade'];
const ENERGY_BY_GENRE = { 'funk': [4, 5], 'pagode/samba': [3, 4], 'sertanejo': [2, 4], 'pop': [2, 4], 'eletrônica': [3, 5], 'mpb': [1, 3], 'forró/piseiro': [3, 4], 'hip-hop/rap': [3, 4] };
const COLORS = ['#ff5a3c', '#ffb23c', '#7c5cff', '#2ec4b6', '#ff3c8e', '#3c9bff', '#9be15d', '#f7d154'];

function cover(i) {
  const c1 = COLORS[i % COLORS.length], c2 = COLORS[(i * 3 + 2) % COLORS.length];
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'><stop offset='0' stop-color='${c1}'/><stop offset='1' stop-color='${c2}'/></linearGradient></defs><rect width='64' height='64' fill='url(#g)'/><circle cx='32' cy='32' r='14' fill='none' stroke='rgba(0,0,0,.35)' stroke-width='6'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function demoLibrary() {
  const tracks = [];
  let i = 0;
  for (const [genre, artists] of Object.entries(ARTISTS)) {
    const per = genre === 'funk' || genre === 'pop' || genre === 'eletrônica' ? 9 : 7;
    for (let k = 0; k < per; k++) {
      const artist = artists[k % artists.length];
      const w1 = WORDS[Math.floor(hash01(`${genre}${k}a`) * WORDS.length)];
      const w2 = WORDS[Math.floor(hash01(`${genre}${k}b`) * WORDS.length)];
      const [lo, hi] = ENERGY_BY_GENRE[genre];
      const energy = lo + Math.floor(hash01(`${genre}${k}e`) * (hi - lo + 1));
      const live = genre === 'pagode/samba' && k % 3 === 0;
      const id = `demo${i}`;
      tracks.push({
        id, uri: `demo:track:${id}`,
        title: `${w1} de ${w2}${live ? ' (Ao Vivo)' : ''}`,
        artist, artistKeys: [artist.toLowerCase()], album: 'Álbum de demonstração', year: '2026',
        image: cover(i), imageLarge: cover(i),
        durationMs: Math.round((150 + hash01(`${id}d`) * 110) * 1000),
        energy, energySource: 'demo', genre, isLive: live, neverPlay: false,
        playlistId: 'demo', url: null,
      });
      i++;
    }
  }
  return tracks;
}
