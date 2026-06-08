import {
  buildTaskProgressModel,
  createEpisodeListItem,
  isListenNotesPodcastUrl,
  replaceChildrenPreservingScroll,
  shouldRenderEpisodeList,
} from './popup-helpers.mjs';
import {
  buildTranslator,
  DEFAULT_LOCALE,
  flattenChromeMessages,
  normalizeLocale,
} from './popup-i18n.mjs';
import {
  countEpisodesWithoutAudioUrl,
  DEFAULT_LIST_ORDER,
  getEpisodeKey,
  getOrderedEpisodes,
  getSelectedEpisodes,
  normalizeListOrder,
  parseSelectFirstCount,
  REVERSE_LIST_ORDER,
  selectFirstEpisodes,
} from './popup-selection.mjs';
import {
  getErrorMessage,
  stripRepeatedZipFailurePrefix,
} from './popup-errors.mjs';
import {
  buildPopupSessionState,
  buildUrlWithoutStartParam,
  parsePopupStartAction,
  POPUP_SESSION_STATE_KEY,
  restorePopupSessionState,
  shouldCloseOpenerPopupAfterManagerOpen,
} from './popup-state.mjs';

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function $(selector) {
  return document.querySelector(selector);
}

const els = {
  btnScan: $('#btn-scan'),
  btnDownload: $('#btn-download'),
  btnZipDownload: $('#btn-zip-download'),
  btnCancelTask: $('#btn-cancel-task'),
  btnReset: $('#btn-reset'),
  btnSelectFirst: $('#btn-select-first'),
  btnSelectAll: $('#btn-select-all'),
  btnClearSelection: $('#btn-clear-selection'),
  btnToggleListOrder: $('#btn-toggle-list-order'),
  info: $('#info'),
  list: $('#list'),
  count: $('#count'),
  selectedCount: $('#selectedCount'),
  selectFirstCount: $('#selectFirstCount'),
  defaultDir: $('#defaultDir'),
  scannedCount: $('#scannedCount'),
  queueCount: $('#queueCount'),
  completeCount: $('#completeCount'),
  errorCount: $('#errorCount'),
  gettingUrlCount: $('#gettingUrlCount'),
  resolvingCount: $('#resolvingCount'),
  downloadingCount: $('#downloadingCount'),
  submittedCount: $('#submittedCount'),
  activeState: $('#activeState'),
  zipStatus: $('#zipStatus'),
  taskProgress: $('#taskProgress'),
  taskProgressText: $('#taskProgressText'),
  languageSelect: $('#languageSelect'),
};

let lastEpisodes = [];
let selectedEpisodeIds = new Set();
let listOrder = DEFAULT_LIST_ORDER;
let sourceTabId = null;
let sourceUrl = '';
let currentLocale = DEFAULT_LOCALE;
let messages = {};
let t = buildTranslator(messages);
let infoKey = 'statusNotScanned';
let infoParams = {};
let latestStatus = {};

const isManagerWindow = new URLSearchParams(window.location.search).get('mode') === 'window';
document.body.classList.toggle('is-manager-window', isManagerWindow);

function getRuntimeUrl(path) {
  if (chrome.runtime?.getURL) return chrome.runtime.getURL(path);
  return path;
}

async function fetchMessages(locale) {
  const response = await fetch(getRuntimeUrl(`_locales/${locale}/messages.json`));
  if (!response.ok) {
    throw new Error(`Failed to load locale: ${locale}`);
  }
  return response.json();
}

async function getStoredLanguage() {
  try {
    const { language } = await chrome.storage.local.get(['language']);
    return language;
  } catch {
    return '';
  }
}

async function saveLanguage(locale) {
  try {
    await chrome.storage.local.set({ language: locale });
  } catch {}
}

async function setLocale(locale) {
  currentLocale = normalizeLocale(locale);
  const rawMessages = await fetchMessages(currentLocale);
  messages = flattenChromeMessages(rawMessages);
  t = buildTranslator(messages);
  document.documentElement.lang = currentLocale.replace('_', '-');
  els.languageSelect.value = currentLocale;
  applyTranslations();
}

async function initLocale() {
  const storedLanguage = await getStoredLanguage();
  const browserLanguage = chrome.i18n?.getUILanguage?.() || navigator.language;
  await setLocale(storedLanguage || browserLanguage);
}

