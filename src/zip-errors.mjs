export const ZIP_BUILDER_CONNECTION_CLOSED = 'ZIP builder connection closed. Try again or use regular download.';
export const ZIP_AUDIO_CONNECTION_CLOSED = 'audio host connection closed or rejected ZIP fetch. Try regular download.';
export const ZIP_ALL_AUDIO_FETCH_FAILED = 'All selected audio files failed to fetch for ZIP. Try regular download.';

export function normalizeZipError(error, fallback = 'Unknown error') {
  const raw = typeof error === 'string' ? error : error?.message;
  const message = String(raw || '').trim();

  if (!message) return fallback;
  if (/receiving end does not exist|message port closed|message port closed before a response|extension context invalidated|zip builder connection closed/i.test(message)) {
    return ZIP_BUILDER_CONNECTION_CLOSED;
  }
  if (/failed to fetch|networkerror|err_connection_closed|connection closed|load failed|aborterror|aborted/i.test(message)) {
    return ZIP_AUDIO_CONNECTION_CLOSED;
  }

  return message;
}

export function formatEntryFetchError(entry, error) {
  const title = entry?.title || entry?.name || 'Untitled episode';
  return `${title}: ${normalizeZipError(error, ZIP_AUDIO_CONNECTION_CLOSED)}`;
}

export function assertZipBuildResponse(response) {
  if (!response?.ok) {
    throw new Error(normalizeZipError(response?.error, ZIP_BUILDER_CONNECTION_CLOSED));
  }

  return response;
}
