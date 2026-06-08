import {
  applyDownloadDelta,
  applyReadyToSaveResult,
  assertAnyResolvedEpisodes,
  assertNotAborted,
  assertZipSizeWithinLimit,
  assertResolveDepth,
  buildPersistedState,
  CANCELLED_STATUS,
  collectDownloadIdsForCancellation,
  buildZipEntries,
  buildZipFilename,
  cleanupResults,
  createAbortSignalScope,
  createInitialState,
  createIdleTask,
  deriveDownloadTaskCurrent,
  dirname,
  enqueueEpisodes,
  estimateKnownContentLength,
  extractAudioUrlFromHtml,
  getKey,
  getStatus as buildStatus,
  isDirectMediaUrl,
  isCancellationRequested,
  isDownloadCancellationError,
  isMissingAudioUrlError,
  isSupportedAudioDownloadUrl,
  markDownloadCancellationRequested,
  MAX_ZIP_SOURCE_BYTES,
  mergePersistedState,
  pickAudioExtension,
  resolveRssEnclosureFinalUrl,
  resolveEpisodeAudioUrl,
  sanitizeFilename,
} from './background-helpers.mjs';
import {
  assertZipBuildResponse,
  normalizeZipError,
  ZIP_BUILDER_CONNECTION_CLOSED,
} from './zip-errors.mjs';

const DEBUG = false;
const SESSION_STATE_KEY = 'listenNotesDownloaderState';
const DOWNLOAD_NOT_STARTED_CODE = 'DOWNLOAD_NOT_STARTED';
const STALE_TASK_CODE = 'STALE_TASK';
const AUDIO_PROGRESS_NOTIFY_INTERVAL_MS = 250;
const state = createInitialState();
let managerWindowId = null;
let taskGeneration = 0;
let activeZipTaskId = null;
let lastAudioProgressNotificationAt = 0;
let pendingAudioProgressTimerId = null;
const activeDownloadControllersByKey = new Map();
const activeDownloadControllersByTaskId = new Map();

function debug(tag, message, extra) {
  if (!DEBUG) return;
  if (extra === undefined) {
    console.log(`[${tag}] ${message}`);
  } else {
    console.log(`[${tag}] ${message}`, extra);
  }
}

function logError(tag, message, error) {
  console.error(`[${tag}] ${message}`, error);
}

function logWarn(tag, message) {
  console.warn(`[${tag}] ${message}`);
}

function isStaleGeneration(generation) {
  return generation !== taskGeneration;
}

function createStaleTaskError() {
  const error = new Error('Cancelled');
  error.code = STALE_TASK_CODE;
  return error;
}

function isStaleTaskError(error) {
  return error?.code === STALE_TASK_CODE;
}

function registerDownloadController(key, taskId, controller) {
  if (key) activeDownloadControllersByKey.set(key, controller);
  if (taskId) activeDownloadControllersByTaskId.set(taskId, controller);
}

function unregisterDownloadController(key, taskId, controller) {
  if (key && activeDownloadControllersByKey.get(key) === controller) {
    activeDownloadControllersByKey.delete(key);
  }
  if (taskId && activeDownloadControllersByTaskId.get(taskId) === controller) {
    activeDownloadControllersByTaskId.delete(taskId);
  }
}

function abortDownloadController(key, taskId) {
  const controllers = new Set([
    key ? activeDownloadControllersByKey.get(key) : null,
    taskId ? activeDownloadControllersByTaskId.get(taskId) : null,
  ].filter(Boolean));

  for (const controller of controllers) {
    if (!controller.signal.aborted) controller.abort();
  }

  return controllers.size > 0;
}

function getStatus() {
  return buildStatus(state);
}

function sendProgress(type = 'BG_PROGRESS', extra = {}) {
  try {
    Promise.resolve(chrome.runtime.sendMessage({ type, state: getStatus(), ...extra }))
      .catch((e) => {
        debug('Progress', `No listener for ${type}: ${e.message}`);
      });
  } catch (e) {
    debug('Progress', `No listener for ${type}: ${e.message}`);
  }
}

function sendAudioProgressSoon() {
  const now = Date.now();
  const elapsed = now - lastAudioProgressNotificationAt;

  if (elapsed >= AUDIO_PROGRESS_NOTIFY_INTERVAL_MS) {
    lastAudioProgressNotificationAt = now;
    sendProgress('BG_PROGRESS', { progressOnly: true });
    return;
  }

  if (pendingAudioProgressTimerId != null) return;

  pendingAudioProgressTimerId = setTimeout(() => {
    pendingAudioProgressTimerId = null;
    lastAudioProgressNotificationAt = Date.now();
    sendProgress('BG_PROGRESS', { progressOnly: true });
  }, AUDIO_PROGRESS_NOTIFY_INTERVAL_MS - elapsed);
}

function clearAudioProgressNotification() {
  if (pendingAudioProgressTimerId == null) return;
  clearTimeout(pendingAudioProgressTimerId);
  pendingAudioProgressTimerId = null;
}