function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });

  document.querySelectorAll('[data-i18n-aria-label]').forEach((node) => {
    node.setAttribute('aria-label', t(node.dataset.i18nAriaLabel));
  });

  renderActiveState(els.activeState.dataset.state || 'idle');

  if (els.defaultDir.dataset.emptyDir === 'true') {
    els.defaultDir.textContent = t('defaultDirUnknown');
  }

  renderListOrderToggle();
  renderList(lastEpisodes);
  renderSelectedCount();
  setInfo(infoKey, infoParams);
}

function getSelectedEpisodeList() {
  return getSelectedEpisodes(getVisibleEpisodes(), selectedEpisodeIds);
}

function getVisibleEpisodes() {
  return getOrderedEpisodes(lastEpisodes, listOrder);
}

function buildCurrentPopupState() {
  return buildPopupSessionState({
    sourceTabId,
    sourceUrl,
    episodes: lastEpisodes,
    selectedEpisodeIds,
    selectFirstCount: els.selectFirstCount.value,
    listOrder,
  });
}

async function savePopupSessionState() {
  try {
    if (!chrome.storage?.session?.set) return;
    await chrome.storage.session.set({
      [POPUP_SESSION_STATE_KEY]: buildCurrentPopupState(),
    });
  } catch (error) {
    console.warn('Failed to save popup session state:', error);
  }
}

async function clearPopupSessionState() {
  try {
    if (!chrome.storage?.session?.remove) return;
    await chrome.storage.session.remove([POPUP_SESSION_STATE_KEY]);
  } catch (error) {
    console.warn('Failed to clear popup session state:', error);
  }
}

async function restoreSavedPopupState() {
  try {
    if (!chrome.storage?.session?.get) return false;
    const stored = await chrome.storage.session.get([POPUP_SESSION_STATE_KEY]);
    const restored = restorePopupSessionState(stored?.[POPUP_SESSION_STATE_KEY]);
    if (!restored) return false;

    sourceTabId = restored.sourceTabId;
    sourceUrl = restored.sourceUrl;
    lastEpisodes = restored.episodes;
    selectedEpisodeIds = new Set(restored.selectedEpisodeIds);
    listOrder = normalizeListOrder(restored.listOrder);
    els.selectFirstCount.value = restored.selectFirstCount;
    renderListOrderToggle();
    renderList(lastEpisodes);
    setInfo('scanCompleteShort', { count: lastEpisodes.length });
    return true;
  } catch (error) {
    console.warn('Failed to restore popup session state:', error);
    return false;
  }
}

function renderSelectedCount() {
  els.selectedCount.textContent = String(getSelectedEpisodeList().length);
}

function renderListOrderToggle() {
  const isReverseOrder = listOrder === REVERSE_LIST_ORDER;
  const label = isReverseOrder
    ? t('listOrderReverseButton')
    : t('listOrderNormalButton');
  els.btnToggleListOrder.textContent = isReverseOrder ? '\u2193' : '\u2191';
  els.btnToggleListOrder.setAttribute('aria-label', label);
  els.btnToggleListOrder.setAttribute('aria-pressed', String(isReverseOrder));
  els.btnToggleListOrder.title = label;
  els.btnToggleListOrder.dataset.order = listOrder;
}

function renderList(episodes) {
  const listItems = [];
  for (const ep of getOrderedEpisodes(episodes, listOrder)) {
    const key = getEpisodeKey(ep);
    listItems.push(createEpisodeListItem(document, ep, {
      episodePageLabel: t('episodePage'),
      untitledEpisodeLabel: t('untitledEpisode'),
      selectEpisodeLabel: t('selectEpisodeLabel'),
      cancelEpisodeLabel: t('cancelEpisodeButton'),
      cancellingLabel: t('cancellingStatus'),
    }, {
      key,
      checked: selectedEpisodeIds.has(key),
      result: latestStatus.results?.[key],
    }));
  }
  replaceChildrenPreservingScroll(els.list, ...listItems);
  els.count.textContent = String(episodes.length);
  els.scannedCount.textContent = String(episodes.length);
  els.selectFirstCount.max = episodes.length ? String(episodes.length) : '';
  renderSelectedCount();
}

