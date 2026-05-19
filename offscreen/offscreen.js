import { buildZipArchive, fetchEntryWithRetry } from './offscreen-helpers.mjs';

const activeBlobUrls = new Set();
const activeControllers = new Map();

function sendZipProgress(taskId, status, current, total, error = '', extra = {}) {
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_ZIP_PROGRESS',
    taskId,
    status,
    current,
    total,
    error,
    ...extra,
  }).catch(() => {});
}

async function buildZip(message) {
  const taskId = message.taskId || 'zip';
  const controller = new AbortController();
  activeControllers.set(taskId, controller);
  const response = await buildZipArchive(message, {
    zipFactory: () => new globalThis.JSZip(),
    sendProgress: (status, current, total, error = '', extra = {}) => {
      sendZipProgress(taskId, status, current, total, error, extra);
    },
    controller,
  });
  const blobUrl = response.blobUrl;
  activeBlobUrls.add(blobUrl);
  activeControllers.delete(taskId);
  return response;
}

async function fetchAudio(message) {
  const taskId = message.taskId;
  const controller = new AbortController();
  activeControllers.set(taskId, controller);

  try {
    const buffer = await fetchEntryWithRetry(message.entry, {
      controller,
      onProgress: (progress) => {
        chrome.runtime.sendMessage({
          type: 'OFFSCREEN_AUDIO_PROGRESS',
          taskId,
          key: message.key || '',
          loaded: progress.loaded,
          total: progress.total,
          delta: progress.delta,
        }).catch(() => {});
      },
    });
    const blob = new Blob([buffer], { type: message.mimeType || 'audio/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    activeBlobUrls.add(blobUrl);
    return {
      ok: true,
      blobUrl,
      totalBytes: buffer.byteLength,
      contentLength: buffer.byteLength,
    };
  } finally {
    activeControllers.delete(taskId);
  }
}

function cancelTask(taskId) {
  const controller = activeControllers.get(taskId);
  if (!controller) return false;
  controller.abort();
  activeControllers.delete(taskId);
  return true;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'OFFSCREEN_REVOKE_ZIP_URL') {
    if (msg.blobUrl && activeBlobUrls.has(msg.blobUrl)) {
      URL.revokeObjectURL(msg.blobUrl);
      activeBlobUrls.delete(msg.blobUrl);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (msg?.type === 'OFFSCREEN_CANCEL_FETCH' || msg?.type === 'OFFSCREEN_CANCEL_ZIP') {
    sendResponse({ ok: true, cancelled: cancelTask(msg.taskId || 'zip') });
    return true;
  }

  if (msg?.type === 'OFFSCREEN_FETCH_AUDIO') {
    fetchAudio(msg)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ ok: false, error: error.message || 'Failed to fetch audio' });
      });
    return true;
  }

  if (msg?.type !== 'OFFSCREEN_BUILD_ZIP') return false;

  buildZip(msg)
    .then(sendResponse)
    .catch((error) => {
      sendZipProgress(msg.taskId || 'zip', 'error', 0, msg.entries?.length || 0, error.message);
      sendResponse({ ok: false, error: error.message || 'Failed to build ZIP archive' });
    })
    .finally(() => {
      activeControllers.delete(msg.taskId || 'zip');
    });

  return true;
});
