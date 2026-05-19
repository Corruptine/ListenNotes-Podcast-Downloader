import {
  DEFAULT_LIST_ORDER,
  getEpisodeKey,
  normalizeListOrder,
} from './popup-selection.mjs';

export const POPUP_SESSION_STATE_KEY = 'listenNotesPopupState';
export const POPUP_STATE_VERSION = 1;

const VALID_START_ACTIONS = new Set(['download', 'zip']);

function normalizeEpisodes(episodes) {
  return (Array.isArray(episodes) ? episodes : [])
    .filter((episode) => episode && typeof episode === 'object')
    .map((episode) => ({ ...episode }));
}

export function normalizeSelectedEpisodeIds(episodes, selectedEpisodeIds) {
  const allowedKeys = new Set(
    normalizeEpisodes(episodes)
      .map((episode) => getEpisodeKey(episode))
      .filter(Boolean)
  );
  const rawIds = selectedEpisodeIds instanceof Set
    ? [...selectedEpisodeIds]
    : (Array.isArray(selectedEpisodeIds) ? selectedEpisodeIds : []);
  const normalized = [];
  const seen = new Set();

  for (const rawId of rawIds) {
    const id = String(rawId || '');
    if (!id || !allowedKeys.has(id) || seen.has(id)) continue;
    seen.add(id);
    normalized.push(id);
  }

  return normalized;
}

export function buildPopupSessionState({
  sourceTabId = null,
  sourceUrl = '',
  episodes = [],
  selectedEpisodeIds = [],
  selectFirstCount = '',
  listOrder = DEFAULT_LIST_ORDER,
  now = Date.now(),
} = {}) {
  const normalizedEpisodes = normalizeEpisodes(episodes);
  const normalizedSourceTabId = Number.isFinite(Number(sourceTabId))
    ? Number(sourceTabId)
    : null;

  return {
    version: POPUP_STATE_VERSION,
    sourceTabId: normalizedSourceTabId,
    sourceUrl: String(sourceUrl || ''),
    episodes: normalizedEpisodes,
    selectedEpisodeIds: normalizeSelectedEpisodeIds(normalizedEpisodes, selectedEpisodeIds),
    selectFirstCount: String(selectFirstCount ?? ''),
    listOrder: normalizeListOrder(listOrder),
    savedAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
  };
}

export function restorePopupSessionState(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.version !== POPUP_STATE_VERSION) return null;

  const restored = buildPopupSessionState({
    sourceTabId: value.sourceTabId,
    sourceUrl: value.sourceUrl,
    episodes: value.episodes,
    selectedEpisodeIds: value.selectedEpisodeIds,
    selectFirstCount: value.selectFirstCount,
    listOrder: value.listOrder,
    now: value.savedAt,
  });

  return restored.episodes.length > 0 ? restored : null;
}

export function parsePopupStartAction(search = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const action = params.get('start') || '';
  return VALID_START_ACTIONS.has(action) ? action : '';
}

export function buildUrlWithoutStartParam(href) {
  const url = new URL(String(href || ''));
  url.searchParams.delete('start');
  return `${url.pathname}${url.search}${url.hash}`;
}

export function shouldCloseOpenerPopupAfterManagerOpen(response, isManagerWindow = false) {
  return !isManagerWindow && Boolean(response?.ok);
}