function setInfo(key, params = {}) {
  infoKey = key;
  infoParams = params;
  els.info.textContent = t(key, params);
}

function getZipErrorDetail(error) {
  const raw = getErrorMessage(error, t('unknownError'));
  return stripRepeatedZipFailurePrefix(raw, t('zipFailed', { error: '$error$' }));
}

function renderActiveState(state) {
  els.activeState.dataset.state = state;
  els.activeState.textContent = state === 'running' ? t('stateRunning') : t('stateIdle');
}

function renderZipStatus(status = {}) {
  const zipStatus = status.zipStatus || 'idle';
  const current = status.zipCurrent || 0;
  const total = status.zipTotal || 0;
  const error = status.zipError ? getZipErrorDetail(status.zipError) : '';

  const statusKeyByState = {
    idle: 'zipIdle',
    resolving: 'zipPreparing',
    fetching: 'zipFetching',
    generating: 'zipGenerating',
    ready: 'zipReady',
    cancelled: 'zipCancelled',
    error: error && /too large/i.test(error) ? 'zipTooLarge' : 'zipFailed',
  };
  const key = statusKeyByState[zipStatus] || 'zipIdle';
  const params = { current, total, error };

  els.zipStatus.dataset.emptyZip = zipStatus === 'idle' ? 'true' : 'false';
  els.zipStatus.textContent = t(key, params);
}

function renderTaskProgress(status = {}) {
  const model = buildTaskProgressModel(status);
  els.taskProgress.max = '100';
  els.taskProgress.value = String(model.percent);
  els.taskProgress.setAttribute('aria-valuenow', String(model.percent));
  els.taskProgressText.textContent = t(model.labelKey, model.params);

  const downloadBusy = model.kind === 'download' && model.isBusy;
  const zipBusy = model.kind === 'zip' && model.isBusy;
  els.btnDownload.disabled = zipBusy;
  els.btnZipDownload.disabled = downloadBusy;
  els.btnCancelTask.hidden = !(model.kind === 'zip' && model.isBusy);
  els.btnCancelTask.disabled = !(model.kind === 'zip' && model.isBusy);
  els.btnDownload.title = zipBusy ? t('zipTaskBusy') : '';
  els.btnZipDownload.title = downloadBusy ? t('downloadTaskBusy') : '';
}

async function pingContent(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'CONTENT_PING' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function ensureContent(tabId) {
  if (await pingContent(tabId)) return;

  await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content-helpers.js', 'src/content.js'] });
  await new Promise((resolve) => setTimeout(resolve, 200));

  if (!(await pingContent(tabId))) {
    throw new Error(t('contentScriptNoResponse'));
  }
}

async function scan() {
  try {
    const tab = await getActiveTab();
    if (!tab?.id || !isListenNotesPodcastUrl(tab.url)) {
      setInfo('wrongPage');
      return { ok: false };
    }

    await ensureContent(tab.id);
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'CONTENT_SCAN' });
    if (!response?.ok) {
      throw new Error(response?.error || t('scanScriptFailed'));
    }

    sourceTabId = tab.id;
    sourceUrl = tab.url || '';
    lastEpisodes = response.episodes || [];
    selectedEpisodeIds = new Set();
    listOrder = DEFAULT_LIST_ORDER;
    els.selectFirstCount.value = '';
    renderListOrderToggle();
    renderList(lastEpisodes);
    await savePopupSessionState();
    setInfo('scanComplete', { count: lastEpisodes.length });
    return { ok: true, episodes: lastEpisodes };
  } catch (e) {
    console.error('Scan failed:', e);
    setInfo('scanFailed', { error: e.message });
    return { ok: false, error: e.message };
  }
}

async function queueDownloads(episodes) {
  if (!sourceTabId) {
    throw new Error(t('missingSourceTab'));
  }

  const response = await chrome.runtime.sendMessage({
    type: 'BG_QUEUE_DOWNLOADS',
    tabId: sourceTabId,
    episodes,
  });

  if (!response?.ok) {
    throw new Error(response?.error || t('queueCreateFailed'));
  }

  await refreshStatus();
  return response;
}