function persistState() {
  try {
    if (!chrome.storage?.session?.set) return;
    chrome.storage.session.set({
      [SESSION_STATE_KEY]: buildPersistedState(state),
    }).catch((e) => {
      debug('PersistState', `Failed to persist state: ${e.message}`);
    });
  } catch (e) {
    debug('PersistState', `Failed to persist state: ${e.message}`);
  }
}

function revokeZipBlobUrl(blobUrl) {
  if (!blobUrl) return;

  try {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_REVOKE_ZIP_URL',
      blobUrl,
    }).catch(() => {});
  } catch {}
}

function updateZip(patch) {
  state.zip = { ...state.zip, ...patch };
  const total = Number.isFinite(state.zip.total) ? state.zip.total : 0;
  state.task = total > 0
    ? {
      ...state.task,
      kind: 'zip',
      status: state.zip.status || 'idle',
      current: Number.isFinite(state.zip.current) ? state.zip.current : 0,
      total,
      keys: [],
    }
    : createIdleTask();
  persistState();
  sendProgress('BG_ZIP_PROGRESS');
}

function resetZip() {
  revokeZipBlobUrl(state.zip?.blobUrl);
  state.zip = {
    status: 'idle',
    current: 0,
    total: 0,
    error: '',
    downloadId: null,
    blobUrl: '',
  };
  if (state.task?.kind === 'zip') state.task = createIdleTask();
  persistState();
}

function resetStateFields() {
  state.queue = [];
  state.active = 0;
  state.results = {};
  state.downloadIdToKey = {};
  state.startedAt = null;
  state.task = createIdleTask();
  state.zip = {
    status: 'idle',
    current: 0,
    total: 0,
    error: '',
    downloadId: null,
    blobUrl: '',
  };
}

function getResetTargets() {
  const fetchTaskIds = new Set();
  const downloadIds = new Map();
  const blobUrls = new Set();
  const addDownloadId = (downloadId) => {
    if (downloadId == null) return;
    const key = String(downloadId);
    if (!key) return;
    const numericId = Number(downloadId);
    downloadIds.set(key, Number.isFinite(numericId) ? numericId : downloadId);
  };

  for (const result of Object.values(state.results || {})) {
    if (result?.taskId) fetchTaskIds.add(result.taskId);
    addDownloadId(result?.downloadId);
    if (result?.blobUrl) blobUrls.add(result.blobUrl);
  }

  for (const downloadId of Object.keys(state.downloadIdToKey || {})) {
    addDownloadId(downloadId);
  }

  addDownloadId(state.zip?.downloadId);
  if (state.zip?.blobUrl) blobUrls.add(state.zip.blobUrl);

  return {
    fetchTaskIds: [...fetchTaskIds],
    zipTaskId: activeZipTaskId,
    downloadIds: [...downloadIds.values()],
    blobUrls: [...blobUrls],
  };
}

async function resetBackgroundState() {
  const targets = getResetTargets();
  taskGeneration += 1;
  activeZipTaskId = null;
  clearAudioProgressNotification();
  for (const controller of new Set([
    ...activeDownloadControllersByKey.values(),
    ...activeDownloadControllersByTaskId.values(),
  ])) {
    if (!controller.signal.aborted) controller.abort();
  }
  activeDownloadControllersByKey.clear();
  activeDownloadControllersByTaskId.clear();
  resetStateFields();
  persistState();

  const cancellations = [
    ...targets.fetchTaskIds.map((taskId) => chrome.runtime.sendMessage({
      type: 'OFFSCREEN_CANCEL_FETCH',
      taskId,
    }).catch(() => {})),
    ...(targets.zipTaskId ? [
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_CANCEL_ZIP',
        taskId: targets.zipTaskId,
      }).catch(() => {}),
    ] : []),
    ...targets.downloadIds.map((downloadId) => chrome.downloads.cancel(downloadId).catch(() => {})),
    ...targets.blobUrls.map((blobUrl) => chrome.runtime.sendMessage({
      type: 'OFFSCREEN_REVOKE_ZIP_URL',
      blobUrl,
    }).catch(() => {})),
  ];

  await Promise.allSettled(cancellations);
  sendProgress();
}

function isZipBusy() {
  return ['resolving', 'fetching', 'generating'].includes(state.zip?.status)
    || (state.zip?.status === 'ready' && state.zip?.downloadId == null && state.zip?.total > 0);
}

function isDownloadBusy() {
  return state.active > 0 || state.queue.length > 0;
}

function updateTaskProgress(patch = {}) {
  state.task = { ...state.task, ...patch };
  persistState();
  sendProgress();
}

function setDefaultDirFromFilename(filename) {
  const dir = dirname(filename);
  if (!dir || dir === state.defaultDir) return;

  state.defaultDir = dir;
  chrome.storage.local.set({ defaultDir: dir }).catch((e) => {
    logError('SetDefaultDir', 'Failed to save default download directory', e);
  });
  sendProgress();
}

function normalizeManagerAction(action) {
  const value = String(action || '');
  if (value === 'download' || value === 'zip') return value;
  throw new Error('Unsupported manager window action');
}

