import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyDownloadDelta,
  applyReadyToSaveResult,
  CANCELLED_STATUS,
  CANCELLING_STATUS,
  cleanupResults,
  collectDownloadIdsForCancellation,
  createAbortSignalScope,
  createInitialState,
  getStatus,
  isDownloadCancellationError,
  markDownloadCancellationRequested,
} from '../src/background-helpers.mjs';

test('collectDownloadIdsForCancellation deduplicates download ids', () => {
  assert.deepEqual(
    collectDownloadIdsForCancellation(
      { downloadId: 12 },
      { downloadId: 12 },
      { downloadId: 15 },
      { downloadId: null },
      {}
    ),
    [12, 15]
  );
});

test('markDownloadCancellationRequested removes queued items and marks cancelling', () => {
  const state = createInitialState();
  state.queue = [
    { episodeId: 'episode-1' },
    { episodeId: 'episode-2' },
  ];
  state.results = {
    'episode-1': { status: 'pending' },
    'episode-2': { status: 'pending' },
  };

  const result = markDownloadCancellationRequested(state, 'episode-1');

  assert.equal(result.status, CANCELLING_STATUS);
  assert.deepEqual(state.queue, [{ episodeId: 'episode-2' }]);
  assert.equal(getStatus(state).results['episode-1'].canCancel, false);
  assert.equal(getStatus(state).results['episode-1'].isCancelling, true);
});

test('markDownloadCancellationRequested preserves active cancellation handles', () => {
  const state = createInitialState();
  state.results = {
    'episode-1': {
      status: 'fetching_audio',
      taskId: 'audio:1',
      downloadId: 42,
      blobUrl: 'blob:episode-1',
    },
  };

  markDownloadCancellationRequested(state, 'episode-1');

  assert.equal(state.results['episode-1'].status, CANCELLING_STATUS);
  assert.equal(state.results['episode-1'].taskId, 'audio:1');
  assert.equal(state.results['episode-1'].downloadId, 42);
  assert.equal(state.results['episode-1'].blobUrl, 'blob:episode-1');
});

test('markDownloadCancellationRequested is idempotent for cancelled items', () => {
  const state = createInitialState();
  state.results = {
    'episode-1': { status: CANCELLED_STATUS, error: 'Cancelled' },
  };

  const result = markDownloadCancellationRequested(state, 'episode-1');

  assert.equal(result.status, CANCELLED_STATUS);
  assert.equal(state.results['episode-1'].status, CANCELLED_STATUS);
});

test('isDownloadCancellationError recognizes fetch and browser cancellation errors', () => {
  assert.equal(isDownloadCancellationError(new Error('Operation aborted')), true);
  assert.equal(isDownloadCancellationError(new Error('BodyStreamBuffer was aborted')), true);
  assert.equal(isDownloadCancellationError(new Error('The user canceled the download')), true);
  assert.equal(isDownloadCancellationError(Object.assign(new Error('The user canceled'), {
    name: 'AbortError',
  })), true);
  assert.equal(isDownloadCancellationError(new Error('HTTP 500 Internal Server Error')), false);
});

test('applyDownloadDelta keeps cancelling download interruptions as cancelled', () => {
  const state = createInitialState();
  state.downloadIdToKey = { 42: 'episode-1' };
  state.results = {
    'episode-1': { status: CANCELLING_STATUS, downloadId: 42, blobUrl: 'blob:episode-1' },
  };

  assert.equal(applyDownloadDelta(state, {
    id: 42,
    state: { current: 'interrupted' },
    error: { current: 'NETWORK_FAILED' },
  }), true);

  assert.equal(state.results['episode-1'].status, CANCELLED_STATUS);
  assert.equal(state.results['episode-1'].error, 'Cancelled');
  assert.equal(state.results['episode-1'].blobUrl, '');
  assert.deepEqual(state.downloadIdToKey, {});
});