async function queueZipDownloads(episodes) {
  if (!sourceTabId) {
    throw new Error(t('missingSourceTab'));
  }

  const response = await chrome.runtime.sendMessage({
    type: 'BG_QUEUE_ZIP_DOWNLOADS',
    tabId: sourceTabId,
    episodes,
  });

  if (!response?.ok) {
    throw new Error(response?.error || t('unknownError'));
  }

  if (response.status) renderZipStatus(response.status);
  await refreshStatus();
  return response;
}

function getEpisodeKeys() {
  return getOrderedEpisodes(lastEpisodes, listOrder).map((ep) => getEpisodeKey(ep));
}

async function refreshStatus(options = {}) {
  const {
    renderEpisodes = true,
  } = options;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BG_STATUS' });
    if (!response?.ok) return;

    const s = response.status;
    const previousStatus = latestStatus;
    latestStatus = s;
    els.queueCount.textContent = String(s.inQueue);
    els.completeCount.textContent = String(s.counts.complete);
    els.errorCount.textContent = String(s.counts.error);
    els.gettingUrlCount.textContent = String(s.counts.getting_url);
    els.resolvingCount.textContent = String(s.counts.resolving);
    els.downloadingCount.textContent = String(
      s.counts.downloading + s.counts.fetching_audio + s.counts.ready_to_save
    );
    els.submittedCount.textContent = String(s.counts.queued_in_downloads + s.counts.save_prompt);
    renderActiveState(s.active > 0 ? 'running' : 'idle');
    renderZipStatus(s);
    renderTaskProgress(s);
    if (
      renderEpisodes === true
      || (renderEpisodes === 'ifChanged' && shouldRenderEpisodeList(previousStatus, s, getEpisodeKeys()))
    ) {
      renderList(lastEpisodes);
    }

    if (s.defaultDir) {
      els.defaultDir.textContent = s.defaultDir;
      els.defaultDir.dataset.emptyDir = 'false';
    }
  } catch {}
}

async function cancelDownloadItem(key) {
  const response = await chrome.runtime.sendMessage({
    type: 'BG_CANCEL_DOWNLOAD_ITEM',
    key,
  });
  if (!response?.ok) {
    throw new Error(response?.error || t('unknownError'));
  }
  await refreshStatus();
  return response;
}

function renderOptimisticCancelling(key) {
  const itemKey = String(key || '');
  if (!itemKey) return;

  latestStatus = {
    ...latestStatus,
    results: {
      ...(latestStatus.results || {}),
      [itemKey]: {
        ...(latestStatus.results?.[itemKey] || {}),
        status: 'cancelling',
        error: 'Cancelling',
        canCancel: false,
        isCancelling: true,
      },
    },
  };
  renderList(lastEpisodes);
}

async function cancelZipTask() {
  const response = await chrome.runtime.sendMessage({ type: 'BG_CANCEL_ZIP_TASK' });
  if (!response?.ok) {
    throw new Error(response?.error || t('unknownError'));
  }
  await refreshStatus();
  return response;
}

async function initDefaultDirGuess() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'BG_GUESS_DEFAULT_DIR' });
    if (response?.ok && response.defaultDir) {
      els.defaultDir.textContent = response.defaultDir;
      els.defaultDir.dataset.emptyDir = 'false';
    }
  } catch {}
}

function getDownloadSelection() {
  if (!lastEpisodes.length) {
    setInfo('downloadNeedsScan');
    return [];
  }

  const selectedEpisodes = getSelectedEpisodeList();
  if (!selectedEpisodes.length) {
    setInfo('downloadNeedsSelection');
    return [];
  }

  const missingAudioCount = countEpisodesWithoutAudioUrl(selectedEpisodes);
  if (missingAudioCount > 0) {
    setInfo('selectedMissingAudioFallback', { count: missingAudioCount });
  }

  return selectedEpisodes;
}

async function openManagerWindow(action) {
  const selectedEpisodes = getDownloadSelection();
  if (!selectedEpisodes.length) return { ok: false };

  await savePopupSessionState();
  setInfo('openingManagerWindow');

  const response = await chrome.runtime.sendMessage({
    type: 'BG_OPEN_MANAGER_WINDOW',
    action,
  });

  if (!response?.ok) {
    throw new Error(response?.error || t('managerWindowOpenFailed'));
  }

  setInfo('managerWindowOpened');
  if (shouldCloseOpenerPopupAfterManagerOpen(response, isManagerWindow)) {
    window.close();
  }
  return response;
}

