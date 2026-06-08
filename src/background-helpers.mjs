export const CANCELLED_STATUS = 'cancelled';
export const CANCELLING_STATUS = 'cancelling';
export const TERMINAL_STATUSES = new Set(['complete', 'error', 'missing_audio', CANCELLED_STATUS]);
export const ACTIVE_DOWNLOAD_STATUSES = new Set([
  'pending',
  'resolving',
  'fetching_audio',
  'ready_to_save',
  'save_prompt',
  'queued_in_downloads',
  'downloading',
  CANCELLING_STATUS,
]);
export const RETRYABLE_DOWNLOAD_STATUSES = new Set(['error', 'missing_audio', CANCELLED_STATUS]);
export const ZIP_STATUSES = new Set(['idle', 'resolving', 'fetching', 'generating', 'ready', 'error', 'cancelled']);
export const MAX_ZIP_SOURCE_BYTES = 750 * 1024 * 1024;
export const NO_AUDIO_LINKS_RESOLVED = 'No selected episodes could be resolved to audio links. Keep the ListenNotes page open and try again, or use regular download.';
export const MISSING_AUDIO_URL_ERROR = 'Missing cached audio URL. Rescan the ListenNotes page before downloading.';

export function sanitizeFilename(name) {
  const replaced = String(name || '')
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return replaced || 'untitled';
}

export function dirname(absPath) {
  if (!absPath) return '';
  const normalized = String(absPath).replace(/\\/g, '/');
  const index = normalized.lastIndexOf('/');
  return index > 0 ? normalized.slice(0, index) : '';
}

export function isDirectMediaUrl(url) {
  return /\.(m4a|mp3|aac)(\?|$)/i.test(String(url || ''));
}

