// Armazenamento local (só neste navegador). Nada vai para servidor.
const P = 'pista.';
export const store = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(P + key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(P + key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(P + key); } catch { /* ignore */ } },
  clearAll() {
    try {
      Object.keys(localStorage).filter((k) => k.startsWith(P)).forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};
