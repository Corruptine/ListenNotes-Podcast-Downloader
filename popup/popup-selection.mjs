export function getEpisodeKey(ep) {
  return ep?.episodeId || ep?.uuid || ep?.audioUrl || '';
}

export const DEFAULT_LIST_ORDER = 'normal';
export const REVERSE_LIST_ORDER = 'reverse';

export function normalizeListOrder(order) {
  return order === REVERSE_LIST_ORDER ? REVERSE_LIST_ORDER : DEFAULT_LIST_ORDER;
}

export function countEpisodesWithAudioUrl(episodes) {
  return (Array.isArray(episodes) ? episodes : [])
    .filter((ep) => String(ep?.audioUrl || '').trim()).length;
}

export function countEpisodesWithoutAudioUrl(episodes) {
  return (Array.isArray(episodes) ? episodes : []).length - countEpisodesWithAudioUrl(episodes);
}

export function getAudioResolutionNotice(episodes) {
  const missingCount = countEpisodesWithoutAudioUrl(episodes);
  if (missingCount < 1) return { key: '', params: {} };

  return {
    key: 'selectedMissingAudioFallback',
    params: { count: missingCount },
  };
}

export function getSelectedEpisodes(episodes, selectedEpisodeIds) {
  const selected = selectedEpisodeIds instanceof Set ? selectedEpisodeIds : new Set();
  return (Array.isArray(episodes) ? episodes : [])
    .filter((ep) => selected.has(getEpisodeKey(ep)));
}

export function getOrderedEpisodes(episodes, order = DEFAULT_LIST_ORDER) {
  const normalizedEpisodes = Array.isArray(episodes) ? episodes : [];
  const orderedEpisodes = [...normalizedEpisodes];
  return normalizeListOrder(order) === REVERSE_LIST_ORDER
    ? orderedEpisodes.reverse()
    : orderedEpisodes;
}

export function selectFirstEpisodes(episodes, count) {
  const limit = Math.max(0, Math.floor(Number(count || 0)));
  const selected = new Set();

  for (const ep of (Array.isArray(episodes) ? episodes : []).slice(0, limit)) {
    const key = getEpisodeKey(ep);
    if (key) selected.add(key);
  }

  return selected;
}

export function parseSelectFirstCount(value, maxCount) {
  const count = Number.parseInt(String(value ?? '').trim(), 10);
  const max = Math.max(0, Number(maxCount || 0));

  if (!Number.isFinite(count) || count < 1) {
    return { ok: false, count: 0 };
  }

  return { ok: true, count: Math.min(count, max || count) };
}