async function runDownloadFlow() {
  const selectedEpisodes = getDownloadSelection();
  if (!selectedEpisodes.length) return;

  setInfo('submittingDownloads', { count: selectedEpisodes.length });
  const response = await queueDownloads(selectedEpisodes);
  setInfo('queueAdded', { count: response.queued });
}

async function runZipFlow() {
  const selectedEpisodes = getDownloadSelection();
  if (!selectedEpisodes.length) return;

  setInfo('zipPreparing', { current: 0, total: selectedEpisodes.length });
  const response = await queueZipDownloads(selectedEpisodes);
  setInfo('zipReady', {
    current: response.resolved || selectedEpisodes.length,
    total: selectedEpisodes.length,
  });
}

async function runStartAction(action) {
  if (action === 'download') {
    await runDownloadFlow();
    return;
  }

  if (action === 'zip') {
    await runZipFlow();
  }
}

async function runRequestedAction(action) {
  if (!isManagerWindow) {
    await openManagerWindow(action);
    return;
  }

  await runStartAction(action);
}

async function consumeInitialStartAction() {
  const action = parsePopupStartAction(window.location.search);
  if (!action) return;

  window.history.replaceState(null, document.title, buildUrlWithoutStartParam(window.location.href));
  await runStartAction(action);
}