function buildManagerWindowUrl(action) {
  const params = new URLSearchParams({
    mode: 'window',
    start: normalizeManagerAction(action),
  });
  return chrome.runtime.getURL(`popup/popup.html?${params.toString()}`);
}

async function focusExistingManagerWindow(action) {
  if (managerWindowId == null) return false;

  try {
    await chrome.windows.get(managerWindowId);
    await chrome.windows.update(managerWindowId, { focused: true });
    chrome.runtime.sendMessage({
      type: 'POPUP_START_ACTION',
      action,
    }).catch(() => {});
    return true;
  } catch {
    managerWindowId = null;
    return false;
  }
}

async function openManagerWindow(action) {
  const normalizedAction = normalizeManagerAction(action);
  if (await focusExistingManagerWindow(normalizedAction)) {
    return { ok: true, reused: true, windowId: managerWindowId };
  }

  const createdWindow = await chrome.windows.create({
    url: buildManagerWindowUrl(normalizedAction),
    type: 'popup',
    width: 460,
    height: 760,
    focused: true,
  });

  managerWindowId = createdWindow?.id ?? null;
  return { ok: true, reused: false, windowId: managerWindowId };
}

(async () => {
  try {
    const [localState, sessionState] = await Promise.all([
      chrome.storage.local.get(['defaultDir']),
      chrome.storage?.session?.get ? chrome.storage.session.get([SESSION_STATE_KEY]) : Promise.resolve({}),
    ]);
    const { defaultDir = '' } = localState;
    state.defaultDir = defaultDir || '';
    mergePersistedState(state, sessionState?.[SESSION_STATE_KEY]);
    if (state.queue.length > 0) {
      pumpQueue();
    }
  } catch (e) {
    logWarn('Init', `Failed to load persisted state: ${e.message}`);
  }
})();

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const {
    signal,
    ...fetchOptions
  } = options;
  const abortScope = createAbortSignalScope({ signal, timeoutMs });

  try {
    return await fetch(url, { ...fetchOptions, signal: abortScope.signal });
  } finally {
    abortScope.cleanup();
  }
}

function assertHttpUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ''));
  } catch {
    throw new Error('RSS URL is invalid');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('RSS URL must use http or https');
  }

  return parsed.href;
}

async function fetchRssText(url, options = {}) {
  const { signal } = options;
  const rssUrl = assertHttpUrl(url);
  const response = await fetchWithTimeout(rssUrl, {
    credentials: 'omit',
    redirect: 'follow',
    signal,
  }, 15000);

  if (!response.ok) {
    throw new Error(`RSS fetch failed with HTTP ${response.status}`);
  }

  assertNotAborted(signal);
  return response.text();
}