export function isHttpUrl(url) {
  try {
    const parsed = new URL(String(url || ''));
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function isListenNotesProxyUrl(url) {
  return /audio\.listennotes\.com\/e\/p\/[a-f0-9]{32}\/?/i.test(String(url || ''));
}

export function isSupportedAudioDownloadUrl(url) {
  return isDirectMediaUrl(url) || isListenNotesProxyUrl(url);
}

export function isRssAudioCandidate(ep) {
  return ep?.source === 'rss' && isHttpUrl(ep?.audioUrl);
}

export function isListenNotesAudioPageUrl(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    return /^https?:$/i.test(parsed.protocol)
      && /^(www\.)?listennotes\.com$/i.test(parsed.hostname)
      && parts[0] === 'podcasts'
      && Boolean(parts[1])
      && Boolean(parts[2])
      && (parts.length === 3 || (parts.length === 4 && parts[3] === 'embed'));
  } catch {
    return false;
  }
}

export function getPreferredEpisodeAudioUrl(ep) {
  const audioUrl = String(ep?.audioUrl || '').trim();
  if (!audioUrl) return '';
  if (isRssAudioCandidate(ep)) return audioUrl;
  if (!isSupportedAudioDownloadUrl(audioUrl)) {
    throw new Error('Cached audio URL is not supported');
  }
  return audioUrl;
}

export function getEpisodeAudioPageFallback(ep) {
  const embedPlayerUrl = String(ep?.embedPlayerUrl || '').trim();
  if (isListenNotesAudioPageUrl(embedPlayerUrl)) {
    return { audioUrl: embedPlayerUrl, source: 'embed_page' };
  }

  const episodeId = String(ep?.episodeId || '').trim();
  if (isListenNotesAudioPageUrl(episodeId)) {
    return { audioUrl: episodeId, source: 'episode_page' };
  }

  return null;
}

export async function resolveEpisodeAudioUrl(ep, requestAudioUrl) {
  const preferredUrl = getPreferredEpisodeAudioUrl(ep);
  if (preferredUrl) {
    return { audioUrl: preferredUrl, source: isRssAudioCandidate(ep) ? 'rss' : 'cached' };
  }

  const pageFallback = getEpisodeAudioPageFallback(ep);
  if (pageFallback) return pageFallback;

  if (typeof requestAudioUrl === 'function') {
    const response = await requestAudioUrl(ep);
    const fallbackUrl = String(response?.audioUrl || '').trim();
    if (fallbackUrl) {
      if (!isSupportedAudioDownloadUrl(fallbackUrl)) {
        throw new Error('Fallback audio URL is not supported');
      }
      return { audioUrl: fallbackUrl, source: 'fallback' };
    }
  }

  throw new Error(MISSING_AUDIO_URL_ERROR);
}

export function isMissingAudioUrlError(error) {
  return String(error?.message || error || '').includes(MISSING_AUDIO_URL_ERROR);
}

export function assertAnyResolvedEpisodes(resolved, errors = []) {
  if (Array.isArray(resolved) && resolved.length > 0) return;

  const firstError = Array.isArray(errors) ? errors.find((entry) => entry?.error)?.error : '';
  const suffix = firstError ? ` Last error: ${firstError}` : '';
  throw new Error(`${NO_AUDIO_LINKS_RESOLVED}${suffix}`);
}

export function pickAudioExtension(url) {
  const match = String(url || '').match(/\.([a-z0-9]{2,4})(?=($|\?))/i);
  const ext = match ? match[1].toLowerCase() : 'm4a';
  return ['m4a', 'mp3', 'aac'].includes(ext) ? ext : 'm4a';
}

export function buildZipFilename(episodes) {
  const firstEpisode = Array.isArray(episodes) ? episodes.find((ep) => ep?.channelTitle) : null;
  return `${sanitizeFilename(firstEpisode?.channelTitle || 'ListenNotes')}.zip`;
}

export function buildZipEntries(episodes) {
  const titleCounts = new Map();

  return (Array.isArray(episodes) ? episodes : [])
    .filter((ep) => ep?.finalUrl || ep?.audioUrl)
    .map((ep, index) => {
    const titleBase = sanitizeFilename(ep?.title || ep?.episodeId || `Episode ${index + 1}`);
    const ext = pickAudioExtension(ep?.finalUrl || ep?.audioUrl || '');
    const key = `${titleBase}.${ext}`.toLowerCase();
    const nextCount = (titleCounts.get(key) || 0) + 1;
    titleCounts.set(key, nextCount);

    const duplicateSuffix = nextCount > 1 ? ` (${nextCount})` : '';
    const paddedIndex = String(index + 1).padStart(3, '0');

    return {
      ...ep,
      name: `${paddedIndex} - ${titleBase}${duplicateSuffix}.${ext}`,
      url: ep?.finalUrl || ep?.audioUrl || '',
    };
  });
}

export function assertZipSizeWithinLimit(totalBytes, maxBytes = MAX_ZIP_SOURCE_BYTES) {
  if (Number(totalBytes || 0) > maxBytes) {
    throw new Error(`ZIP source payload is too large. Limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
}

export function estimateKnownContentLength(entries) {
  let knownBytes = 0;
  let unknownCount = 0;

  for (const entry of Array.isArray(entries) ? entries : []) {
    const rawValue = entry?.contentLength;
    const value = rawValue === '' || rawValue == null ? Number.NaN : Number(rawValue);
    if (Number.isFinite(value) && value >= 0) {
      knownBytes += value;
    } else {
      unknownCount += 1;
    }
  }

  return { knownBytes, unknownCount };
}

export function extractAudioUrlFromHtml(html) {
  const text = String(html || '');

  const dataAudio = text.match(/data-audio\s*=\s*["'](https?:[^"']+?)["']/i);
  if (dataAudio?.[1]) return dataAudio[1];

  const proxyUrl = text.match(/https?:\/\/audio\.listennotes\.com\/e\/p\/[a-f0-9]{32}\/?/i);
  if (proxyUrl?.[0]) return proxyUrl[0];

  const patterns = [
    /src\s*=\s*["'](https?:[^"']+?\.(?:m4a|mp3|aac)(?:\?[^"']*)?)["']/i,
    /href\s*=\s*["'](https?:[^"']+?\.(?:m4a|mp3|aac)(?:\?[^"']*)?)["']/i,
    /(https?:\/\/[^"'\s>]+?\.(?:m4a|mp3|aac)(?:\?[^"'\s>]*)?)/i,
    /["']src["']\s*:\s*["'](https?:[^"]+?\.(?:m4a|mp3|aac)[^"]*)["']/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1] || match?.[0]) return match[1] || match[0];
  }

  return '';
}

function normalizeContentType(contentType) {
  return String(contentType || '').split(';')[0].trim().toLowerCase();
}

export function resolveRssEnclosureFinalUrl({
  requestUrl = '',
  responseUrl = '',
  contentType = '',
  htmlText = '',
} = {}) {
  const finalUrl = responseUrl || requestUrl;
  if (isDirectMediaUrl(finalUrl)) return finalUrl;

  const type = normalizeContentType(contentType);
  if (!type || type.startsWith('audio/') || type === 'application/octet-stream') {
    if (isHttpUrl(finalUrl)) return finalUrl;
  }

  if (type === 'text/html' || type.startsWith('text/')) {
    const extractedUrl = extractAudioUrlFromHtml(htmlText);
    if (isSupportedAudioDownloadUrl(extractedUrl)) return extractedUrl;
    throw new Error('RSS enclosure did not resolve to an audio file');
  }

  throw new Error('RSS enclosure did not resolve to an audio file');
}

export function assertResolveDepth(depth, maxDepth = 5) {
  if (depth > maxDepth) {
    throw new Error(`Redirect depth exceeded (${maxDepth})`);
  }
}

export function getKey(ep) {
  return ep?.episodeId || ep?.uuid || ep?.audioUrl || '';
}

export function createInitialState() {
  return {
    queue: [],
    active: 0,
    results: {},
    downloadIdToKey: {},
    startedAt: null,
    defaultDir: '',
    maxResultsSize: 1000,
    zip: {
      status: 'idle',
      current: 0,
      total: 0,
      error: '',
      downloadId: null,
      blobUrl: '',
    },
    task: {
      kind: 'idle',
      status: 'idle',
      current: 0,
      total: 0,
      keys: [],
      bytesLoaded: 0,
      bytesTotal: 0,
      unknownTotal: 0,
      unknownDone: 0,
    },
  };
}

export function buildPersistedState(state) {
  return {
    queue: Array.isArray(state.queue) ? state.queue : [],
    results: state.results && typeof state.results === 'object' ? state.results : {},
    downloadIdToKey: state.downloadIdToKey && typeof state.downloadIdToKey === 'object' ? state.downloadIdToKey : {},
    startedAt: Number.isFinite(state.startedAt) ? state.startedAt : null,
    zip: {
      status: state.zip?.status || 'idle',
      current: Number.isFinite(state.zip?.current) ? state.zip.current : 0,
      total: Number.isFinite(state.zip?.total) ? state.zip.total : 0,
      error: state.zip?.error || '',
      downloadId: state.zip?.downloadId ?? null,
      blobUrl: '',
    },
    task: {
      kind: state.task?.kind || 'idle',
      status: state.task?.status || 'idle',
      current: Number.isFinite(state.task?.current) ? state.task.current : 0,
      total: Number.isFinite(state.task?.total) ? state.task.total : 0,
      keys: Array.isArray(state.task?.keys) ? [...state.task.keys] : [],
      bytesLoaded: Number.isFinite(state.task?.bytesLoaded) ? state.task.bytesLoaded : 0,
      bytesTotal: Number.isFinite(state.task?.bytesTotal) ? state.task.bytesTotal : 0,
      unknownTotal: Number.isFinite(state.task?.unknownTotal) ? state.task.unknownTotal : 0,
      unknownDone: Number.isFinite(state.task?.unknownDone) ? state.task.unknownDone : 0,
    },
  };
}

export function mergePersistedState(state, persisted) {
  if (!persisted || typeof persisted !== 'object') return state;

  state.queue = Array.isArray(persisted.queue) ? [...persisted.queue] : state.queue;
  state.results = persisted.results && typeof persisted.results === 'object' ? { ...persisted.results } : state.results;
  state.downloadIdToKey = persisted.downloadIdToKey && typeof persisted.downloadIdToKey === 'object'
    ? { ...persisted.downloadIdToKey }
    : state.downloadIdToKey;
  state.startedAt = Number.isFinite(persisted.startedAt) ? persisted.startedAt : state.startedAt;
  state.active = 0;
  state.zip = {
    ...state.zip,
    ...(persisted.zip && typeof persisted.zip === 'object' ? persisted.zip : {}),
    blobUrl: '',
  };
  state.task = {
    ...state.task,
    ...(persisted.task && typeof persisted.task === 'object' ? persisted.task : {}),
    keys: Array.isArray(persisted.task?.keys) ? [...persisted.task.keys] : [],
    bytesLoaded: Number.isFinite(persisted.task?.bytesLoaded) ? persisted.task.bytesLoaded : 0,
    bytesTotal: Number.isFinite(persisted.task?.bytesTotal) ? persisted.task.bytesTotal : 0,
    unknownTotal: Number.isFinite(persisted.task?.unknownTotal) ? persisted.task.unknownTotal : 0,
    unknownDone: Number.isFinite(persisted.task?.unknownDone) ? persisted.task.unknownDone : 0,
  };

  normalizeRestoredDownloadState(state);

  return state;
}

export function createIdleTask() {
  return {
    kind: 'idle',
    status: 'idle',
    current: 0,
    total: 0,
    keys: [],
    bytesLoaded: 0,
    bytesTotal: 0,
    unknownTotal: 0,
    unknownDone: 0,
  };
}

export function createDownloadTask(episodes) {
  const keys = (Array.isArray(episodes) ? episodes : [])
    .map((ep) => getKey(ep))
    .filter(Boolean);

  return {
    kind: keys.length ? 'download' : 'idle',
    status: keys.length ? 'running' : 'idle',
    current: 0,
    total: keys.length,
    keys,
    bytesLoaded: 0,
    bytesTotal: 0,
    unknownTotal: 0,
    unknownDone: 0,
  };
}

export function createZipTask(total = 0, status = 'resolving') {
  const normalizedTotal = Math.max(0, Number(total) || 0);
  return {
    kind: normalizedTotal ? 'zip' : 'idle',
    status: normalizedTotal ? status : 'idle',
    current: 0,
    total: normalizedTotal,
    keys: [],
    bytesLoaded: 0,
    bytesTotal: 0,
    unknownTotal: 0,
    unknownDone: 0,
  };
}

export function deriveDownloadTaskCurrent(state) {
  const keys = Array.isArray(state.task?.keys) ? state.task.keys : [];
  return keys.reduce((count, key) => {
    const status = state.results?.[key]?.status;
    return ['complete', 'error', 'missing_audio', 'queued_in_downloads', 'save_prompt', CANCELLING_STATUS, CANCELLED_STATUS].includes(status)
      ? count + 1
      : count;
  }, 0);
}

export function isRetryableDownloadStatus(status) {
  return RETRYABLE_DOWNLOAD_STATUSES.has(status);
}

export function isActiveDownloadStatus(status) {
  return ACTIVE_DOWNLOAD_STATUSES.has(status);
}

export function canRequeueEpisode(result) {
  if (!result) return true;
  return isRetryableDownloadStatus(result.status);
}

export function isCancellableStatus(status) {
  return isActiveDownloadStatus(status) && status !== CANCELLING_STATUS;
}

export function isCancelledResult(result) {
  return result?.status === CANCELLED_STATUS;
}

export function isCancellationRequested(result) {
  return result?.status === CANCELLING_STATUS || result?.status === CANCELLED_STATUS;
}

export function isDownloadCancellationError(error) {
  const message = String(error?.message || error || '');
  return error?.name === 'AbortError'
    || /operation aborted|bodystreambuffer was aborted|user_canceled|cancelled|canceled/i.test(message);
}

function createTimeoutError(timeoutMs) {
  const error = new Error(`Operation timed out after ${timeoutMs / 1000}s`);
  error.name = 'TimeoutError';
  return error;
}

function createAbortError() {
  try {
    return new DOMException('Operation aborted', 'AbortError');
  } catch {
    const error = new Error('Operation aborted');
    error.name = 'AbortError';
    return error;
  }
}

export function createAbortSignalScope({
  signal,
  timeoutMs = 0,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  const controller = new AbortController();
  let timeoutId = null;
  let removeAbortListener = () => {};

  const abortOnce = (reason) => {
    if (controller.signal.aborted) return;
    controller.abort(reason || createAbortError());
  };

  if (signal?.aborted) {
    abortOnce(signal.reason);
  } else if (signal?.addEventListener) {
    const onAbort = () => abortOnce(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  }

  if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) {
    timeoutId = setTimeoutFn(() => abortOnce(createTimeoutError(Number(timeoutMs))), Number(timeoutMs));
  }

  return {
    signal: controller.signal,
    cleanup() {
      removeAbortListener();
      if (timeoutId != null) {
        clearTimeoutFn(timeoutId);
        timeoutId = null;
      }
    },
  };
}

export function assertNotAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason || createAbortError();
}

export function markDownloadCancellationRequested(state, key) {
  const itemKey = String(key || '');
  if (!itemKey || !state?.results?.[itemKey]) return null;

  const result = state.results[itemKey];
  if (isCancellationRequested(result)) return result;

  state.queue = (Array.isArray(state.queue) ? state.queue : [])
    .filter((ep) => getKey(ep) !== itemKey);
  state.results[itemKey] = {
    ...result,
    status: CANCELLING_STATUS,
    error: 'Cancelling',
  };
  return state.results[itemKey];
}

export function applyReadyToSaveResult(state, key, patch = {}) {
  if (isCancellationRequested(state.results?.[key])) return false;

  state.results[key] = {
    ...state.results[key],
    ...patch,
    status: 'ready_to_save',
  };
  return true;
}

export function collectDownloadIdsForCancellation(...results) {
  const ids = [];
  const seen = new Set();

  for (const result of results) {
    const id = result?.downloadId;
    if (id == null || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }

  return ids;
}

export function getStatus(state) {
  const counts = {
    pending: 0,
    getting_url: 0,
    resolving: 0,
    downloading: 0,
    queued_in_downloads: 0,
    complete: 0,
    error: 0,
    missing_audio: 0,
    fetching_audio: 0,
    ready_to_save: 0,
    save_prompt: 0,
    [CANCELLING_STATUS]: 0,
    [CANCELLED_STATUS]: 0,
  };

  for (const key of Object.keys(state.results)) {
    const status = state.results[key]?.status;
    if (Object.prototype.hasOwnProperty.call(counts, status)) {
      counts[status] += 1;
    }
  }

  const task = state.task && typeof state.task === 'object' ? state.task : createIdleTask();
  const taskKind = task.kind || 'idle';
  const taskTotal = Math.max(0, Number(task.total) || 0);
  const taskCurrent = taskKind === 'download'
    ? Math.min(taskTotal, deriveDownloadTaskCurrent(state))
    : Math.min(taskTotal, Math.max(0, Number(task.current) || 0));
  let taskStatus = task.status || 'idle';
  if (taskKind !== 'idle' && taskTotal > 0 && taskCurrent >= taskTotal && !['error', 'ready'].includes(taskStatus)) {
    taskStatus = 'complete';
  }

  const results = {};
  for (const [key, result] of Object.entries(state.results || {})) {
    results[key] = {
      status: result?.status || '',
      error: result?.error || '',
      downloadId: result?.downloadId ?? null,
      blobUrl: result?.blobUrl || '',
      canCancel: isCancellableStatus(result?.status),
      isCancelling: result?.status === CANCELLING_STATUS,
    };
  }

  return {
    total: Object.keys(state.results).length,
    inQueue: state.queue.length,
    active: state.active,
    counts,
    startedAt: state.startedAt,
    defaultDir: state.defaultDir,
    zipStatus: state.zip?.status || 'idle',
    zipCurrent: state.zip?.current || 0,
    zipTotal: state.zip?.total || 0,
    zipError: state.zip?.error || '',
    results,
    taskKind,
    taskCurrent,
    taskTotal,
    taskStatus,
    taskBytesLoaded: Math.max(0, Number(task.bytesLoaded) || 0),
    taskBytesTotal: Math.max(0, Number(task.bytesTotal) || 0),
    taskUnknownTotal: Math.max(0, Number(task.unknownTotal) || 0),
    taskUnknownDone: Math.max(0, Number(task.unknownDone) || 0),
    taskCanCancel: taskKind !== 'idle' && ['running', 'resolving', 'fetching', 'generating', 'saving'].includes(taskStatus),
  };
}

function removeDownloadMappingsForKey(state, key) {
  for (const [downloadId, mappedKey] of Object.entries(state.downloadIdToKey || {})) {
    if (mappedKey === key) delete state.downloadIdToKey[downloadId];
  }
}

function hasQueuedEpisode(state, key) {
  return (Array.isArray(state.queue) ? state.queue : []).some((ep) => getKey(ep) === key);
}

function hasTrackedDownloadId(state, key, result) {
  const downloadId = result?.downloadId;
  return downloadId != null && state.downloadIdToKey?.[downloadId] === key;
}

function normalizeRestoredDownloadState(state) {
  for (const [key, result] of Object.entries(state.results || {})) {
    if (!isActiveDownloadStatus(result?.status)) continue;
    if (hasQueuedEpisode(state, key) || hasTrackedDownloadId(state, key, result)) continue;

    removeDownloadMappingsForKey(state, key);
    const { downloadId: _downloadId, taskId: _taskId, ...rest } = result;
    state.results[key] = {
      ...rest,
      status: CANCELLED_STATUS,
      error: 'Cancelled',
      blobUrl: '',
    };
  }

  if (state.task?.kind === 'download' && state.queue.length === 0) {
    state.task = {
      ...state.task,
      current: deriveDownloadTaskCurrent(state),
      status: 'complete',
    };
  }
}

function buildRequeuedResult() {
  return {
    status: 'pending',
    error: '',
    blobUrl: '',
  };
}

function mergeDownloadTask(existingTask, added) {
  if (existingTask?.kind !== 'download' || existingTask?.status !== 'running') {
    return createDownloadTask(added);
  }

  const keys = [
    ...(Array.isArray(existingTask.keys) ? existingTask.keys : []),
  ];
  const seen = new Set(keys);

  for (const ep of added) {
    const key = getKey(ep);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }

  return {
    ...existingTask,
    status: 'running',
    keys,
    total: keys.length,
  };
}

export function enqueueEpisodes(state, episodes, tabId) {
  const seenInRequest = new Set();
  const added = [];

  for (const ep of Array.isArray(episodes) ? episodes : []) {
    const key = getKey(ep);
    if (!key || seenInRequest.has(key)) continue;

    const existingResult = state.results[key];
    if (!canRequeueEpisode(existingResult)) continue;

    seenInRequest.add(key);
    removeDownloadMappingsForKey(state, key);
    state.results[key] = buildRequeuedResult();
    added.push({ ...ep, tabId });
  }

  state.queue.push(...added);
  if (added.length > 0 && !state.startedAt) state.startedAt = Date.now();
  if (added.length > 0) state.task = mergeDownloadTask(state.task, added);
  return added;
}

export function applyDownloadDelta(state, delta) {
  const key = state.downloadIdToKey?.[delta?.id];
  if (!key || !state.results[key]) return false;
  const currentResult = state.results[key];
  const isUserCancelled = delta.error?.current === 'USER_CANCELED';

  if (delta.state?.current === 'complete') {
    state.results[key] = isCancellationRequested(currentResult)
      ? { ...currentResult, status: CANCELLED_STATUS, error: 'Cancelled', blobUrl: '' }
      : { ...currentResult, status: 'complete', blobUrl: '' };
    delete state.downloadIdToKey[delta.id];
    return true;
  }

  if (delta.state?.current === 'interrupted') {
    const error = delta.error?.current || 'Download interrupted';
    state.results[key] = (isCancellationRequested(currentResult) || isUserCancelled)
      ? { ...currentResult, status: CANCELLED_STATUS, error: 'Cancelled', blobUrl: '' }
      : { ...currentResult, status: 'error', error, blobUrl: '' };
    delete state.downloadIdToKey[delta.id];
    return true;
  }

  return false;
}

export function cleanupResults(state) {
  const keys = Object.keys(state.results);
  if (keys.length <= state.maxResultsSize) return 0;

  const terminalKeys = keys.filter((key) => TERMINAL_STATUSES.has(state.results[key]?.status));
  const removeCount = Math.min(terminalKeys.length, keys.length - state.maxResultsSize + 100);

  for (const key of terminalKeys.slice(0, removeCount)) {
    const downloadId = state.results[key]?.downloadId;
    if (downloadId != null) delete state.downloadIdToKey[downloadId];
    delete state.results[key];
  }

  return removeCount;
}