test('applyDownloadDelta treats Chrome USER_CANCELED as cancelled', () => {
  const state = createInitialState();
  state.downloadIdToKey = { 42: 'episode-1' };
  state.results = {
    'episode-1': { status: 'save_prompt', downloadId: 42, blobUrl: 'blob:episode-1' },
  };

  applyDownloadDelta(state, {
    id: 42,
    state: { current: 'interrupted' },
    error: { current: 'USER_CANCELED' },
  });

  assert.equal(state.results['episode-1'].status, CANCELLED_STATUS);
});

test('applyDownloadDelta keeps a completed cancelling item cancelled', () => {
  const state = createInitialState();
  state.downloadIdToKey = { 42: 'episode-1' };
  state.results = {
    'episode-1': { status: CANCELLING_STATUS, downloadId: 42, blobUrl: 'blob:episode-1' },
  };

  applyDownloadDelta(state, {
    id: 42,
    state: { current: 'complete' },
  });

  assert.equal(state.results['episode-1'].status, CANCELLED_STATUS);
});

test('applyReadyToSaveResult refuses to overwrite a cancelling item', () => {
  const state = createInitialState();
  state.results = {
    'episode-1': { status: CANCELLING_STATUS },
  };

  assert.equal(applyReadyToSaveResult(state, 'episode-1', { blobUrl: 'blob:episode-1' }), false);
  assert.equal(state.results['episode-1'].status, CANCELLING_STATUS);
  assert.equal(state.results['episode-1'].blobUrl, undefined);
});

test('applyReadyToSaveResult refuses to revive a cancelled item', () => {
  const state = createInitialState();
  state.results = {
    'episode-1': { status: CANCELLED_STATUS, error: 'Cancelled' },
  };

  assert.equal(applyReadyToSaveResult(state, 'episode-1', { blobUrl: 'blob:episode-1' }), false);
  assert.equal(state.results['episode-1'].status, CANCELLED_STATUS);
  assert.equal(state.results['episode-1'].blobUrl, undefined);
});

test('cleanupResults preserves cancelling items while pruning terminal history', () => {
  const state = createInitialState();
  state.maxResultsSize = 2;
  state.results = {
    'episode-cancelling': { status: CANCELLING_STATUS, taskId: 'audio:1' },
    'episode-complete': { status: 'complete' },
    'episode-error': { status: 'error' },
    'episode-cancelled': { status: CANCELLED_STATUS },
  };

  cleanupResults(state);

  assert.equal(state.results['episode-cancelling'].status, CANCELLING_STATUS);
});

test('createAbortSignalScope aborts from an external user signal without timing out', () => {
  let timeoutCallback;
  let clearedTimeout = false;
  const userController = new AbortController();
  const scope = createAbortSignalScope({
    signal: userController.signal,
    timeoutMs: 1000,
    setTimeoutFn: (callback) => {
      timeoutCallback = callback;
      return 7;
    },
    clearTimeoutFn: (id) => {
      if (id === 7) clearedTimeout = true;
    },
  });

  userController.abort();
  assert.equal(scope.signal.aborted, true);
  assert.notEqual(scope.signal.reason?.name, 'TimeoutError');

  scope.cleanup();
  assert.equal(clearedTimeout, true);
  timeoutCallback();
  assert.notEqual(scope.signal.reason?.name, 'TimeoutError');
});

test('createAbortSignalScope timeout abort is idempotent', () => {
  let timeoutCallback;
  const scope = createAbortSignalScope({
    timeoutMs: 250,
    setTimeoutFn: (callback) => {
      timeoutCallback = callback;
      return 9;
    },
    clearTimeoutFn: () => {},
  });

  timeoutCallback();
  const firstReason = scope.signal.reason;
  timeoutCallback();

  assert.equal(scope.signal.aborted, true);
  assert.equal(firstReason.name, 'TimeoutError');
  assert.equal(scope.signal.reason, firstReason);
});