async function resolveRssFinalUrl(audioUrl, options = {}) {
  const { signal } = options;
  const response = await fetchWithTimeout(audioUrl, {
    credentials: 'omit',
    redirect: 'follow',
    signal,
  }, 15000);

  if (!response.ok) {
    throw new Error(`RSS enclosure fetch failed with HTTP ${response.status}`);
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const normalizedContentType = String(contentType).split(';')[0].trim().toLowerCase();
  const htmlText = normalizedContentType === 'text/html' || normalizedContentType.startsWith('text/')
    ? await response.text()
    : '';

  assertNotAborted(signal);
  return resolveRssEnclosureFinalUrl({
    requestUrl: audioUrl,
    responseUrl: response.url || '',
    contentType,
    htmlText,
  });
}

async function resolveFinalUrl(audioPageUrl, depth = 0, source = '', options = {}) {
  const { signal } = options;
  assertResolveDepth(depth);
  assertNotAborted(signal);
  debug('ResolveURL', `Resolving depth ${depth}: ${audioPageUrl}`);

  if (isSupportedAudioDownloadUrl(audioPageUrl)) return audioPageUrl;
  if (source === 'rss') return resolveRssFinalUrl(audioPageUrl, { signal });

  const response = await fetchWithTimeout(audioPageUrl, {
    credentials: 'omit',
    redirect: 'follow',
    signal,
  }, 15000);

  if (response.url && isDirectMediaUrl(response.url)) return response.url;

  const html = await response.text();
  assertNotAborted(signal);
  const extractedUrl = extractAudioUrlFromHtml(html);
  if (!extractedUrl) {
    throw new Error('Unable to find a direct audio URL in the page');
  }

  if (isSupportedAudioDownloadUrl(extractedUrl)) return extractedUrl;

  throw new Error('Resolved URL is not a supported audio file');
}

function withTimeout(asyncFn, timeoutMs) {
  return (...args) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`Operation timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
    });

    return Promise.race([asyncFn(...args), timeout]).finally(() => clearTimeout(timer));
  };
}

function createDownloadNotStartedError(error) {
  const detail = error?.message || 'Download was not started';
  const downloadError = new Error(detail);
  downloadError.code = DOWNLOAD_NOT_STARTED_CODE;
  return downloadError;
}

function isDownloadNotStartedError(error) {
  return error?.code === DOWNLOAD_NOT_STARTED_CODE;
}

async function startBrowserDownload(options) {
  try {
    const downloadId = await chrome.downloads.download(options);
    if (!Number.isInteger(downloadId)) {
      throw new Error('Download was not started');
    }
    return downloadId;
  } catch (error) {
    throw createDownloadNotStartedError(error);
  }
}

async function cancelBrowserDownload(downloadId) {
  if (!Number.isInteger(downloadId)) return;
  try {
    await chrome.downloads.cancel(downloadId);
  } catch {}
  delete state.downloadIdToKey[downloadId];
}

function markDownloadItemCancelled(key, patch = {}) {
  const {
    downloadId: _downloadId,
    taskId: _taskId,
    ...currentResult
  } = state.results[key] || {};
  state.results[key] = {
    ...currentResult,
    ...patch,
    status: CANCELLED_STATUS,
    error: 'Cancelled',
    blobUrl: '',
  };
}

async function resolveEpisodeDownload(ep, statusCallback = () => {}, options = {}) {
  const { signal } = options;
  const key = getKey(ep);
  const titleBase = sanitizeFilename(`${ep.channelTitle || 'ListenNotes'} - ${ep.title || ep.episodeId}`);
  assertNotAborted(signal);
  const { audioUrl, source } = await resolveEpisodeAudioUrl(ep);

  statusCallback('resolving');
  const finalUrl = await resolveFinalUrl(audioUrl, 0, source, { signal });
  assertNotAborted(signal);
  const filename = `${titleBase}.${pickAudioExtension(finalUrl)}`;

  return { ...ep, key, finalUrl, filename };
}

async function processOneEpisode(ep, generation = taskGeneration) {
  const key = getKey(ep);
  const taskId = `audio:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const controller = new AbortController();
  registerDownloadController(key, taskId, controller);

  try {
    if (isStaleGeneration(generation)) throw createStaleTaskError();
    state.results[key] = {
      ...state.results[key],
      taskId,
    };
    persistState();
    const resolved = await resolveEpisodeDownload(ep, (status) => {
      if (isStaleGeneration(generation)) return;
      if (isCancellationRequested(state.results[key])) return;
      state.results[key] = { ...state.results[key], status };
      persistState();
    }, { signal: controller.signal });
    assertNotAborted(controller.signal);
    if (isStaleGeneration(generation)) throw createStaleTaskError();
    if (isCancellationRequested(state.results[key])) {
      markDownloadItemCancelled(key);
      persistState();
      return { ok: false, error: 'Cancelled' };
    }

    state.results[key] = {
      ...state.results[key],
      status: 'fetching_audio',
      finalUrl: resolved.finalUrl,
      filename: resolved.filename,
      taskId,
    };
    persistState();

    const entry = {
      title: resolved.title || resolved.episodeId,
      name: resolved.filename,
      url: resolved.finalUrl,
    };
    const contentLength = await estimateEntryContentLength(entry, { signal: controller.signal });
    assertNotAborted(controller.signal);
    if (isStaleGeneration(generation)) throw createStaleTaskError();
    if (isCancellationRequested(state.results[key])) {
      markDownloadItemCancelled(key);
      persistState();
      return { ok: false, error: 'Cancelled' };
    }
    applyEntryEstimate(contentLength);
    const blobResponse = await requestAudioBlob(entry, key, taskId, { signal: controller.signal });
    if (isStaleGeneration(generation)) {
      if (blobResponse?.blobUrl) revokeZipBlobUrl(blobResponse.blobUrl);
      throw createStaleTaskError();
    }
    assertNotAborted(controller.signal);
    if (!blobResponse?.ok) {
      throw new Error(blobResponse?.error || 'Failed to fetch audio before saving');
    }

    if (isCancellationRequested(state.results[key])) {
      if (blobResponse.blobUrl) revokeZipBlobUrl(blobResponse.blobUrl);
      markDownloadItemCancelled(key);
      persistState();
      return { ok: false, error: 'Cancelled' };
    }

    const readyToSave = applyReadyToSaveResult(state, key, {
      blobUrl: blobResponse.blobUrl,
      totalBytes: blobResponse.totalBytes || contentLength || 0,
    });
    if (!readyToSave) {
      if (blobResponse.blobUrl) revokeZipBlobUrl(blobResponse.blobUrl);
      persistState();
      return { ok: false, error: 'Cancelled' };
    }
    if (!(Number.isFinite(contentLength) && contentLength >= 0)) {
      updateTaskProgress({ unknownDone: (state.task.unknownDone || 0) + 1 });
    }
    persistState();

    if (isCancellationRequested(state.results[key])) {
      if (blobResponse.blobUrl) revokeZipBlobUrl(blobResponse.blobUrl);
      markDownloadItemCancelled(key);
      persistState();
      return { ok: false, error: 'Cancelled' };
    }

    let downloadId;
    try {
      if (isStaleGeneration(generation)) {
        revokeZipBlobUrl(blobResponse.blobUrl);
        throw createStaleTaskError();
      }
      assertNotAborted(controller.signal);
      downloadId = await startBrowserDownload({
        url: blobResponse.blobUrl,
        filename: resolved.filename,
        saveAs: true,
        conflictAction: 'uniquify',
      });
      state.downloadIdToKey[downloadId] = key;
      persistState();
    } catch (error) {
      if (isDownloadNotStartedError(error)) {
        revokeZipBlobUrl(blobResponse.blobUrl);
        markDownloadItemCancelled(key, {
          finalUrl: resolved.finalUrl,
          filename: resolved.filename,
        });
        persistState();
        return { ok: false, error: 'Cancelled' };
      }
      throw error;
    }

    if (isStaleGeneration(generation)) {
      await cancelBrowserDownload(downloadId);
      revokeZipBlobUrl(blobResponse.blobUrl);
      throw createStaleTaskError();
    }

    if (isCancellationRequested(state.results[key])) {
      await cancelBrowserDownload(downloadId);
      revokeZipBlobUrl(blobResponse.blobUrl);
      markDownloadItemCancelled(key, {
        finalUrl: resolved.finalUrl,
        filename: resolved.filename,
      });
      persistState();
      return { ok: false, error: 'Cancelled' };
    }

    state.results[key] = {
      ...state.results[key],
      status: 'save_prompt',
      downloadId,
      finalUrl: resolved.finalUrl,
      filename: resolved.filename,
      blobUrl: blobResponse.blobUrl,
    };
    cleanupResults(state);
    persistState();
    return { ok: true };
  } catch (error) {
    if (isStaleTaskError(error) || isStaleGeneration(generation)) {
      return { ok: false, error: 'Cancelled' };
    }
    if (isCancellationRequested(state.results[key]) || isDownloadCancellationError(error)) {
      if (state.results[key]?.blobUrl) revokeZipBlobUrl(state.results[key].blobUrl);
      markDownloadItemCancelled(key);
      persistState();
      return { ok: false, error: 'Cancelled' };
    }
    logError('ProcessOne', `[${ep.title || ep.episodeId}] failed`, error);
    if (state.results[key]?.blobUrl) revokeZipBlobUrl(state.results[key].blobUrl);
    const {
      downloadId: _downloadId,
      taskId: _taskId,
      ...currentResult
    } = state.results[key] || {};
    state.results[key] = {
      ...currentResult,
      status: isMissingAudioUrlError(error) ? 'missing_audio' : 'error',
      error: error.message,
      blobUrl: '',
    };
    persistState();
    return { ok: false, error: error.message };
  } finally {
    unregisterDownloadController(key, taskId, controller);
  }
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen/offscreen.html');

  if (!chrome.offscreen?.createDocument) {
    throw new Error('This Chrome version does not support offscreen ZIP generation');
  }

  if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) return;

  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });
    if (contexts.length > 0) return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen/offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Create a ZIP Blob for selected ListenNotes podcast downloads.',
  });
}

