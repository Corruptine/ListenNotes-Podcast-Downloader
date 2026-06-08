import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchEntry, fetchEntryWithRetry } from '../offscreen/offscreen-helpers.mjs';

test('fetchEntry stops reading a response stream when aborted during progress', async () => {
  const controller = new AbortController();
  let progressCount = 0;
  const chunks = [
    new Uint8Array([1, 2, 3]),
    new Uint8Array([4, 5, 6]),
  ];

  const body = new ReadableStream({
    pull(streamController) {
      const chunk = chunks.shift();
      if (chunk) {
        streamController.enqueue(chunk);
      } else {
        streamController.close();
      }
    },
  });

  await assert.rejects(
    fetchEntry(
      { url: 'https://example.com/audio.mp3', name: 'audio.mp3' },
      {
        controller,
        fetchFn: async () => ({
          ok: true,
          status: 200,
          statusText: 'OK',
          headers: new Headers({ 'content-length': '6' }),
          body,
        }),
        onProgress: () => {
          progressCount += 1;
          controller.abort();
        },
      }
    ),
    /Operation aborted/
  );

  assert.equal(progressCount, 1);
});

test('fetchEntryWithRetry does not retry after user abort', async () => {
  const controller = new AbortController();
  let attempts = 0;

  await assert.rejects(
    fetchEntryWithRetry(
      { url: 'https://example.com/audio.mp3', name: 'audio.mp3' },
      {
        controller,
        retryCount: 2,
        fetchFn: async () => {
          attempts += 1;
          controller.abort();
          throw Object.assign(new Error('Operation aborted'), { name: 'AbortError' });
        },
        sleep: async () => {
          throw new Error('sleep should not run after abort');
        },
      }
    ),
    /Operation aborted/
  );

  assert.equal(attempts, 1);
});
