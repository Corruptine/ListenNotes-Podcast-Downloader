import {
  formatEntryFetchError,
  normalizeZipError,
  ZIP_ALL_AUDIO_FETCH_FAILED,
} from '../src/zip-errors.mjs';

export const ZIP_COMPRESSION = 'STORE';
export const DEFAULT_FETCH_TIMEOUT_MS = 30000;
export const DEFAULT_RETRY_COUNT = 2;
const ABORTED_MESSAGE = 'Operation aborted';

export function assertTotalSize(totalBytes, maxBytes) {
  if (Number(totalBytes || 0) > Number(maxBytes || 0)) {
    throw new Error(`ZIP source payload is too large. Limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
}

export function buildErrorsText(errors) {
  if (!errors.length) return '';

  return errors
    .map((item, index) => `${index + 1}. ${item.title || 'Untitled episode'}\n${item.error || 'Unknown error'}`)
    .join('\n\n');
}

function isAbortError(error, controller) {
  return Boolean(controller?.signal?.aborted || error?.name === 'AbortError');
}

function assertNotAborted(controller) {
  if (controller?.signal?.aborted) {
    throw new Error(ABORTED_MESSAGE);
  }
}

async function readResponseBuffer(response, onProgress = () => {}, controller) {
  const totalHeader = Number(response.headers?.get?.('content-length'));
  const total = Number.isFinite(totalHeader) && totalHeader >= 0 ? totalHeader : null;

  if (!response.body?.getReader) {
    assertNotAborted(controller);
    const buffer = await response.arrayBuffer();
    assertNotAborted(controller);
    onProgress({ loaded: buffer.byteLength, total, delta: buffer.byteLength });
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;

  try {
    while (true) {
      assertNotAborted(controller);
      const { done, value } = await reader.read();
      assertNotAborted(controller);
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      chunks.push(chunk);
      loaded += chunk.byteLength;
      onProgress({ loaded, total, delta: chunk.byteLength });
      assertNotAborted(controller);
    }
  } catch (error) {
    if (isAbortError(error, controller) || /aborted/i.test(error.message || '')) {
      try {
        await reader.cancel(error);
      } catch {}
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  const result = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

export async function fetchEntry(entry, deps = {}) {
  const {
    fetchFn = fetch,
    timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
    controller = new AbortController(),
    onProgress = () => {},
  } = deps;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    assertNotAborted(controller);
    const response = await fetchFn(entry.url, {
      credentials: 'omit',
      redirect: 'follow',
      signal: controller.signal,
    });
    assertNotAborted(controller);

    if (!response?.ok) {
      throw new Error(`HTTP ${response?.status || 0} ${response?.statusText || ''}`.trim());
    }

    return readResponseBuffer(response, onProgress, controller);
  } catch (error) {
    if (isAbortError(error, controller)) {
      throw new Error(ABORTED_MESSAGE);
    }
    throw new Error(formatEntryFetchError(entry, error));
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function fetchEntryWithRetry(entry, deps = {}) {
  const {
    controller,
    retryCount = DEFAULT_RETRY_COUNT,
    retryDelayMs = 250,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = deps;
  let lastError;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      assertNotAborted(controller);
      return await fetchEntry(entry, deps);
    } catch (error) {
      lastError = error;
      if (isAbortError(error, controller) || /aborted/i.test(error.message || '')) break;
      if (attempt >= retryCount) break;
      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  throw lastError;
}

export async function buildZipArchive(params = {}, deps = {}) {
  const {
    entries = [],
    errors = [],
    filename = 'ListenNotes.zip',
    maxBytes,
  } = params;
  const {
    zipFactory,
    createObjectURL = URL.createObjectURL.bind(URL),
    sendProgress = () => {},
    controller = new AbortController(),
  } = deps;
  const zip = zipFactory();
  const failed = [...errors];
  let totalBytes = 0;
  let successCount = 0;

  for (const [index, entry] of entries.entries()) {
    try {
      assertNotAborted(controller);
      sendProgress('fetching', index, entries.length, '');
      const buffer = await fetchEntryWithRetry(entry, {
        ...deps,
        controller,
        onProgress: (progress) => {
          sendProgress('fetching', index, entries.length, '', {
            entry,
            loaded: progress.loaded,
            bytesTotal: progress.total,
            delta: progress.delta,
          });
        },
      });
      totalBytes += buffer.byteLength;
      assertTotalSize(totalBytes, maxBytes);
      zip.file(entry.name, buffer, {
        binary: true,
        compression: ZIP_COMPRESSION,
      });
      successCount += 1;
      if (!Number.isFinite(Number(entry.contentLength))) {
        sendProgress('fetching', index + 1, entries.length, '', {
          entry,
          loaded: buffer.byteLength,
          bytesTotal: null,
          delta: 0,
        });
      }
    } catch (error) {
      if (isAbortError(error, controller) || /aborted/i.test(error.message || '')) {
        throw error;
      }
      if (/too large/i.test(error.message || '')) {
        throw error;
      }

      const normalized = normalizeZipError(error, error.message || 'Unknown error');
      failed.push({
        title: entry.title || entry.name,
        error: normalized,
      });
      sendProgress('fetching', index + 1, entries.length, normalized);
    }
  }

  if (entries.length > 0 && successCount === 0) {
    throw new Error(ZIP_ALL_AUDIO_FETCH_FAILED);
  }

  const errorText = buildErrorsText(failed);
  if (errorText) {
    zip.file('errors.txt', errorText);
  }

  sendProgress('generating', entries.length, entries.length, '');
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: ZIP_COMPRESSION,
  });

  return {
    ok: true,
    blobUrl: createObjectURL(blob),
    filename,
    failed: failed.length,
    totalBytes,
  };
}