async function requestZipBuild(entries, errors, filename, taskId = 'zip') {
  await ensureOffscreenDocument();

  let response;
  try {
    response = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_BUILD_ZIP',
      entries,
      errors,
      filename,
      maxBytes: MAX_ZIP_SOURCE_BYTES,
      taskId,
    });
  } catch (error) {
    throw new Error(normalizeZipError(error, ZIP_BUILDER_CONNECTION_CLOSED));
  }

  return assertZipBuildResponse(response);
}

function createAbortRejection(signal, onAbort = () => {}) {
  if (!signal) return null;
  let removeAbortListener = () => {};
  const promise = new Promise((_, reject) => {
    const rejectAbort = () => {
      onAbort();
      reject(signal.reason || new Error('Operation aborted'));
    };

    if (signal.aborted) {
      rejectAbort();
      return;
    }

    signal.addEventListener('abort', rejectAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', rejectAbort);
  });

  return {
    promise,
    cleanup: removeAbortListener,
  };
}

async function requestAudioBlob(entry, key, taskId, options = {}) {
  const { signal } = options;
  assertNotAborted(signal);
  await ensureOffscreenDocument();
  assertNotAborted(signal);

  const request = chrome.runtime.sendMessage({
    type: 'OFFSCREEN_FETCH_AUDIO',
    entry,
    key,
    taskId,
  });
  const abortRejection = createAbortRejection(signal, () => {
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_CANCEL_FETCH',
      taskId,
    }).catch(() => {});
  });

  if (!abortRejection) return request;

  try {
    return await Promise.race([request, abortRejection.promise]);
  } finally {
    abortRejection.cleanup();
  }
}

