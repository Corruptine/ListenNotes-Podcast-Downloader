export function isListenNotesPodcastUrl(url) {
  return /^https?:\/\/(www\.)?listennotes\.com\/podcasts\//i.test(String(url || ''));
}

function normalizeSafeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
  } catch {
    return '';
  }
}

function normalizeCount(value) {
  return Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
}

export function formatBytes(bytes) {
  const value = normalizeCount(bytes);
  if (value < 1024) return `${Math.round(value)} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const precision = size >= 10 ? 1 : 2;
  return `${Number(size.toFixed(precision))} ${units[unitIndex]}`;
}

export function buildTaskProgressModel(status = {}) {
  const kind = status.taskKind || 'idle';
  const rawTotal = normalizeCount(status.taskTotal);
  const total = Math.floor(rawTotal);
  const current = Math.min(total, Math.floor(normalizeCount(status.taskCurrent)));
  const bytesLoaded = normalizeCount(status.taskBytesLoaded);
  const bytesTotal = normalizeCount(status.taskBytesTotal);
  const unknownTotal = Math.floor(normalizeCount(status.taskUnknownTotal));
  const unknownDone = Math.min(unknownTotal, Math.floor(normalizeCount(status.taskUnknownDone)));
  const knownItemCount = Math.max(0, total - unknownTotal);
  const fallbackBytes = bytesTotal > 0 && knownItemCount > 0 ? bytesTotal / knownItemCount : 1024 * 1024;
  const effectiveTotal = bytesTotal + (unknownTotal * fallbackBytes);
  const effectiveLoaded = bytesLoaded + (unknownDone * fallbackBytes);
  let percent = effectiveTotal > 0
    ? Math.round((Math.min(effectiveLoaded, effectiveTotal) / effectiveTotal) * 100)
    : (total > 0 ? Math.round((current / total) * 100) : 0);
  const taskStatus = status.taskStatus || (kind === 'idle' ? 'idle' : 'running');
  let labelKey = 'taskProgressIdle';

  if (kind === 'idle') {
    return {
      kind,
      status: 'idle',
      current: 0,
      total: 0,
      percent: 0,
      labelKey,
      params: { current: 0, total: 0, percent: 0 },
      isBusy: false,
    };
  }

  if (total > 0 && current >= total && !['running', 'resolving', 'fetching', 'generating', 'saving'].includes(taskStatus)) {
    percent = 100;
  }

  if (taskStatus === 'error') {
    labelKey = 'taskProgressError';
  } else if (total > 0 && current >= total && !['resolving', 'fetching', 'generating'].includes(taskStatus)) {
    labelKey = 'taskProgressComplete';
  } else if (unknownTotal > 0) {
    labelKey = kind === 'zip' ? 'taskProgressZipUnknown' : 'taskProgressDownloadUnknown';
  } else if (kind === 'download') {
    labelKey = 'taskProgressDownload';
  } else if (kind === 'zip') {
    labelKey = 'taskProgressZip';
  }

  return {
    kind,
    status: taskStatus,
    current,
    total,
    percent,
    labelKey,
    params: {
      current,
      total,
      percent,
      loaded: formatBytes(Math.min(effectiveLoaded || bytesLoaded, effectiveTotal || bytesLoaded)),
      bytesTotal: formatBytes(effectiveTotal || bytesTotal),
      unknown: unknownTotal,
    },
    isBusy: ['running', 'resolving', 'fetching', 'generating', 'saving'].includes(taskStatus),
  };
}

export function createEpisodeListItem(documentRef, ep, labels = {}, options = {}) {
  const li = documentRef.createElement('li');
  const item = documentRef.createElement('div');
  const title = documentRef.createElement('div');
  const link = documentRef.createElement('a');
  const cancelButton = documentRef.createElement('button');
  const checkbox = documentRef.createElement('input');
  const text = ep?.title || ep?.episodeId || labels.untitledEpisodeLabel || 'Untitled episode';
  const key = options.key || ep?.episodeId || ep?.uuid || ep?.audioUrl || '';

  item.className = 'item';
  checkbox.type = 'checkbox';
  checkbox.className = 'episode-checkbox';
  checkbox.checked = Boolean(options.checked);
  checkbox.setAttribute('aria-label', `${labels.selectEpisodeLabel || 'Select episode'}: ${text}`);
  if (key) checkbox.dataset.episodeId = key;

  title.className = 'episode-title title';
  title.title = text;
  title.textContent = text;

  const safeHref = normalizeSafeHttpUrl(ep?.pageUrl || ep?.episodeId || '');
  if (safeHref) {
    link.href = safeHref;
  } else {
    link.href = '#';
    link.setAttribute('aria-disabled', 'true');
  }

  link.target = '_blank';
  link.rel = 'noreferrer';
  link.className = 'episode-link';
  link.textContent = labels.episodePageLabel || 'episode page';

  item.append(checkbox, title, link);
  if (options.result?.canCancel) {
    cancelButton.type = 'button';
    cancelButton.className = 'episode-cancel';
    cancelButton.dataset.episodeId = key;
    cancelButton.textContent = '×';
    cancelButton.setAttribute('aria-label', `${labels.cancelEpisodeLabel || 'Cancel'}: ${text}`);
    item.appendChild(cancelButton);
  }
  li.appendChild(item);
  return li;
}
