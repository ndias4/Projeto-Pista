export const DEFAULT_PARTY_CATALOG = {
  partyName: 'Festa',
  current: null,
  phase: 'warmup',
  tracks: [],
};

export const state = {
  partyCatalog: { ...DEFAULT_PARTY_CATALOG },
  guestRequests: [],
};

export function resetState() {
  state.partyCatalog = { ...DEFAULT_PARTY_CATALOG };
  state.guestRequests = [];
}

export function getPartyCatalog() {
  return {
    ...DEFAULT_PARTY_CATALOG,
    ...state.partyCatalog,
    tracks: Array.isArray(state.partyCatalog.tracks) ? [...state.partyCatalog.tracks] : [],
  };
}

export function setPartyCatalog(payload = {}) {
  const next = {
    ...DEFAULT_PARTY_CATALOG,
    ...(payload || {}),
    tracks: Array.isArray(payload?.tracks) ? payload.tracks.slice() : [],
  };
  state.partyCatalog = next;
  return getPartyCatalog();
}

export function getGuestRequests() {
  return [...state.guestRequests];
}

export function addGuestRequest(request) {
  state.guestRequests.push(request);
  return request;
}

export function resolveGuestRequest(requestId, action) {
  const idx = state.guestRequests.findIndex((request) => request.id === requestId);
  if (idx < 0) return null;

  if (action === 'remove' || action === 'decline') {
    const [removed] = state.guestRequests.splice(idx, 1);
    return removed;
  }

  state.guestRequests[idx].status = action;
  return state.guestRequests[idx];
}

export function pendingGuestCountForToken(guestToken) {
  return state.guestRequests.filter((request) => request.guestToken === guestToken && request.status === 'pending').length;
}