function setupListeners() {
  els.list.addEventListener('change', (event) => {
    const checkbox = event.target?.closest?.('.episode-checkbox');
    if (!checkbox) return;

    const key = checkbox.dataset.episodeId || '';
    if (!key) return;

    selectedEpisodeIds = new Set(selectedEpisodeIds);
    if (checkbox.checked) {
      selectedEpisodeIds.add(key);
    } else {
      selectedEpisodeIds.delete(key);
    }
    renderSelectedCount();
    void savePopupSessionState();
    setInfo('selectionUpdated', { count: getSelectedEpisodeList().length });
  });

  els.list.addEventListener('click', async (event) => {
    const button = event.target?.closest?.('.episode-cancel');
    if (!button) return;
    const key = button.dataset.episodeId || '';
    try {
      if (!key || !lastEpisodes.some((ep) => getEpisodeKey(ep) === key)) {
        throw new Error('Download item was not found');
      }
      const cancelStartedAt = performance.now();
      console.info('[ListenNotes Downloader] cancel click', {
        key,
        scrollTop: els.list.scrollTop,
        status: latestStatus.results?.[key]?.status || '',
        canCancel: latestStatus.results?.[key]?.canCancel ?? null,
        isCancelling: latestStatus.results?.[key]?.isCancelling ?? null,
      });
      button.disabled = true;
      setInfo('cancellingStatus');
      renderOptimisticCancelling(key);
      console.info('[ListenNotes Downloader] cancel request sent', {
        key,
        scrollTop: els.list.scrollTop,
      });
      await cancelDownloadItem(key);
      console.info('[ListenNotes Downloader] cancel complete', {
        key,
        latencyMs: Math.round(performance.now() - cancelStartedAt),
        scrollTop: els.list.scrollTop,
        status: latestStatus.results?.[key]?.status || '',
        canCancel: latestStatus.results?.[key]?.canCancel ?? null,
        isCancelling: latestStatus.results?.[key]?.isCancelling ?? null,
      });
      setInfo('cancelledStatus');
    } catch (e) {
      setInfo('downloadFailed', { error: getErrorMessage(e, t('unknownError')) });
    }
  });

  els.btnSelectFirst.addEventListener('click', () => {
    if (!lastEpisodes.length) {
      setInfo('downloadNeedsScan');
      return;
    }

    const parsed = parseSelectFirstCount(els.selectFirstCount.value, lastEpisodes.length);
    if (!parsed.ok) {
      setInfo('invalidSelectFirstCount');
      return;
    }

    selectedEpisodeIds = selectFirstEpisodes(getVisibleEpisodes(), parsed.count, selectedEpisodeIds);
    renderList(lastEpisodes);
    void savePopupSessionState();
    setInfo('selectedFirstCount', {
      count: parsed.count,
      selected: getSelectedEpisodeList().length,
    });
  });

  els.btnSelectAll.addEventListener('click', () => {
    if (!lastEpisodes.length) {
      setInfo('downloadNeedsScan');
      return;
    }

    selectedEpisodeIds = selectFirstEpisodes(getVisibleEpisodes(), lastEpisodes.length);
    renderList(lastEpisodes);
    void savePopupSessionState();
    setInfo('selectionUpdated', { count: getSelectedEpisodeList().length });
  });

  els.btnClearSelection.addEventListener('click', () => {
    selectedEpisodeIds = new Set();
    els.selectFirstCount.value = '';
    renderList(lastEpisodes);
    void savePopupSessionState();
    setInfo('selectionCleared');
  });

  els.selectFirstCount.addEventListener('input', () => {
    void savePopupSessionState();
  });

  els.btnToggleListOrder.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    listOrder = listOrder === REVERSE_LIST_ORDER ? DEFAULT_LIST_ORDER : REVERSE_LIST_ORDER;
    renderListOrderToggle();
    renderList(lastEpisodes);
    void savePopupSessionState();
  });

  els.btnScan.addEventListener('click', async () => {
    setInfo('scanInProgress');
    const result = await scan();
    if (result.ok && result.episodes?.length) {
      setInfo('scanCompleteShort', { count: result.episodes.length });
    }
  });

  els.btnDownload.addEventListener('click', async () => {
    try {
      await runRequestedAction('download');
    } catch (e) {
      console.error('Download flow failed:', e);
      setInfo('downloadFailed', { error: getErrorMessage(e, t('unknownError')) });
    }
  });

  els.btnZipDownload.addEventListener('click', async () => {
    try {
      await runRequestedAction('zip');
    } catch (e) {
      console.error('ZIP download flow failed:', e);
      const detail = getZipErrorDetail(e);
      const key = /too large/i.test(detail) ? 'zipTooLarge' : 'zipFailed';
      setInfo(key, { error: detail, current: 0, total: getSelectedEpisodeList().length });
    }
  });

  els.btnReset.addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'BG_RESET' });
    lastEpisodes = [];
    selectedEpisodeIds = new Set();
    listOrder = DEFAULT_LIST_ORDER;
    sourceTabId = null;
    sourceUrl = '';
    els.selectFirstCount.value = '';
    await clearPopupSessionState();
    renderList(lastEpisodes);
    renderListOrderToggle();
    els.queueCount.textContent = '0';
    els.selectedCount.textContent = '0';
    els.completeCount.textContent = '0';
    els.errorCount.textContent = '0';
    els.gettingUrlCount.textContent = '0';
    els.resolvingCount.textContent = '0';
    els.downloadingCount.textContent = '0';
    els.submittedCount.textContent = '0';
    renderZipStatus({ zipStatus: 'idle' });
    renderTaskProgress({});
    renderActiveState('idle');
    setInfo('resetDone');
  });

  els.btnCancelTask.addEventListener('click', async () => {
    try {
      await cancelZipTask();
      setInfo('zipCancelled');
    } catch (e) {
      setInfo('zipFailed', { error: getErrorMessage(e, t('unknownError')) });
    }
  });

  els.languageSelect.addEventListener('change', async () => {
    const locale = normalizeLocale(els.languageSelect.value);
    await saveLanguage(locale);
    await setLocale(locale);
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'BG_PROGRESS' || msg?.type === 'BG_DOWNLOAD_COMPLETE' || msg?.type === 'BG_ZIP_PROGRESS') {
      refreshStatus({
        renderEpisodes: msg?.progressOnly ? 'ifChanged' : true,
      });
    }
    if (msg?.type === 'POPUP_START_ACTION' && isManagerWindow) {
      restoreSavedPopupState()
        .then(() => refreshStatus())
        .then(() => runStartAction(msg.action))
        .catch((error) => {
        setInfo('downloadFailed', { error: getErrorMessage(error, t('unknownError')) });
      });
    }
  });
}

await initLocale();
await restoreSavedPopupState();
setupListeners();
initDefaultDirGuess();
await refreshStatus();
await consumeInitialStartAction();