async function estimateEntryContentLength(entry, options = {}) {
  const { signal } = options;
  try {
    assertNotAborted(signal);
    const response = await fetchWithTimeout(entry.url, {
      method: 'HEAD',
      credentials: 'omit',
      redirect: 'follow',
      signal,
    }, 10000);
    assertNotAborted(signal);
    const value = Number(response.headers.get('content-length'));
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch (error) {
    if (isDownloadCancellationError(error)) throw error;
    debug('Preflight', `Unable to estimate ${entry.name}: ${error.message}`);
    return null;
  }
}

function applyEntryEstimate(contentLength) {
  if (Number.isFinite(contentLength) && contentLength >= 0) {
    updateTaskProgress({ bytesTotal: (state.task.bytesTotal || 0) + contentLength });
  } else {
    updateTaskProgress({ unknownTotal: (state.task.unknownTotal || 0) + 1 });
  }
}

async function estimateZipEntries(entries) {
  const estimated = [];

  for (const entry of entries) {
    let contentLength = null;

    try {
      const response = await fetchWithTimeout(entry.url, {
        method: 'HEAD',
        credentials: 'omit',
        redirect: 'follow',
      }, 10000);
      const value = Number(response.headers.get('content-length'));
      if (Number.isFinite(value) && value >= 0) contentLength = value;
    } catch (error) {
      debug('ZipPreflight', `Unable to estimate ${entry.name}: ${error.message}`);
    }

    estimated.push({ ...entry, contentLength });
  }

  const estimate = estimateKnownContentLength(estimated);
  assertZipSizeWithinLimit(estimate.knownBytes);
  return estimated;
}

async function queueZipDownloads(episodes, tabId, generation = taskGeneration) {
  if (isZipBusy()) {
    throw new Error('A ZIP download is already running');
  }
  if (isDownloadBusy()) {
    throw new Error('A regular download task is already running');
  }

  const items = Array.isArray(episodes) ? episodes : [];
  if (!items.length) {
    throw new Error('No episodes available for ZIP download');
  }

  const zipTaskId = `zip:${generation}`;
  activeZipTaskId = zipTaskId;
  resetZip();
  if (isStaleGeneration(generation)) throw createStaleTaskError();
  updateZip({ status: 'resolving', current: 0, total: items.length, error: '' });

  const resolved = [];
  const errors = [];

  for (const [index, ep] of items.entries()) {
    if (isStaleGeneration(generation)) throw createStaleTaskError();
    if (state.zip.status === 'cancelled') {
      throw new Error('Cancelled');
    }
    try {
      const item = await withTimeout(resolveEpisodeDownload, 60000)({ ...ep, tabId });
      resolved.push(item);
    } catch (error) {
      logError('ZipResolve', `[${ep.title || ep.episodeId}] failed`, error);
      errors.push({
        title: ep.title || ep.episodeId || `Episode ${index + 1}`,
        error: error.message,
      });
    } finally {
      if (!isStaleGeneration(generation)) {
        updateZip({ current: index + 1, total: items.length });
      }
    }
  }

  if (isStaleGeneration(generation)) throw createStaleTaskError();
  assertAnyResolvedEpisodes(resolved, errors);
  if (state.zip.status === 'cancelled') throw new Error('Cancelled');

  const entries = await estimateZipEntries(buildZipEntries(resolved));
  if (isStaleGeneration(generation)) throw createStaleTaskError();
  const knownBytes = entries.reduce((total, entry) => (
    Number.isFinite(Number(entry.contentLength)) ? total + Number(entry.contentLength) : total
  ), 0);
  const unknownTotal = entries.filter((entry) => !Number.isFinite(Number(entry.contentLength))).length;
  state.task = {
    ...state.task,
    bytesLoaded: 0,
    bytesTotal: knownBytes,
    unknownTotal,
    unknownDone: 0,
  };
  updateZip({ status: 'fetching', current: 0, total: entries.length, error: '' });

  const zipResponse = await requestZipBuild(entries, errors, buildZipFilename(resolved), zipTaskId);
  if (isStaleGeneration(generation)) {
    if (zipResponse?.blobUrl) revokeZipBlobUrl(zipResponse.blobUrl);
    throw createStaleTaskError();
  }
  if (state.zip.status === 'cancelled') throw new Error('Cancelled');
  updateZip({ status: 'ready', current: entries.length, total: entries.length, error: '' });

  let downloadId;
  try {
    if (isStaleGeneration(generation)) {
      revokeZipBlobUrl(zipResponse.blobUrl);
      throw createStaleTaskError();
    }
    downloadId = await startBrowserDownload({
      url: zipResponse.blobUrl,
      filename: zipResponse.filename,
      saveAs: true,
      conflictAction: 'uniquify',
    });
  } catch (error) {
    if (isDownloadNotStartedError(error)) {
      revokeZipBlobUrl(zipResponse.blobUrl);
      updateZip({
        status: 'cancelled',
        error: 'Cancelled',
        downloadId: null,
        blobUrl: '',
      });
      throw new Error('Cancelled');
    }
    throw error;
  }

  if (isStaleGeneration(generation)) {
    try {
      if (Number.isInteger(downloadId)) await chrome.downloads.cancel(downloadId);
    } catch {}
    revokeZipBlobUrl(zipResponse.blobUrl);
    throw createStaleTaskError();
  }

  updateZip({
    status: 'ready',
    current: entries.length,
    total: entries.length,
    error: '',
    downloadId,
    blobUrl: zipResponse.blobUrl,
  });

  if (activeZipTaskId === zipTaskId) activeZipTaskId = null;
  return {
    ok: true,
    filename: zipResponse.filename,
    resolved: resolved.length,
    failed: errors.length + Number(zipResponse.failed || 0),
    downloadId,
  };
}

async function pumpQueue(generation = taskGeneration) {
  if (state.active > 0) return;

  state.active = 1;
  persistState();
  sendProgress();

  try {
    while (state.queue.length > 0 && !isStaleGeneration(generation)) {
      const ep = state.queue.shift();
      const key = getKey(ep);
      persistState();

      await processOneEpisode(ep, generation).catch((error) => {
        if (isStaleTaskError(error) || isStaleGeneration(generation)) return;
        logError('PumpQueue', `[${ep.title || ep.episodeId}] failed`, error);
        const {
          taskId: _taskId,
          ...currentResult
        } = state.results[key] || {};
        state.results[key] = {
          ...currentResult,
          status: 'error',
          error: error.message,
          blobUrl: '',
        };
        persistState();
      });

      sendProgress();
    }
  } finally {
    if (isStaleGeneration(generation)) return;
    state.active = 0;
    if (state.task?.kind === 'download') {
      state.task = {
        ...state.task,
        current: deriveDownloadTaskCurrent(state),
        status: 'complete',
      };
    }
    persistState();
    sendProgress();
  }
}

async function cancelDownloadItem(key) {
  const itemKey = String(key || '');
  if (!itemKey) {
    throw new Error('Download item was not found');
  }

  if (!state.results[itemKey]) {
    console.info('[ListenNotes Downloader] background cancel item missing', { key: itemKey });
    return { ok: true, status: getStatus() };
  }

  const result = state.results[itemKey];
  console.info('[ListenNotes Downloader] background cancel item', {
    key: itemKey,
    status: result.status || '',
    taskId: result.taskId || '',
    downloadId: result.downloadId ?? null,
    hasController: Boolean(activeDownloadControllersByKey.get(itemKey) || activeDownloadControllersByTaskId.get(result.taskId)),
  });
  if (isCancellationRequested(result)) {
    return { ok: true, status: getStatus() };
  }

  clearAudioProgressNotification();
  abortDownloadController(itemKey, result.taskId);
  markDownloadCancellationRequested(state, itemKey);
  persistState();
  sendProgress();

  const cancellingResult = state.results[itemKey] || result;
  if (result.taskId || cancellingResult.taskId) {
    try {
      await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_CANCEL_FETCH',
        taskId: result.taskId || cancellingResult.taskId,
      });
    } catch {}
  }

  const latestResult = state.results[itemKey] || result;
  const downloadIds = collectDownloadIdsForCancellation(result, latestResult);

  for (const downloadId of downloadIds) {
    try {
      await chrome.downloads.cancel(downloadId);
    } catch {}
    delete state.downloadIdToKey[downloadId];
  }

  if (latestResult.blobUrl) revokeZipBlobUrl(latestResult.blobUrl);

  const {
    downloadId: _downloadId,
    taskId: _taskId,
    ...currentResult
  } = latestResult;
  state.results[itemKey] = {
    ...currentResult,
    status: CANCELLED_STATUS,
    error: 'Cancelled',
    blobUrl: '',
  };
  persistState();
  sendProgress();
  return { ok: true, status: getStatus() };
}

async function cancelZipTask() {
  const zipTaskId = activeZipTaskId || 'zip';
  activeZipTaskId = null;
  try {
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_CANCEL_ZIP',
      taskId: zipTaskId,
    });
  } catch {}

  if (state.zip?.downloadId != null) {
    try {
      await chrome.downloads.cancel(state.zip.downloadId);
    } catch {}
  }

  revokeZipBlobUrl(state.zip?.blobUrl);
  updateZip({
    status: 'cancelled',
    error: 'Cancelled',
    blobUrl: '',
  });
  return { ok: true, status: getStatus() };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg?.type) return false;

  if (msg.type === 'BG_FETCH_RSS_TEXT') {
    fetchRssText(msg.url)
      .then((text) => sendResponse({ ok: true, text }))
      .catch((error) => sendResponse({ ok: false, error: error.message || 'RSS fetch failed' }));
    return true;
  }

  if (msg.type === 'BG_OPEN_MANAGER_WINDOW') {
    openManagerWindow(msg.action)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message || 'Failed to open manager window' }));
    return true;
  }

  if (msg.type === 'BG_QUEUE_DOWNLOADS') {
    if (isZipBusy()) {
      sendResponse({ ok: false, error: 'A ZIP download task is already running', status: getStatus() });
      return true;
    }
    const generation = taskGeneration;
    const added = enqueueEpisodes(state, msg.episodes, msg.tabId);
    persistState();
    pumpQueue(generation);
    sendResponse({ ok: true, queued: added.length, status: getStatus() });
    return true;
  }

  if (msg.type === 'BG_QUEUE_ZIP_DOWNLOADS') {
    const generation = taskGeneration;
    queueZipDownloads(msg.episodes, msg.tabId, generation)
      .then((result) => sendResponse({ ...result, status: getStatus() }))
      .catch((error) => {
        if (isStaleTaskError(error)) {
          sendResponse({ ok: false, error: 'Cancelled', status: getStatus() });
          return;
        }
        logError('BG_QUEUE_ZIP_DOWNLOADS', 'ZIP download failed', error);
        if (state.zip.status === 'cancelled' || /cancelled/i.test(error.message || '')) {
          updateZip({ status: 'cancelled', error: 'Cancelled' });
          sendResponse({ ok: false, error: 'Cancelled', status: getStatus() });
          return;
        }
        const zipError = normalizeZipError(error, ZIP_BUILDER_CONNECTION_CLOSED);
        updateZip({
          status: /too large/i.test(error.message) ? 'error' : 'error',
          error: zipError,
        });
        sendResponse({ ok: false, error: zipError, status: getStatus() });
      })
      .finally(() => {
        if (activeZipTaskId === `zip:${generation}`) {
          activeZipTaskId = null;
        }
      });
    return true;
  }

  if (msg.type === 'OFFSCREEN_ZIP_PROGRESS') {
    if (!msg.taskId || msg.taskId !== activeZipTaskId) return false;
    const delta = Number(msg.delta || 0);
    const patch = {};
    if (delta > 0) patch.bytesLoaded = (state.task.bytesLoaded || 0) + delta;
    if (msg.bytesTotal == null && msg.entry && msg.current > state.zip.current) {
      patch.unknownDone = Math.min((state.task.unknownDone || 0) + 1, state.task.unknownTotal || 0);
    }
    if (Object.keys(patch).length) state.task = { ...state.task, ...patch };
    updateZip({
      status: msg.status || state.zip.status,
      current: Number.isFinite(msg.current) ? msg.current : state.zip.current,
      total: Number.isFinite(msg.total) ? msg.total : state.zip.total,
      error: msg.error || '',
    });
    return false;
  }

  if (msg.type === 'OFFSCREEN_AUDIO_PROGRESS') {
    const delta = Number(msg.delta || 0);
    const key = String(msg.key || '');
    const taskId = String(msg.taskId || '');
    const result = state.results?.[key];
    if (
      delta > 0
      && state.task?.kind === 'download'
      && key
      && taskId
      && result?.taskId === taskId
      && !isCancellationRequested(result)
    ) {
      state.task = {
        ...state.task,
        bytesLoaded: (state.task.bytesLoaded || 0) + delta,
      };
      persistState();
      sendAudioProgressSoon();
    }
    return false;
  }

  if (msg.type === 'BG_STATUS') {
    sendResponse({ ok: true, status: getStatus() });
    return true;
  }

  if (msg.type === 'BG_CANCEL_DOWNLOAD_ITEM') {
    cancelDownloadItem(msg.key)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message, status: getStatus() }));
    return true;
  }

  if (msg.type === 'BG_CANCEL_ZIP_TASK') {
    cancelZipTask()
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error.message, status: getStatus() }));
    return true;
  }

  if (msg.type === 'BG_GUESS_DEFAULT_DIR') {
    chrome.downloads.search({}, (items) => {
      try {
        const list = Array.isArray(items) ? [...items] : [];
        list.sort((a, b) => (Date.parse(b.startTime || 0) || 0) - (Date.parse(a.startTime || 0) || 0));
        if (list[0]?.filename) setDefaultDirFromFilename(list[0].filename);
      } catch (e) {
        logError('BG_GUESS_DEFAULT_DIR', 'Failed to infer default directory', e);
      }
      sendResponse({ ok: true, defaultDir: state.defaultDir });
    });
    return true;
  }

  if (msg.type === 'BG_RESET') {
    resetBackgroundState()
      .then(() => sendResponse({ ok: true, status: getStatus() }))
      .catch((error) => sendResponse({ ok: false, error: error.message, status: getStatus() }));
    return true;
  }

  return false;
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === managerWindowId) {
    managerWindowId = null;
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (delta?.filename?.current) {
    setDefaultDirFromFilename(delta.filename.current);
  }

  const normalKey = state.downloadIdToKey?.[delta?.id];
  const normalBlobUrl = normalKey ? state.results?.[normalKey]?.blobUrl : '';
  if (applyDownloadDelta(state, delta)) {
    if (normalBlobUrl) revokeZipBlobUrl(normalBlobUrl);
    cleanupResults(state);
    persistState();
    sendProgress('BG_DOWNLOAD_COMPLETE', { id: delta.id });
  }

  if (state.zip?.downloadId === delta?.id && delta.state?.current === 'complete') {
    revokeZipBlobUrl(state.zip?.blobUrl);
    updateZip({ blobUrl: '' });
  }

  if (state.zip?.downloadId === delta?.id && delta.state?.current === 'interrupted') {
    revokeZipBlobUrl(state.zip?.blobUrl);
    updateZip({ status: 'error', error: delta.error?.current || 'ZIP download interrupted', blobUrl: '' });
  }
});
